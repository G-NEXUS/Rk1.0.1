require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');
const media = require('./cloudinary');

const app = express();
const PORT = Number(process.env.PORT) || 3000;
const HOST = '0.0.0.0';
const ROOT_DIR = __dirname;
const AUTH_SECRET = process.env.AUTH_SECRET || crypto.createHash('sha256').update(process.env.MONGODB_URI || 'rk-connekt-dev-secret').digest('hex');
const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const RAW_UPSTREAM = process.env.UPSTREAM_API_URL !== undefined
  ? String(process.env.UPSTREAM_API_URL).trim()
  : 'https://rk-ogzw.onrender.com';
const UPSTREAM_API_URL = RAW_UPSTREAM && RAW_UPSTREAM.toLowerCase() !== 'none'
  ? RAW_UPSTREAM.replace(/\/+$/, '')
  : '';
const UPSTREAM_TIMEOUT_MS = process.env.VERCEL ? 18000 : 45000;

const DEFAULT_ADMIN_EMAIL = 'choolwechingobe2@gmail.com';
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || DEFAULT_ADMIN_EMAIL).trim().toLowerCase();
const GOOGLE_CLIENT_ID = String(process.env.GOOGLE_CLIENT_ID || '').trim();
const tokenCache = new Map();

const BLOCKED_FILES = new Set([
  '/server.js',
  '/db.js',
  '/cloudinary.js',
  '/api/index.js',
  '/vercel.json',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/pasted_content.txt',
  '/README.md',
]);

app.use(express.json({ limit: '25mb' }));

// Ensure MongoDB connection attempt settles once per serverless/server lifecycle
app.use('/api', async (req, res, next) => {
  await db.ensureDBConnected();
  return next();
});

// Lightweight gzip compression for JSON & text responses
app.use((req, res, next) => {
  const acceptEncoding = String(req.headers['accept-encoding'] || '');
  if (!acceptEncoding.includes('gzip') || req.path.includes('/photo/')) {
    return next();
  }
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const raw = Buffer.from(JSON.stringify(body), 'utf8');
    if (raw.length < 1024) {
      return origJson(body);
    }
    zlib.gzip(raw, (err, compressed) => {
      if (err || res.headersSent) {
        return origJson(body);
      }
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', String(compressed.length));
      res.end(compressed);
    });
    return res;
  };
  return next();
});

const UPSTREAM_CATALOG_TTL_MS = 30 * 1000;
let upstreamCatalogCache = {
  products: null,
  categories: null,
  fetchedAt: 0,
  inflight: null,
};

function invalidateCatalogCache() {
  upstreamCatalogCache.fetchedAt = 0;
  upstreamCatalogCache.products = null;
  upstreamCatalogCache.categories = null;
}

function useUpstreamProxy() {
  return !db.isMongoReady() && Boolean(UPSTREAM_API_URL);
}

