const crypto = require('crypto');

const DATA_IMAGE_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/;
const PROXY_PHOTO_RE = /^\/api\/products\/([^/]+)\/photo\/(\d+)(?:\?.*)?$/;

const photoCacheByKey = new Map();
const photoCacheByHash = new Map();

function isPlaceholder(value) {
  const str = String(value || '').trim();
  if (!str) return true;
  if (str.includes('<') || str.includes('>')) return true;
  const lower = str.toLowerCase();
  return lower.includes('your_api_key') || lower.includes('your_api_secret') || lower === 'changeme';
}

function getCloudinaryConfig() {
  const folder = String(process.env.CLOUDINARY_FOLDER || 'rk-connekt/products').trim() || 'rk-connekt/products';
  const rawUrl = String(process.env.CLOUDINARY_URL || '')
    .trim()
    .replace(/^CLOUDINARY_URL\s*=\s*/i, '')
    .trim()
    .replace(/^['"]|['"]$/g, '');
  if (rawUrl) {
    const match = rawUrl.match(/^cloudinary:\/\/([^:]+):([^@]+)@([^/\s]+)$/i);
    if (match) {
      const apiKey = decodeURIComponent(match[1].trim());
      const apiSecret = decodeURIComponent(match[2].trim());
      const cloudName = decodeURIComponent(match[3].trim());
      if (!isPlaceholder(apiKey) && !isPlaceholder(apiSecret) && !isPlaceholder(cloudName)) {
        return { cloudName, apiKey, apiSecret, folder };
      }
    }
  }

  const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
  const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
  if (!isPlaceholder(cloudName) && !isPlaceholder(apiKey) && !isPlaceholder(apiSecret)) {
    return { cloudName, apiKey, apiSecret, folder };
  }

  return null;
}

function isCloudinaryConfigured() {
  return Boolean(getCloudinaryConfig());
}

function getCloudinaryCloudName() {
  const cfg = getCloudinaryConfig();
  if (cfg) return cfg.cloudName;
  const rawUrl = String(process.env.CLOUDINARY_URL || '').trim();
  const atIdx = rawUrl.lastIndexOf('@');
  if (atIdx !== -1) return rawUrl.slice(atIdx + 1).trim();
  return String(process.env.CLOUDINARY_CLOUD_NAME || 'guhey5ib').trim();
}

function isDataImageUri(value) {
  return typeof value === 'string' && DATA_IMAGE_RE.test(value);
}

function isProxyPhotoUrl(value) {
  return typeof value === 'string' && PROXY_PHOTO_RE.test(value);
}

function decodeDataImageUri(dataUri) {
  const match = String(dataUri || '').match(DATA_IMAGE_RE);
  if (!match) return null;
  const mime = match[1];
  const base64 = match[2];
  const buffer = Buffer.from(base64, 'base64');
  const hash = crypto.createHash('sha1').update(buffer).digest('hex').slice(0, 12);
  return { mime, buffer, hash, dataUri };
}

function cachePhoto(productId, index, dataUri) {
  const decoded = decodeDataImageUri(dataUri);
  if (!decoded) return null;
  const key = `${String(productId)}:${Number(index)}`;
  photoCacheByKey.set(key, decoded);
  photoCacheByHash.set(decoded.hash, decoded);
  return decoded;
}

function registerProductPhotos(product) {
  if (!product || typeof product !== 'object') return product;
  const productId = String(product.id ?? product._id ?? '');
  if (!productId) return product;

  let nextImage = product.image || '';
  if (isDataImageUri(nextImage)) {
    const entry = cachePhoto(productId, 0, nextImage);
    if (entry) {
      nextImage = `/api/products/${encodeURIComponent(productId)}/photo/0?v=${entry.hash}`;
    }
  }

  const rawGallery = Array.isArray(product.gallery) ? product.gallery : [];
  const nextGallery = rawGallery.map((src, i) => {
    if (isDataImageUri(src)) {
      const entry = cachePhoto(productId, i + 1, src);
      if (entry) {
        return `/api/products/${encodeURIComponent(productId)}/photo/${i + 1}?v=${entry.hash}`;
      }
    }
    return src;
  });

  return {
    ...product,
    image: nextImage,
    gallery: nextGallery,
  };
}

function registerProductsList(products) {
  if (!Array.isArray(products)) return [];
  return products.map(registerProductPhotos);
}

function getCachedPhoto(productId, index, versionHash = '') {
  if (versionHash && photoCacheByHash.has(versionHash)) {
    return photoCacheByHash.get(versionHash);
  }
  const key = `${String(productId)}:${Number(index)}`;
  return photoCacheByKey.get(key) || null;
}

function resolveOriginalPhotoUri(src) {
  if (typeof src !== 'string') return src;
  const match = src.match(PROXY_PHOTO_RE);
  if (!match) return src;
  const productId = decodeURIComponent(match[1]);
  const index = Number(match[2]);
  let versionHash = '';
  const qIdx = src.indexOf('?');
  if (qIdx !== -1) {
    const params = new URLSearchParams(src.slice(qIdx + 1));
    versionHash = params.get('v') || '';
  }
  const cached = getCachedPhoto(productId, index, versionHash);
  return cached ? cached.dataUri : src;
}

function optimizeCloudinaryUrl(url) {
  if (typeof url !== 'string' || !url.includes('/image/upload/')) return url;
  if (url.includes('/image/upload/f_auto')) return url;
  return url.replace('/image/upload/', '/image/upload/f_auto,q_auto,w_900,c_limit/');
}

async function uploadDataUriToCloudinary(dataUri, { publicId } = {}) {
  const cfg = getCloudinaryConfig();
  if (!cfg) {
    throw new Error('Cloudinary is not configured.');
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const signParams = {
    folder: cfg.folder,
    overwrite: 'true',
    timestamp: String(timestamp),
  };
  if (publicId) {
    signParams.public_id = String(publicId).replace(/[^a-zA-Z0-9_-]/g, '_');
  }
  const toSign = Object.keys(signParams)
    .sort()
    .map((k) => `${k}=${signParams[k]}`)
    .join('&');
  const signature = crypto
    .createHash('sha1')
    .update(toSign + cfg.apiSecret)
    .digest('hex');

  const form = new URLSearchParams();
  form.set('file', dataUri);
  form.set('api_key', cfg.apiKey);
  form.set('timestamp', signParams.timestamp);
  form.set('folder', signParams.folder);
  form.set('overwrite', 'true');
  if (signParams.public_id) form.set('public_id', signParams.public_id);
  form.set('signature', signature);

  const endpoint = `https://api.cloudinary.com/v1_1/${encodeURIComponent(cfg.cloudName)}/image/upload`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.secure_url) {
      throw new Error(data?.error?.message || `Cloudinary upload failed (${res.status})`);
    }
    return optimizeCloudinaryUrl(data.secure_url);
  } finally {
    clearTimeout(timer);
  }
}

async function prepareProductPhotosForSave(productId, payload, { loadRawProducts } = {}) {
  if (!payload || typeof payload !== 'object') return payload;
  const rawList = [payload.image, ...(Array.isArray(payload.gallery) ? payload.gallery : [])].filter(Boolean);
  if (!rawList.length) return payload;

  // If any proxy photo URLs are missing from memory cache (e.g. cold restart), warm cache once
  if (rawList.some(isProxyPhotoUrl)) {
    const missingAny = rawList.some((src) => isProxyPhotoUrl(src) && resolveOriginalPhotoUri(src) === src);
    if (missingAny && typeof loadRawProducts === 'function') {
      const allRaw = await loadRawProducts().catch(() => []);
      registerProductsList(allRaw);
    }
  }

  const cloudinaryReady = isCloudinaryConfigured();
  const processed = [];

  for (let i = 0; i < rawList.length; i++) {
    let src = resolveOriginalPhotoUri(rawList[i]);
    if (cloudinaryReady && isDataImageUri(src)) {
      const decoded = decodeDataImageUri(src);
      const pubId = `prod_${String(productId)}_${i}_${decoded ? decoded.hash.slice(0, 8) : Date.now()}`;
      try {
        src = await uploadDataUriToCloudinary(src, { publicId: pubId });
      } catch (err) {
        console.log('[Cloudinary Upload Fallback]', productId, i, err.message);
      }
    }
    processed.push(src);
  }

  return {
    ...payload,
    image: processed[0] || '',
    gallery: processed.slice(1),
  };
}

function countLegacyPhotos(products) {
  let count = 0;
  for (const p of Array.isArray(products) ? products : []) {
    if (isDataImageUri(p?.image)) count++;
    for (const g of Array.isArray(p?.gallery) ? p.gallery : []) {
      if (isDataImageUri(g)) count++;
    }
  }
  return count;
}

module.exports = {
  isCloudinaryConfigured,
  getCloudinaryCloudName,
  isDataImageUri,
  isProxyPhotoUrl,
  registerProductPhotos,
  registerProductsList,
  getCachedPhoto,
  resolveOriginalPhotoUri,
  uploadDataUriToCloudinary,
  prepareProductPhotosForSave,
  countLegacyPhotos,
};
