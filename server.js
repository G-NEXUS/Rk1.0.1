require('dotenv').config();
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('./db');

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
const UPSTREAM_TIMEOUT_MS = 45000;

const BLOCKED_FILES = new Set([
  '/server.js',
  '/db.js',
  '/package.json',
  '/package-lock.json',
  '/metadata.json',
  '/pasted_content.txt',
  '/README.md',
]);

app.use(express.json({ limit: '5mb' }));

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

// ---------- Upstream Proxy Middleware (when MONGODB_URI is not directly reachable) ----------
app.use('/api', async (req, res, next) => {
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
      const meRes = await fetchUpstream('/api/auth/me', {
        method: 'GET',
        headers: { Authorization: authHeader },
      });
      if (!meRes.ok) {
        return res.status(401).json({ error: 'Authentication required.' });
      }
      const meData = await meRes.json().catch(() => ({}));
      if (!meData?.user?.isAdmin) {
        return res.status(403).json({ error: 'Admin access required.' });
      }

      const extraUsers = [meData.user];
      // Check if upstream already exposes /api/admin/stats; otherwise combine local analytics with known users
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
      const [prodRes, catRes] = await Promise.all([
        fetchUpstream('/api/products'),
        fetchUpstream('/api/categories'),
      ]);
      if (!prodRes.ok || !catRes.ok) {
        return res.status(502).json({ error: 'Upstream store API unavailable.' });
      }
      const [prodData, catData] = await Promise.all([prodRes.json(), catRes.json()]);
      return res.json({
        products: Array.isArray(prodData.products) ? prodData.products : [],
        categories: Array.isArray(catData.categories) ? catData.categories : [],
        sizeCategories: Array.isArray(catData.sizeCategories) ? catData.sizeCategories : [],
        colorCategories: Array.isArray(catData.colorCategories) ? catData.colorCategories : [],
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
        if (parsed?.user) db.recordKnownUsers([parsed.user]);
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

async function attachUser(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const decoded = verifyToken(token);
    if (decoded?.uid) {
      const user = await db.findUserByUid(decoded.uid);
      if (user) req.user = db.publicUser(user);
    }
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

// ---------- Health & Public Storefront Data ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true });
});

app.get('/api/store', async (req, res, next) => {
  try {
    const [products, meta] = await Promise.all([
      db.listProducts(),
      db.getCategoriesMeta(),
    ]);
    res.json({
      products,
      categories: meta.list,
      sizeCategories: meta.sizeCategories,
      colorCategories: meta.colorCategories,
    });
  } catch (err) {
    next(err);
  }
});

app.get('/api/products', async (req, res, next) => {
  try {
    const products = await db.listProducts();
    res.json({ products });
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
    const adminEmail = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
    const isAdmin = Boolean(adminEmail && email === adminEmail);

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
    const product = await db.saveProduct(req.params.id, req.body || {});
    res.json({ product });
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
    });
    res.json({
      categories: saved.list,
      sizeCategories: saved.sizeCategories,
      colorCategories: saved.colorCategories,
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

// Return JSON 404 for unknown API routes
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API route not found.' });
});

// API error handler
app.use((err, req, res, next) => {
  if (req.path.startsWith('/api')) {
    console.error('[API Error]', err);
    return res.status(500).json({ error: 'Internal server error.' });
  }
  return next(err);
});

// ---------- Static Storefront Serving ----------
app.use((req, res, next) => {
  const reqPath = req.path;
  if (reqPath.startsWith('/.') || BLOCKED_FILES.has(reqPath)) {
    return res.status(404).send('Not found');
  }
  return next();
});

app.use(express.static(ROOT_DIR, { extensions: ['html'] }));

app.use((req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'index.html'));
});

db.connectDB().finally(() => {
  if (useUpstreamProxy()) {
    console.log(`[API Proxy] Forwarding /api/* to ${UPSTREAM_API_URL}`);
  }
  app.listen(PORT, HOST, () => {
    console.log(`RK CONNEKT server listening on http://${HOST}:${PORT}`);
  });
});