async function fetchUpstream(apiPath, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    return await fetch(`${UPSTREAM_API_URL}${apiPath}`, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Stateless HMAC Auth Tokens (Direct MongoDB / Local Mode) ----------
function signToken(uid) {
  const payload = Buffer.from(
    JSON.stringify({ uid, exp: Date.now() + TOKEN_TTL_MS })
  ).toString('base64url');
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  if (!payload || !sig) return null;
  const expected = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data?.uid || typeof data.exp !== 'number' || data.exp < Date.now()) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

async function resolveUserFromRequest(req) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) return null;

  // 1. Check local HMAC token
  const decoded = verifyToken(token);
  if (decoded?.uid) {
    const localUser = await db.findUserByUid(decoded.uid);
    if (localUser) {
      const pub = db.publicUser(localUser);
      if (pub.email && pub.email.toLowerCase() === ADMIN_EMAIL) {
        pub.isAdmin = true;
      }
      return pub;
    }
  }

  // 2. Check token cache (for upstream tokens)
  const cached = tokenCache.get(token);
  if (cached && cached.exp > Date.now()) {
    return cached.user;
  }

  // 3. If upstream proxy is active, verify token via upstream /api/auth/me
  if (useUpstreamProxy()) {
    try {
      const meRes = await fetchUpstream('/api/auth/me', {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (meRes.ok) {
        const meData = await meRes.json().catch(() => ({}));
        if (meData?.user) {
          const user = { ...meData.user };
          if (user.email && user.email.toLowerCase() === ADMIN_EMAIL) {
            user.isAdmin = true;
          }
          tokenCache.set(token, { user, exp: Date.now() + 30 * 60 * 1000 });
          db.recordKnownUsers([user]);
          return user;
        }
      }
    } catch (err) {
      console.log('[Upstream Token Check] Using cached/local auth:', err.message);
    }
  }

  return null;
}

async function mergeUpstreamWithLocalProducts(upstreamProducts) {
  const localProducts = await db.listProducts();
  const deletedSet = new Set(db.listDeletedProductIds().map(String));
  const byId = new Map();
  for (const prod of Array.isArray(upstreamProducts) ? upstreamProducts : []) {
    const key = String(prod?.id ?? '');
    if (!key || deletedSet.has(key)) continue;
    byId.set(key, prod);
  }
  for (const prod of localProducts) {
    const key = String(prod?.id ?? '');
    if (!key || deletedSet.has(key)) continue;
    byId.set(key, prod);
  }
  return [...byId.values()];
}

function mergeSubcategoriesMaps(upMap, localMap) {
  const merged = {};
  for (const src of [upMap, localMap]) {
    if (!src || typeof src !== 'object' || Array.isArray(src)) continue;
    for (const [cat, list] of Object.entries(src)) {
      if (!Array.isArray(list)) continue;
      if (!merged[cat]) merged[cat] = [];
      for (const sub of list) {
        const clean = String(sub || '').trim();
        if (clean && !merged[cat].some((item) => item.toLowerCase() === clean.toLowerCase())) {
          merged[cat].push(clean);
        }
      }
    }
  }
  return merged;
}

async function mergeUpstreamWithLocalCategories(upstreamCatData) {
  const localMeta = await db.getCategoriesMeta();
  const upList = Array.isArray(upstreamCatData?.categories) ? upstreamCatData.categories : [];
  const upSizes = Array.isArray(upstreamCatData?.sizeCategories) ? upstreamCatData.sizeCategories : [];
  const upColors = Array.isArray(upstreamCatData?.colorCategories) ? upstreamCatData.colorCategories : [];
  const upSubs = upstreamCatData?.subcategories && typeof upstreamCatData.subcategories === 'object'
    ? upstreamCatData.subcategories
    : {};
  const mergedSubs = Object.keys(localMeta.subcategories || {}).length > 0
    ? { ...upSubs, ...localMeta.subcategories }
    : mergeSubcategoriesMaps(upSubs, localMeta.subcategories);
  if (localMeta.list.length > 0) {
    return {
      categories: [...new Set([...upList, ...localMeta.list])],
      sizeCategories: [...new Set([...upSizes, ...localMeta.sizeCategories])],
      colorCategories: [...new Set([...upColors, ...localMeta.colorCategories])],
      subcategories: mergedSubs,
    };
  }
  return {
    categories: upList,
    sizeCategories: upSizes,
    colorCategories: upColors,
    subcategories: mergedSubs,
  };
}

async function getCachedUpstreamCatalog(forceRefresh = false) {
  const fresh = !forceRefresh
    && upstreamCatalogCache.products
    && upstreamCatalogCache.categories
    && (Date.now() - upstreamCatalogCache.fetchedAt) < UPSTREAM_CATALOG_TTL_MS;
  if (fresh) {
    return {
      products: upstreamCatalogCache.products,
      categories: upstreamCatalogCache.categories,
    };
  }
  if (!forceRefresh && upstreamCatalogCache.inflight) {
    return upstreamCatalogCache.inflight;
  }
  const job = (async () => {
    const [prodRes, catRes] = await Promise.all([
      fetchUpstream('/api/products'),
      fetchUpstream('/api/categories'),
    ]);
    if (!prodRes.ok || !catRes.ok) {
      throw new Error(`Upstream catalog status ${prodRes.status}/${catRes.status}`);
    }
    const [prodData, catData] = await Promise.all([prodRes.json(), catRes.json()]);
    upstreamCatalogCache.products = Array.isArray(prodData.products) ? prodData.products : [];
    upstreamCatalogCache.categories = catData || {};
    upstreamCatalogCache.fetchedAt = Date.now();
    return {
      products: upstreamCatalogCache.products,
      categories: upstreamCatalogCache.categories,
    };
  })().finally(() => {
    upstreamCatalogCache.inflight = null;
  });
  upstreamCatalogCache.inflight = job;
  return job;
}

async function loadAllRawProducts() {
  if (!useUpstreamProxy()) {
    return db.listProducts();
  }
  try {
    const { products: upProducts } = await getCachedUpstreamCatalog();
    return mergeUpstreamWithLocalProducts(upProducts);
  } catch {
    return db.listProducts();
  }
}

// ---------- Binary Cached Product Photo Endpoint (fast browser-cached images) ----------
app.get('/api/products/:id/photo/:index', async (req, res, next) => {
  try {
    const productId = decodeURIComponent(String(req.params.id || ''));
    const index = Number.parseInt(req.params.index, 10);
    const versionHash = String(req.query.v || '').trim();
    if (!productId || !Number.isInteger(index) || index < 0) {
      return res.status(400).send('Invalid photo request');
    }
    let photo = media.getCachedPhoto(productId, index, versionHash);
    if (!photo) {
      const rawProducts = await loadAllRawProducts();
      media.registerProductsList(rawProducts);
      photo = media.getCachedPhoto(productId, index, versionHash);
    }
    if (!photo) {
      return res.status(404).send('Photo not found');
    }
    const etag = `"photo-${photo.hash}"`;
    res.setHeader('Content-Type', photo.mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
    return res.send(photo.buffer);
  } catch (err) {
    return next(err);
  }
});

// ---------- Health & Auth Provider Discovery ----------
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    dbConnected: db.isMongoReady(),
    mode: db.isMongoReady() ? 'mongodb' : (useUpstreamProxy() ? 'upstream' : 'local'),
  });
});

app.get('/api/auth/providers', (req, res) => {
  res.json({
    googleEnabled: Boolean(GOOGLE_CLIENT_ID),
    googleClientId: GOOGLE_CLIENT_ID || '',
  });
});

app.post('/api/auth/google', async (req, res, next) => {
  try {
    if (!GOOGLE_CLIENT_ID) {
      return res.status(503).json({ error: 'Google Sign-In is not configured on this server yet.' });
    }
    const credential = String(req.body?.credential || '').trim();
    if (!credential) {
      return res.status(400).json({ error: 'Missing Google sign-in token.' });
    }
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`);
    const payload = await verifyRes.json().catch(() => ({}));
    if (!verifyRes.ok || payload.aud !== GOOGLE_CLIENT_ID || !payload.email) {
      return res.status(401).json({ error: 'Google sign-in could not be verified. Please try again.' });
    }
    if (String(payload.email_verified) !== 'true') {
      return res.status(401).json({ error: 'Please use a verified Google account email.' });
    }
    const email = String(payload.email).trim().toLowerCase();
    const name = String(payload.name || payload.given_name || email.split('@')[0]).trim();
    let user = await db.findUserByEmail(email);
    if (!user) {
      const randomHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10);
      const isAdmin = Boolean(ADMIN_EMAIL && email === ADMIN_EMAIL);
      user = await db.createUser({ name, email, passwordHash: randomHash, isAdmin });
    }
    const token = signToken(user.uid);
    return res.json({ token, user: db.publicUser(user) });
  } catch (err) {
    return next(err);
  }
});

// ---------- Admin Media Status & Cloudinary Migration ----------
app.get('/api/admin/media-status', async (req, res, next) => {
  try {
    const user = await resolveUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    const rawProducts = await loadAllRawProducts();
    return res.json({
      cloudinaryConfigured: media.isCloudinaryConfigured(),
      cloudName: media.getCloudinaryCloudName(),
      legacyPhotoCount: media.countLegacyPhotos(rawProducts),
    });
  } catch (err) {
    return next(err);
  }
});

app.post('/api/admin/migrate-photos', async (req, res, next) => {
  try {
    const user = await resolveUserFromRequest(req);
    if (!user) return res.status(401).json({ error: 'Authentication required.' });
    if (!user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
    if (!media.isCloudinaryConfigured()) {
      return res.status(400).json({
        error: 'Set CLOUDINARY_URL with your real API key and secret in environment variables first.',
      });
    }
    const rawProducts = await loadAllRawProducts();
    let migratedProducts = 0;
    let uploadedPhotos = 0;
    const authHeader = req.headers.authorization || '';

    for (const prod of rawProducts) {
      const hasLegacy = media.isDataImageUri(prod?.image)
        || (Array.isArray(prod?.gallery) && prod.gallery.some(media.isDataImageUri));
      if (!hasLegacy) continue;

      const beforeCount = media.countLegacyPhotos([prod]);
      const updatedBody = await media.prepareProductPhotosForSave(prod.id, prod);
      const afterCount = media.countLegacyPhotos([updatedBody]);
      const uploadedForProduct = Math.max(0, beforeCount - afterCount);
      if (uploadedForProduct === 0) continue;

      let savedUpstream = false;
      if (useUpstreamProxy()) {
        try {
          const upRes = await fetchUpstream(`/api/admin/products/${encodeURIComponent(String(prod.id))}`, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              ...(authHeader ? { Authorization: authHeader } : {}),
            },
            body: JSON.stringify(updatedBody),
          });
          if (upRes.ok) savedUpstream = true;
        } catch {
          // Fall through to local store override
        }
      }
      if (!savedUpstream) {
        await db.saveProduct(prod.id, updatedBody);
      } else {
        await db.deleteProduct(prod.id).catch(() => {});
      }
      migratedProducts++;
      uploadedPhotos += uploadedForProduct;
    }

    invalidateCatalogCache();
    const freshProducts = await loadAllRawProducts();
    return res.json({
      migratedProducts,
      uploadedPhotos,
      remainingLegacy: media.countLegacyPhotos(freshProducts),
    });
  } catch (err) {
    return next(err);
  }
});

// ---------- Upstream Proxy Middleware (when MONGODB_URI is not directly reachable) ----------
app.use('/api', async (req, res, next) => {
  if (req.path.startsWith('/did-you-know') || req.path.startsWith('/admin/did-you-know')) {
    return next();
  }
  if (!useUpstreamProxy()) return next();

  try {
    // Storefront visit counter (handled locally when upstream does not provide analytics)
    if (req.method === 'POST' && req.path === '/analytics/visit') {
      const stats = await db.recordSiteVisit(req.body?.visitorId);
      return res.json({ ok: true, ...stats });
    }

    // Admin overview stats (registered users + website visitors)
    if (req.method === 'GET' && req.path === '/admin/stats') {
      const authHeader = req.headers.authorization || '';
      if (!authHeader) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const u = await resolveUserFromRequest(req);
      if (!u) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      if (!u.isAdmin) {
        return res.status(403).json({ error: 'Admin access required.' });
      }

      const extraUsers = [u];
      try {
        const upstreamStatsRes = await fetchUpstream('/api/admin/stats', {
          method: 'GET',
          headers: { Authorization: authHeader },
        });
        const upstreamType = upstreamStatsRes.headers.get('content-type') || '';
        if (upstreamStatsRes.ok && upstreamType.includes('application/json')) {
          const upstreamStats = await upstreamStatsRes.json();
          if (typeof upstreamStats?.registeredUsers === 'number') {
            const localStats = await db.getAdminStats({ extraUsers });
            return res.json({
              registeredUsers: upstreamStats.registeredUsers,
              websiteVisitors: Math.max(Number(upstreamStats.websiteVisitors) || 0, localStats.websiteVisitors),
              totalViews: Math.max(Number(upstreamStats.totalViews) || 0, localStats.totalViews),
            });
          }
        }
      } catch {
        // Upstream does not expose /api/admin/stats yet; fall through to local aggregation
      }

      try {
        const ordersRes = await fetchUpstream('/api/orders', {
          method: 'GET',
          headers: { Authorization: authHeader },
        });
        if (ordersRes.ok) {
          const ordersData = await ordersRes.json().catch(() => ({}));
          if (Array.isArray(ordersData.orders)) {
            for (const ord of ordersData.orders) {
              if (ord?.email || ord?.uid) extraUsers.push({ uid: ord.uid, email: ord.email });
            }
          }
        }
      } catch {
        // Ignore transient order lookup issues for stats
      }

      const stats = await db.getAdminStats({ extraUsers });
      return res.json(stats);
    }

    // Convenience aggregate endpoint supported alongside /api/products & /api/categories
    if (req.method === 'GET' && req.path === '/store') {
      try {
        const { products: upProducts, categories: catData } = await getCachedUpstreamCatalog();
        const products = media.registerProductsList(await mergeUpstreamWithLocalProducts(upProducts));
        const mergedCats = await mergeUpstreamWithLocalCategories(catData);
        return res.json({
          products,
          categories: mergedCats.categories,
          sizeCategories: mergedCats.sizeCategories,
          colorCategories: mergedCats.colorCategories,
          subcategories: mergedCats.subcategories || {},
        });
      } catch (err) {
        console.log('[Storefront Sync] Upstream unavailable, checking local fallback:', err.message);
      }

      const [localProducts, localMeta] = await Promise.all([
        db.listProducts(),
        db.getCategoriesMeta(),
      ]);
      if (!localProducts.length && !localMeta.list.length) {
        return res.status(503).json({
          code: 'store/backend-unavailable',
          error: 'Could not reach database or upstream store API. Check MONGODB_URI and Atlas Network Access (0.0.0.0/0).',
        });
      }
      return res.json({
        products: media.registerProductsList(localProducts),
        categories: localMeta.list,
        sizeCategories: localMeta.sizeCategories,
        colorCategories: localMeta.colorCategories,
        subcategories: localMeta.subcategories || {},
      });
    }

    // Merge local fallback products on /api/products as well
    if (req.method === 'GET' && req.path === '/products') {
      try {
        const { products: upProducts } = await getCachedUpstreamCatalog();
        const products = media.registerProductsList(await mergeUpstreamWithLocalProducts(upProducts));
        return res.json({ products });
      } catch (err) {
        console.log('[Products Sync] Upstream unavailable, checking local fallback:', err.message);
      }
      const localProducts = await db.listProducts();
      if (!localProducts.length) {
        return res.status(503).json({
          code: 'store/backend-unavailable',
          error: 'Could not reach database or upstream store API.',
        });
      }
      return res.json({ products: media.registerProductsList(localProducts) });
    }

    // Resilient product save (PUT /api/admin/products/:id or /api/products/:id)
    const productWriteMatch = req.path.match(/^\/(?:admin\/)?products\/([^/]+)\/?$/);
    if (productWriteMatch && (req.method === 'PUT' || req.method === 'DELETE')) {
      const productId = decodeURIComponent(productWriteMatch[1]);
      const headers = {};
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      if (req.method === 'PUT') headers['Content-Type'] = 'application/json';

      const preparedBody = req.method === 'PUT'
        ? await media.prepareProductPhotosForSave(productId, req.body || {}, { loadRawProducts: loadAllRawProducts })
        : undefined;

      try {
        const upstreamRes = await fetchUpstream(req.originalUrl, {
          method: req.method,
          headers,
          body: req.method === 'PUT' ? JSON.stringify(preparedBody) : undefined,
        });
        const contentType = upstreamRes.headers.get('content-type') || 'application/json';
        const text = await upstreamRes.text();
        if (upstreamRes.ok) {
          invalidateCatalogCache();
          if (req.method === 'PUT') {
            db.unmarkProductDeleted(productId);
            const wantedPromo = preparedBody && preparedBody.promoPrice !== undefined && preparedBody.promoPrice !== null && preparedBody.promoPrice !== ''
              ? Number(preparedBody.promoPrice)
              : undefined;
            const wantedSubcategory = preparedBody && typeof preparedBody.subcategory === 'string' && preparedBody.subcategory.trim()
              ? preparedBody.subcategory.trim()
              : '';
            let parsedUpstream = null;
            try {
              parsedUpstream = JSON.parse(text);
            } catch {
              parsedUpstream = null;
            }
            const returnedPromo = parsedUpstream?.product?.promoPrice;
            const returnedSubcategory = String(parsedUpstream?.product?.subcategory || '').trim();
            const needsLocalOverlay = (wantedPromo !== undefined && (returnedPromo === undefined || Number(returnedPromo) !== wantedPromo))
              || (wantedSubcategory && returnedSubcategory !== wantedSubcategory);
            if (needsLocalOverlay) {
              const mergedProduct = { ...(parsedUpstream?.product || preparedBody || {}) };
              if (wantedPromo !== undefined) mergedProduct.promoPrice = wantedPromo;
              if (wantedSubcategory) mergedProduct.subcategory = wantedSubcategory;
              const savedLocal = await db.saveProduct(productId, mergedProduct);
              return res.json({ product: media.registerProductPhotos(savedLocal) });
            }
            await db.deleteProduct(productId).catch(() => {});
            if (parsedUpstream?.product) {
              return res.json({ ...parsedUpstream, product: media.registerProductPhotos(parsedUpstream.product) });
            }
          } else {
            await db.deleteProduct(productId).catch(() => {});
            db.unmarkProductDeleted(productId);
          }
          return res.status(upstreamRes.status).type(contentType).send(text);
        }
        console.log('[Product Write] Upstream returned', upstreamRes.status, 'for', req.method, productId, '— using local fallback store.');
      } catch (err) {
        console.log('[Product Write] Upstream unreachable, using local fallback store:', err.message);
      }

      // Fallback to local store when verified as admin
      const user = await resolveUserFromRequest(req);
      if (!user) {
        return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
      }
      if (!user.isAdmin) {
        return res.status(403).json({ error: 'Admin access required.' });
      }
      invalidateCatalogCache();
      if (req.method === 'PUT') {
        const product = await db.saveProduct(productId, preparedBody || {});
        return res.json({ product: media.registerProductPhotos(product) });
      }
      await db.deleteProduct(productId);
      db.markProductDeleted(productId);
      return res.json({ ok: true });
    }

    // Resilient category save (PUT /api/admin/categories or /api/categories)
    if (req.method === 'PUT' && (req.path === '/admin/categories' || req.path === '/categories')) {
      const headers = { 'Content-Type': 'application/json' };
      if (req.headers.authorization) headers.Authorization = req.headers.authorization;
      const requestedSubs = req.body?.subcategories && typeof req.body.subcategories === 'object'
        ? req.body.subcategories
        : {};
      try {
        const upstreamRes = await fetchUpstream(req.originalUrl, {
          method: 'PUT',
          headers,
          body: JSON.stringify(req.body || {}),
        });
        const contentType = upstreamRes.headers.get('content-type') || 'application/json';
        const text = await upstreamRes.text();
        if (upstreamRes.ok) {
          invalidateCatalogCache();
          let parsed = null;
          try { parsed = JSON.parse(text); } catch { parsed = null; }
          const savedLocal = await db.saveCategoriesMeta({
            list: parsed?.categories || req.body?.list,
            sizeCategories: parsed?.sizeCategories || req.body?.sizeCategories,
            colorCategories: parsed?.colorCategories || req.body?.colorCategories,
            subcategories: requestedSubs,
          });
          return res.json({
            categories: savedLocal.list,
            sizeCategories: savedLocal.sizeCategories,
            colorCategories: savedLocal.colorCategories,
            subcategories: savedLocal.subcategories || {},
          });
        }
        console.log('[Category Save] Upstream returned', upstreamRes.status, '— using local fallback store.');
      } catch (err) {
        console.log('[Category Save] Upstream unreachable, using local fallback store:', err.message);
      }
      const user = await resolveUserFromRequest(req);
      if (!user) return res.status(401).json({ error: 'Your session expired. Please sign in again.' });
      if (!user.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
      invalidateCatalogCache();
      const saved = await db.saveCategoriesMeta({
        list: req.body?.list,
        sizeCategories: req.body?.sizeCategories,
        colorCategories: req.body?.colorCategories,
        subcategories: requestedSubs,
      });
      return res.json({
        categories: saved.list,
        sizeCategories: saved.sizeCategories,
        colorCategories: saved.colorCategories,
        subcategories: saved.subcategories || {},
      });
    }

    const headers = {};
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    if (req.headers['content-type']) headers['Content-Type'] = req.headers['content-type'];

    const init = {
      method: req.method,
      headers,
    };

    if (!['GET', 'HEAD'].includes(req.method) && req.body !== undefined) {
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }

    const upstreamRes = await fetchUpstream(req.originalUrl, init);
    const contentType = upstreamRes.headers.get('content-type') || 'application/json';
    const text = await upstreamRes.text();

    if (upstreamRes.ok && contentType.includes('application/json') && ['/auth/login', '/auth/register', '/auth/me'].includes(req.path)) {
      try {
        const parsed = JSON.parse(text);
        let modified = false;
        if (parsed?.user) {
          if (parsed.user.email && parsed.user.email.toLowerCase() === ADMIN_EMAIL) {
            parsed.user.isAdmin = true;
            modified = true;
          }
          db.recordKnownUsers([parsed.user]);
        }
        const authTok = parsed?.token || (req.headers.authorization ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : '');
        if (authTok && parsed?.user) {
          tokenCache.set(authTok, { user: parsed.user, exp: Date.now() + 24 * 60 * 60 * 1000 });
        }
        if (modified) {
          return res.status(upstreamRes.status).type(contentType).send(JSON.stringify(parsed));
        }
      } catch {
        // Ignore parse errors
      }
    }

    res.status(upstreamRes.status).type(contentType).send(text);
  } catch (err) {
    console.warn('[Upstream Proxy Error]', req.method, req.originalUrl, err.message);
    return res.status(503).json({
      code: 'auth/database-unavailable',
      error: 'The backend server is waking up or temporarily unreachable. Please try again in a moment.',
    });
  }
});

async function attachUser(req, res, next) {
  try {
    const user = await resolveUserFromRequest(req);
    if (user) req.user = user;
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required.' });
  }
  if (!req.user.isAdmin) {
    return res.status(403).json({ error: 'Admin access required.' });
  }
  return next();
}

app.use('/api', attachUser);

// ---------- Public Storefront Data ----------

app.get('/api/store', async (req, res, next) => {
  try {
    const [products, meta] = await Promise.all([
      db.listProducts(),
      db.getCategoriesMeta(),
    ]);
    res.json({
      products: media.registerProductsList(products),
      categories: meta.list,
      sizeCategories: meta.sizeCategories,
      colorCategories: meta.colorCategories,
      subcategories: meta.subcategories || {},
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/products', async (req, res, next) => {
  try {
    const products = await db.listProducts();
    res.json({ products: media.registerProductsList(products) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/categories', async (req, res, next) => {
  try {
    const meta = await db.getCategoriesMeta();
    res.json({
      categories: meta.list,
      sizeCategories: meta.sizeCategories,
      colorCategories: meta.colorCategories,
      subcategories: meta.subcategories || {},
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Authentication ----------
app.post('/api/auth/register', async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!name) {
      return res.status(400).json({ code: 'auth/missing-name', error: 'Full name is required.' });
    }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ code: 'auth/invalid-email', error: 'Invalid email address.' });
    }
    if (password.length < 6) {
      return res.status(400).json({ code: 'auth/weak-password', error: 'Password must be at least 6 characters.' });
    }

    const existing = await db.findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ code: 'auth/email-already-in-use', error: 'Email already registered.' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const isAdmin = Boolean(ADMIN_EMAIL && email === ADMIN_EMAIL);

    const created = await db.createUser({
      name,
      email,
      passwordHash,
      isAdmin,
    });

    res.status(201).json({ user: db.publicUser(created) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ code: 'auth/email-already-in-use', error: 'Email already registered.' });
    }
    next(err);
  }
});

app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');

    if (!email || !password) {
      return res.status(400).json({ code: 'auth/invalid-credential', error: 'Invalid email or password.' });
    }

    const user = await db.findUserByEmail(email);
    if (!user) {
      return res.status(401).json({ code: 'auth/invalid-credential', error: 'Invalid email or password.' });
    }
    if (!user.passwordHash) {
      return res.status(403).json({
        code: 'auth/password-reset-required',
        error: 'This account needs a password reset before logging in.',
      });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ code: 'auth/invalid-credential', error: 'Invalid email or password.' });
    }

    const token = signToken(user.uid);
    res.json({ token, user: db.publicUser(user) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: req.user || null });
});

app.post('/api/auth/logout', (req, res) => {
  res.json({ ok: true });
});

app.post('/api/auth/forgot-password', async (req, res, next) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (email) {
      const user = await db.findUserByEmail(email);
      if (user) {
        const reset = await db.createPasswordReset(user);
        const appUrl = (process.env.PUBLIC_APP_URL || '').replace(/\/+$/, '');
        const resetUrl = `${appUrl}/#/reset-password?token=${reset.rawToken}`;
        console.warn(`Password reset link for ${email}: ${resetUrl}`);
      }
    }
    res.json({
      ok: true,
      message: 'If an account exists for this email, a password reset link has been created.',
    });
  } catch (err) {
    next(err);
  }
});

app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const token = String(req.body?.token || '').trim();
    const password = String(req.body?.password || '');
    if (password.length < 6) {
      return res.status(400).json({ code: 'auth/weak-password', error: 'Password must be at least 6 characters.' });
    }
    if (!token) {
      return res.status(400).json({
        code: 'auth/invalid-reset-token',
        error: 'This reset link is invalid or has expired. Request a new one.',
      });
    }
    const passwordHash = await bcrypt.hash(password, 12);
    const updated = await db.consumePasswordReset(token, passwordHash);
    if (!updated) {
      return res.status(400).json({
        code: 'auth/invalid-reset-token',
        error: 'This reset link is invalid or has expired. Request a new one.',
      });
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/profile', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    const updated = await db.updateUserName(req.user.uid, name);
    if (!updated) {
      return res.status(404).json({ error: 'Account not found.' });
    }
    res.json({ user: db.publicUser(updated) });
  } catch (err) {
    next(err);
  }
});

app.get('/api/users/me', requireAuth, (req, res) => {
  res.json({ user: req.user || null });
});

app.patch('/api/users/me', requireAuth, async (req, res, next) => {
  try {
    const name = String(req.body?.name || '').trim();
    await db.updateUserName(req.user.uid, name);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Products (Admin writes) ----------
async function handleSaveProduct(req, res, next) {
  try {
    const prepared = await media.prepareProductPhotosForSave(req.params.id, req.body || {}, {
      loadRawProducts: () => db.listProducts(),
    });
    const product = await db.saveProduct(req.params.id, prepared);
    res.json({ product: media.registerProductPhotos(product) });
  } catch (err) {
    next(err);
  }
}

async function handleDeleteProduct(req, res, next) {
  try {
    await db.deleteProduct(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

app.put('/api/admin/products/:id', requireAdmin, handleSaveProduct);
app.put('/api/products/:id', requireAdmin, handleSaveProduct);
app.delete('/api/admin/products/:id', requireAdmin, handleDeleteProduct);
app.delete('/api/products/:id', requireAdmin, handleDeleteProduct);

// ---------- Categories (Admin writes) ----------
async function handleSaveCategories(req, res, next) {
  try {
    const saved = await db.saveCategoriesMeta({
      list: req.body?.list,
      sizeCategories: req.body?.sizeCategories,
      colorCategories: req.body?.colorCategories,
      subcategories: req.body?.subcategories,
    });
    res.json({
      categories: saved.list,
      sizeCategories: saved.sizeCategories,
      colorCategories: saved.colorCategories,
      subcategories: saved.subcategories || {},
    });
  } catch (err) {
    next(err);
  }
}

app.put('/api/admin/categories', requireAdmin, handleSaveCategories);
app.put('/api/categories', requireAdmin, handleSaveCategories);

// ---------- Orders ----------
app.get('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const orders = await db.listOrders(req.user);
    res.json({ orders });
  } catch (err) {
    next(err);
  }
});

app.post('/api/orders', requireAuth, async (req, res, next) => {
  try {
    const body = req.body || {};
    const order = await db.createOrder({
      ...body,
      id: body.id || `ORD-${Date.now()}`,
      uid: req.user.uid,
      customer: body.customer || req.user.name || 'WhatsApp customer',
      email: body.email || req.user.email || '',
      createdAtMs: Number(body.createdAtMs) || Date.now(),
    });
    res.status(201).json({ order });
  } catch (err) {
    next(err);
  }
});

async function handleUpdateOrder(req, res, next) {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const reportedAtMs = Number(req.body?.reportedAtMs) || Date.now();
    const order = await db.updateOrderItems(req.params.id, items, reportedAtMs);
    if (!order) {
      return res.status(404).json({ error: 'Order not found.' });
    }
    res.json({ ok: true, order });
  } catch (err) {
    next(err);
  }
}

app.put('/api/orders/:id', requireAdmin, handleUpdateOrder);
app.patch('/api/orders/:id', requireAdmin, handleUpdateOrder);

// ---------- Contact Messages ----------
app.post('/api/messages', async (req, res, next) => {
  try {
    const body = req.body || {};
    const message = await db.createMessage({
      id: body.id || `MSG-${Date.now()}`,
      name: String(body.name || '').trim(),
      email: String(body.email || '').trim(),
      subject: String(body.subject || '').trim(),
      message: String(body.message || '').trim(),
      createdAtMs: Number(body.createdAtMs) || Date.now(),
      read: false,
      uid: req.user?.uid || null,
    });
    res.status(201).json({ message });
  } catch (err) {
    next(err);
  }
});

app.get('/api/messages', requireAdmin, async (req, res, next) => {
  try {
    const messages = await db.listMessages();
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});

app.patch('/api/messages/:id', requireAdmin, async (req, res, next) => {
  try {
    const message = await db.updateMessageRead(req.params.id, Boolean(req.body?.read));
    if (!message) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    res.json({ ok: true, message });
  } catch (err) {
    next(err);
  }
});

app.delete('/api/messages/:id', requireAdmin, async (req, res, next) => {
  try {
    await db.deleteMessage(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ---------- Analytics & Admin Stats ----------
app.post('/api/analytics/visit', async (req, res, next) => {
  try {
    const stats = await db.recordSiteVisit(req.body?.visitorId);
    res.json({ ok: true, ...stats });
  } catch (err) {
    next(err);
  }
});

app.get('/api/admin/stats', requireAdmin, async (req, res, next) => {
  try {
    const stats = await db.getAdminStats();
    res.json(stats);
  } catch (err) {
    next(err);
  }
});

// ---------- Did You Know Cards ----------
app.get('/api/did-you-know', async (req, res, next) => {
  try {
    const items = await db.listDidYouKnow();
    res.json({ didYouKnow: items });
  } catch (err) {
    next(err);
  }
});

async function handleSaveDidYouKnow(req, res, next) {
  try {
    const item = await db.saveDidYouKnow(req.params.id, req.body || {});
    res.json({ item });
  } catch (err) {
    next(err);
  }
}

async function handleDeleteDidYouKnow(req, res, next) {
  try {
    await db.deleteDidYouKnow(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
}

app.put('/api/admin/did-you-know/:id', requireAdmin, handleSaveDidYouKnow);
app.put('/api/did-you-know/:id', requireAdmin, handleSaveDidYouKnow);
app.delete('/api/admin/did-you-know/:id', requireAdmin, handleDeleteDidYouKnow);
app.delete('/api/did-you-know/:id', requireAdmin, handleDeleteDidYouKnow);

// Return JSON 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// API error handler
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api')) {
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      return res.status(413).json({ error: 'Product photos are too large to upload at once. Try fewer or smaller photos.' });
    }
    if (err?.status === 400 && err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'Invalid request payload.' });
    }
    console.error('[API Error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
  return next(err);
});

// ---------- Static Storefront Serving ----------
const STATIC_ASSET_EXT_RE = /\.(?:css|js|mjs|map|json|png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|eot)$/i;

app.use((req, res, next) => {
  const reqPath = req.path;
  if (reqPath.startsWith('/.') || BLOCKED_FILES.has(reqPath)) {
    return res.status(404).send('Not found');
  }
  return next();
});

app.get('/styles.css', (req, res) => {
  res.type('text/css; charset=utf-8');
  res.sendFile(path.join(ROOT_DIR, 'styles.css'));
});

app.get('/common.js', (req, res) => {
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(ROOT_DIR, 'common.js'));
});

app.use(express.static(ROOT_DIR, { extensions: ['html'] }));
app.use(express.static(path.join(ROOT_DIR, 'public')));

app.use((req, res) => {
  if (STATIC_ASSET_EXT_RE.test(req.path)) {
    return res.status(404).send('Not found');
  }
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

if (require.main === module && !process.env.VERCEL) {
  db.ensureDBConnected().finally(() => {
    if (useUpstreamProxy()) {
      console.log(`[API Proxy] Forwarding /api/* to ${UPSTREAM_API_URL}`);
    }
    app.listen(PORT, HOST, () => {
      console.log(`RK CONNEKT server listening on http://${HOST}:${PORT}`);
    });
  });
}

module.exports = app;
