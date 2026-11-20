const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');

const LOCAL_STORE_PATH = process.env.VERCEL
  ? path.join(os.tmpdir(), 'rk-connekt-store.json')
  : path.join(__dirname, '.local-dev-store.json');

mongoose.set('bufferCommands', false);

const ProductSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.Mixed, index: true },
    name: String,
    price: Number,
    promoPrice: Number,
    bulkPrice: Number,
    bulkMinQty: Number,
    image: String,
    gallery: [String],
    category: String,
    subcategory: String,
    description: String,
    options: mongoose.Schema.Types.Mixed,
    sku: String,
    createdAtMs: Number,
  },
  { strict: false, versionKey: false, collection: 'products' }
);

const MetaSchema = new mongoose.Schema(
  {
    _id: { type: String },
    key: String,
    list: [String],
    sizeCategories: [String],
    colorCategories: [String],
    variantCategories: [String],
    subcategories: mongoose.Schema.Types.Mixed,
  },
  { strict: false, versionKey: false, collection: 'meta' }
);

const UserSchema = new mongoose.Schema(
  {
    uid: { type: String, unique: true, sparse: true, index: true },
    name: { type: String, default: '' },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    isAdmin: { type: Boolean, default: false },
    createdAtMs: { type: Number, default: () => Date.now() },
  },
  { strict: false, versionKey: false, collection: 'users' }
);

const OrderSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true },
    date: String,
    items: [mongoose.Schema.Types.Mixed],
    total: Number,
    status: String,
    customer: String,
    email: String,
    address: String,
    city: String,
    zip: String,
    uid: { type: String, index: true },
    createdAtMs: { type: Number, index: true },
    reportedAtMs: Number,
  },
  { strict: false, versionKey: false, collection: 'orders' }
);

const MessageSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true },
    name: String,
    email: String,
    subject: String,
    message: String,
    createdAtMs: { type: Number, index: true },
    read: { type: Boolean, default: false },
    uid: String,
  },
  { strict: false, versionKey: false, collection: 'messages' }
);

const PasswordResetSchema = new mongoose.Schema(
  {
    uid: { type: String, index: true },
    email: { type: String, lowercase: true, trim: true, index: true },
    tokenHash: { type: String, index: true },
    used: { type: Boolean, default: false },
    usedAtMs: Number,
    createdAtMs: Number,
    expiresAtMs: Number,
  },
  { strict: false, versionKey: false, collection: 'passwordResets' }
);

const DidYouKnowSchema = new mongoose.Schema(
  {
    id: { type: String, unique: true, index: true },
    title: String,
    description: String,
    image: String,
    badge: { type: String, default: 'DID YOU KNOW' },
    link: String,
    createdAtMs: Number,
  },
  { strict: false, versionKey: false, collection: 'didYouKnow' }
);

const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
const Meta = mongoose.models.Meta || mongoose.model('Meta', MetaSchema);
const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
const Message = mongoose.models.Message || mongoose.model('Message', MessageSchema);
const PasswordReset = mongoose.models.PasswordReset || mongoose.model('PasswordReset', PasswordResetSchema);
const DidYouKnow = mongoose.models.DidYouKnow || mongoose.model('DidYouKnow', DidYouKnowSchema);

// Local fallback used only when MONGODB_URI is not configured or unreachable
function loadLocalStore() {
  const empty = {
    products: [],
    deletedProductIds: [],
    metaCategories: {
      list: [],
      sizeCategories: [],
      colorCategories: [],
      subcategories: {},
    },
    users: [],
    orders: [],
    messages: [],
    passwordResets: [],
    didYouKnow: [],
    analytics: {
      totalViews: 0,
      visitorIds: [],
      knownUserKeys: [],
    },
  };
  try {
    if (!fs.existsSync(LOCAL_STORE_PATH)) return empty;
    const parsed = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8'));
    return {
      ...empty,
      ...parsed,
      metaCategories: { ...empty.metaCategories, ...(parsed.metaCategories || {}) },
      analytics: { ...empty.analytics, ...(parsed.analytics || {}) },
    };
  } catch {
    return empty;
  }
}

const memoryStore = loadLocalStore();

function persistLocalStore() {
  try {
    fs.writeFileSync(LOCAL_STORE_PATH, JSON.stringify(memoryStore, null, 2), 'utf8');
  } catch (err) {
    console.warn('[Fallback Store] Could not persist local store:', err.message);
  }
}

let mongoConnected = false;

mongoose.connection.on('connected', () => {
  mongoConnected = true;
});

mongoose.connection.on('disconnected', () => {
  mongoConnected = false;
});

mongoose.connection.on('error', () => {
  mongoConnected = false;
});

function normalizeMongoUri(rawUri, { stripPasswordBrackets = false } = {}) {
  let uri = String(rawUri || '').trim();
  uri = uri.replace(/^(?:MONGODB_URI|MONGO_URI)\s*=\s*/i, '').trim();
  if ((uri.startsWith('"') && uri.endsWith('"')) || (uri.startsWith("'") && uri.endsWith("'"))) {
    uri = uri.slice(1, -1).trim();
  }
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) return '';
  if (/<[^>]*(?:password|pass|your_)[^>]*>/i.test(uri)) return '';

  const schemeEnd = uri.indexOf('://') + 3;
  const pathStart = uri.indexOf('/', schemeEnd);
  const queryStart = uri.indexOf('?', schemeEnd);
  const authorityEnd = [pathStart, queryStart].filter((i) => i !== -1).reduce((a, b) => Math.min(a, b), uri.length);
  const authority = uri.slice(schemeEnd, authorityEnd);
  const atIndex = authority.lastIndexOf('@');
  if (atIndex === -1) return uri;

  const userInfo = authority.slice(0, atIndex);
  const hostPart = authority.slice(atIndex + 1);
  const colonIndex = userInfo.indexOf(':');
  if (colonIndex === -1) return uri;

  const rawUser = userInfo.slice(0, colonIndex);
  let rawPass = userInfo.slice(colonIndex + 1);
  if (stripPasswordBrackets && rawPass.startsWith('<') && rawPass.endsWith('>') && rawPass.length > 2) {
    rawPass = rawPass.slice(1, -1);
  }
  const safeEncode = (value) => {
    try {
      return encodeURIComponent(decodeURIComponent(value));
    } catch {
      return encodeURIComponent(value);
    }
  };
  return `${uri.slice(0, schemeEnd)}${safeEncode(rawUser)}:${safeEncode(rawPass)}@${hostPart}${uri.slice(authorityEnd)}`;
}

async function connectDB() {
  const rawUri = (process.env.MONGODB_URI || process.env.MONGO_URI || '').trim();
  const uri = normalizeMongoUri(rawUri);
  const rawUpstream = process.env.UPSTREAM_API_URL !== undefined
    ? String(process.env.UPSTREAM_API_URL).trim()
    : 'https://rk-ogzw.onrender.com';
  const hasUpstream = Boolean(rawUpstream && rawUpstream.toLowerCase() !== 'none');

  if (!uri) {
    mongoConnected = false;
    if (!hasUpstream) {
      console.log('[Store] Using local data store.');
    }
    return false;
  }

  const options = {
    serverSelectionTimeoutMS: 5000,
  };
  const dbName = (process.env.MONGODB_DB || process.env.MONGODB_DB_NAME || '').trim();
  if (dbName) {
    options.dbName = dbName;
  }

  const tryConnect = async (targetUri) => {
    await mongoose.connect(targetUri, options);
    mongoConnected = true;
    console.log('[MongoDB] Connected directly.');
    return true;
  };

  try {
    return await tryConnect(uri);
  } catch {
    await mongoose.disconnect().catch(() => {});
    const altUri = normalizeMongoUri(rawUri, { stripPasswordBrackets: true });
    if (altUri && altUri !== uri) {
      try {
        return await tryConnect(altUri);
      } catch {
        await mongoose.disconnect().catch(() => {});
      }
    }
    mongoConnected = false;
    if (hasUpstream) {
      console.log('[Store] Using Render API backend.');
    } else {
      console.log('[Store] Using local data store.');
    }
    return false;
  }
}

let connectPromise = null;

function ensureDBConnected() {
  if (isMongoReady()) return Promise.resolve(true);
  if (!connectPromise) {
    connectPromise = connectDB().catch(() => false);
  }
  return connectPromise;
}

function isMongoReady() {
  return mongoConnected && mongoose.connection.readyState === 1;
}

function isObjectIdHex(value) {
  return typeof value === 'string' && /^[a-fA-F0-9]{24}$/.test(value);
}

function productFilter(rawId) {
  const str = String(rawId);
  const clauses = [{ id: str }];
  if (/^\d+$/.test(str)) {
    const asNum = Number(str);
    if (Number.isSafeInteger(asNum)) clauses.push({ id: asNum });
  }
  if (isObjectIdHex(str)) {
    clauses.push({ _id: new mongoose.Types.ObjectId(str) });
  }
  return { $or: clauses };
}

function normalizeProduct(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const id = obj.id !== undefined && obj.id !== null && obj.id !== ''
    ? obj.id
    : String(obj._id);
  const gallery = Array.isArray(obj.gallery)
    ? obj.gallery.filter(Boolean)
    : (Array.isArray(obj.images) ? obj.images.slice(1).filter(Boolean) : []);
  const image = obj.image || (Array.isArray(obj.images) ? obj.images[0] : '') || '';
  const { _id, __v, ...rest } = obj;
  const normalized = {
    ...rest,
    id,
    name: obj.name ?? obj.title ?? '',
    price: Number(obj.price) || 0,
    image,
    gallery,
    category: obj.category ?? '',
    subcategory: obj.subcategory ? String(obj.subcategory).trim() : '',
    description: obj.description ?? '',
  };
  if (obj.promoPrice !== undefined && obj.promoPrice !== null && obj.promoPrice !== '') {
    normalized.promoPrice = Number(obj.promoPrice);
  }
  if (obj.bulkPrice !== undefined && obj.bulkPrice !== null && obj.bulkPrice !== '') {
    normalized.bulkPrice = Number(obj.bulkPrice);
  }
  if (obj.bulkMinQty !== undefined && obj.bulkMinQty !== null && obj.bulkMinQty !== '') {
    normalized.bulkMinQty = Number(obj.bulkMinQty);
  }
  return normalized;
}

function sortProducts(list) {
  return [...list].sort((a, b) => {
    const aNum = Number(a.id);
    const bNum = Number(b.id);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) {
      return aNum - bNum;
    }
    if (a.createdAtMs && b.createdAtMs) {
      return Number(a.createdAtMs) - Number(b.createdAtMs);
    }
    return String(a.id).localeCompare(String(b.id));
  });
}

function normalizeUser(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const adminEmail = String(process.env.ADMIN_EMAIL || 'choolwechingobe2@gmail.com').trim().toLowerCase();
  return {
    uid: obj.uid || String(obj._id),
    name: obj.name || '',
    email: obj.email || '',
    isAdmin: obj.isAdmin === true || (Boolean(adminEmail) && String(obj.email || '').toLowerCase() === adminEmail),
    passwordHash: obj.passwordHash || '',
  };
}

function publicUser(user) {
  if (!user) return null;
  return {
    uid: user.uid,
    name: user.name,
    email: user.email,
    isAdmin: user.isAdmin === true,
  };
}

function normalizeOrder(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const { _id, __v, ...rest } = obj;
  return {
    ...rest,
    id: obj.id || String(_id),
    items: Array.isArray(obj.items) ? obj.items : [],
    total: Number(obj.total) || 0,
    createdAtMs: Number(obj.createdAtMs) || 0,
  };
}

function normalizeMessage(doc) {
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  const { _id, __v, ...rest } = obj;
  return {
    ...rest,
    id: obj.id || String(_id),
    read: Boolean(obj.read),
    createdAtMs: Number(obj.createdAtMs) || 0,
  };
}

// ---------- Products ----------
async function listProducts() {
  if (!isMongoReady()) {
    return sortProducts(memoryStore.products.map(normalizeProduct));
  }
  const docs = await Product.find({}).lean();
  return sortProducts(docs.map(normalizeProduct));
}

async function saveProduct(rawId, payload) {
  const cleanPayload = {};
  for (const [key, value] of Object.entries(payload || {})) {
    if (key === '_id' || key === '__v' || value === undefined) continue;
    cleanPayload[key] = value;
  }
  if (cleanPayload.id === undefined || cleanPayload.id === null || cleanPayload.id === '') {
    cleanPayload.id = /^\d+$/.test(String(rawId)) && Number.isSafeInteger(Number(rawId))
      ? Number(rawId)
      : String(rawId);
  }
  cleanPayload.name = String(cleanPayload.name ?? '').trim();
  cleanPayload.price = Number.isFinite(Number(cleanPayload.price)) ? Number(cleanPayload.price) : 0;
  cleanPayload.category = String(cleanPayload.category ?? '').trim();
  cleanPayload.description = String(cleanPayload.description ?? '').trim();
  cleanPayload.image = String(cleanPayload.image ?? '');
  cleanPayload.gallery = Array.isArray(cleanPayload.gallery) ? cleanPayload.gallery.filter(Boolean) : [];

  for (const optNumField of ['promoPrice', 'bulkPrice', 'bulkMinQty']) {
    const val = cleanPayload[optNumField];
    if (val === undefined || val === null || val === '' || !Number.isFinite(Number(val))) {
      delete cleanPayload[optNumField];
    } else {
      cleanPayload[optNumField] = Number(val);
    }
  }
  if (!cleanPayload.options || typeof cleanPayload.options !== 'object' || !Object.keys(cleanPayload.options).length) {
    delete cleanPayload.options;
  }
  if (cleanPayload.subcategory !== undefined && cleanPayload.subcategory !== null) {
    const cleanSub = String(cleanPayload.subcategory).trim();
    if (cleanSub) cleanPayload.subcategory = cleanSub;
    else delete cleanPayload.subcategory;
  }

  if (!isMongoReady()) {
    const idx = memoryStore.products.findIndex((p) => String(p.id) === String(rawId));
    if (idx >= 0) {
      memoryStore.products[idx] = { ...cleanPayload };
    } else {
      memoryStore.products.push({ ...cleanPayload });
    }
    if (Array.isArray(memoryStore.deletedProductIds)) {
      memoryStore.deletedProductIds = memoryStore.deletedProductIds.filter((id) => String(id) !== String(rawId));
    }
    persistLocalStore();
    return normalizeProduct(cleanPayload);
  }

  const filter = productFilter(rawId);
  const existing = await Product.findOne(filter).lean();
  if (existing) {
    const updateDoc = { ...cleanPayload };
    // Preserve original id type if updating an existing document
    updateDoc.id = existing.id !== undefined && existing.id !== null ? existing.id : cleanPayload.id;
    const unsetFields = {};
    for (const optField of ['promoPrice', 'bulkPrice', 'bulkMinQty', 'options', 'subcategory']) {
      if (updateDoc[optField] === undefined) {
        delete updateDoc[optField];
        unsetFields[optField] = '';
      }
    }
    const updateOp = { $set: updateDoc };
    if (Object.keys(unsetFields).length) updateOp.$unset = unsetFields;
    const updated = await Product.findByIdAndUpdate(existing._id, updateOp, { new: true }).lean();
    return normalizeProduct(updated);
  }

  const created = await Product.create(cleanPayload);
  return normalizeProduct(created);
}

async function deleteProduct(rawId) {
  if (!isMongoReady()) {
    const before = memoryStore.products.length;
    memoryStore.products = memoryStore.products.filter((p) => String(p.id) !== String(rawId));
    if (memoryStore.products.length < before) persistLocalStore();
    return memoryStore.products.length < before;
  }
  const result = await Product.deleteOne(productFilter(rawId));
  return result.deletedCount > 0;
}

function listDeletedProductIds() {
  return Array.isArray(memoryStore.deletedProductIds) ? [...memoryStore.deletedProductIds] : [];
}

function markProductDeleted(rawId) {
  const key = String(rawId);
  if (!Array.isArray(memoryStore.deletedProductIds)) memoryStore.deletedProductIds = [];
  if (!memoryStore.deletedProductIds.includes(key)) {
    memoryStore.deletedProductIds.push(key);
    persistLocalStore();
  }
}

function unmarkProductDeleted(rawId) {
  const key = String(rawId);
  if (!Array.isArray(memoryStore.deletedProductIds)) return;
  const before = memoryStore.deletedProductIds.length;
  memoryStore.deletedProductIds = memoryStore.deletedProductIds.filter((id) => String(id) !== key);
  if (memoryStore.deletedProductIds.length < before) persistLocalStore();
}

// ---------- Categories Meta ----------
function normalizeSubcategoriesMap(rawMap, allowedCategories = null) {
  const out = {};
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return out;
  for (const [cat, items] of Object.entries(rawMap)) {
    const cleanCat = String(cat || '').trim();
    if (!cleanCat) continue;
    if (Array.isArray(allowedCategories) && !allowedCategories.includes(cleanCat)) continue;
    const seen = new Set();
    const list = [];
    for (const entry of Array.isArray(items) ? items : []) {
      const cleanSub = String(entry || '').trim().slice(0, 50);
      if (!cleanSub) continue;
      const lower = cleanSub.toLowerCase();
      if (seen.has(lower)) continue;
      seen.add(lower);
      list.push(cleanSub);
    }
    if (list.length) out[cleanCat] = list;
  }
  return out;
}

async function getCategoriesMeta() {
  if (!isMongoReady()) {
    const data = memoryStore.metaCategories;
    return {
      list: Array.isArray(data.list) ? [...data.list] : [],
      sizeCategories: Array.isArray(data.sizeCategories) ? [...data.sizeCategories] : [],
      colorCategories: Array.isArray(data.colorCategories) ? [...data.colorCategories] : [],
      subcategories: normalizeSubcategoriesMap(data.subcategories),
    };
  }
  const doc = await Meta.findOne({ $or: [{ _id: 'categories' }, { key: 'categories' }] }).lean();
  const data = doc || {};
  const legacy = Array.isArray(data.variantCategories) ? data.variantCategories : [];
  return {
    list: Array.isArray(data.list) ? data.list : [],
    sizeCategories: Array.isArray(data.sizeCategories) ? data.sizeCategories : legacy,
    colorCategories: Array.isArray(data.colorCategories) ? data.colorCategories : legacy,
    subcategories: normalizeSubcategoriesMap(data.subcategories),
  };
}

async function saveCategoriesMeta({ list, sizeCategories, colorCategories, subcategories }) {
  const cleanList = Array.isArray(list) ? list : [];
  const cleanSizes = (Array.isArray(sizeCategories) ? sizeCategories : []).filter((c) => cleanList.includes(c));
  const cleanColors = (Array.isArray(colorCategories) ? colorCategories : []).filter((c) => cleanList.includes(c));
  const cleanSubs = normalizeSubcategoriesMap(subcategories, cleanList);
  const payload = {
    list: cleanList,
    sizeCategories: cleanSizes,
    colorCategories: cleanColors,
    subcategories: cleanSubs,
  };

  if (!isMongoReady()) {
    memoryStore.metaCategories = payload;
    persistLocalStore();
    return payload;
  }

  await Meta.findOneAndUpdate(
    { _id: 'categories' },
    { $set: { key: 'categories', ...payload } },
    { upsert: true, new: true }
  );
  return payload;
}

// ---------- Users ----------
async function findUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  if (!isMongoReady()) {
    const found = memoryStore.users.find((u) => u.email === normalized);
    return normalizeUser(found);
  }
  const doc = await User.findOne({ email: normalized }).lean();
  return normalizeUser(doc);
}

async function findUserByUid(uid) {
  const str = String(uid || '');
  if (!str) return null;
  if (!isMongoReady()) {
    const found = memoryStore.users.find((u) => u.uid === str);
    return normalizeUser(found);
  }
  const clauses = [{ uid: str }];
  if (isObjectIdHex(str)) clauses.push({ _id: new mongoose.Types.ObjectId(str) });
  const doc = await User.findOne({ $or: clauses }).lean();
  return normalizeUser(doc);
}

async function createUser({ name, email, passwordHash, isAdmin = false }) {
  const normalized = String(email || '').trim().toLowerCase();
  const uid = crypto.randomUUID();
  const record = {
    uid,
    name: String(name || '').trim(),
    email: normalized,
    passwordHash,
    isAdmin: Boolean(isAdmin),
    createdAtMs: Date.now(),
  };

  if (!isMongoReady()) {
    memoryStore.users.push(record);
    persistLocalStore();
    return normalizeUser(record);
  }

  const created = await User.create(record);
  return normalizeUser(created);
}

async function updateUserName(uid, name) {
  const cleanName = String(name || '').trim();
  if (!isMongoReady()) {
    const user = memoryStore.users.find((u) => u.uid === uid);
    if (!user) return null;
    user.name = cleanName;
    persistLocalStore();
    return normalizeUser(user);
  }
  const clauses = [{ uid: String(uid) }];
  if (isObjectIdHex(String(uid))) clauses.push({ _id: new mongoose.Types.ObjectId(String(uid)) });
  const updated = await User.findOneAndUpdate(
    { $or: clauses },
    { $set: { name: cleanName } },
    { new: true }
  ).lean();
  return normalizeUser(updated);
}

// ---------- Orders ----------
async function listOrders(user) {
  if (!isMongoReady()) {
    const list = user?.isAdmin
      ? memoryStore.orders
      : memoryStore.orders.filter((o) => o.uid === user?.uid || (user?.email && o.email === user.email));
    return list.map(normalizeOrder).sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  const filter = user?.isAdmin
    ? {}
    : { $or: [{ uid: user.uid }, ...(user.email ? [{ email: user.email }] : [])] };
  const docs = await Order.find(filter).sort({ createdAtMs: 1 }).lean();
  return docs.map(normalizeOrder);
}

async function createOrder(order) {
  const record = {
    ...order,
    createdAtMs: Number(order.createdAtMs) || Date.now(),
  };
  if (!isMongoReady()) {
    memoryStore.orders.push(record);
    persistLocalStore();
    return normalizeOrder(record);
  }
  const created = await Order.create(record);
  return normalizeOrder(created);
}

async function updateOrderItems(orderId, items, reportedAtMs = Date.now()) {
  if (!isMongoReady()) {
    const order = memoryStore.orders.find((o) => o.id === orderId);
    if (!order) return null;
    order.items = items;
    order.reportedAtMs = reportedAtMs;
    persistLocalStore();
    return normalizeOrder(order);
  }
  const updated = await Order.findOneAndUpdate(
    { id: orderId },
    { $set: { items, reportedAtMs } },
    { new: true }
  ).lean();
  return updated ? normalizeOrder(updated) : null;
}

// ---------- Messages ----------
async function listMessages() {
  if (!isMongoReady()) {
    return memoryStore.messages
      .map(normalizeMessage)
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
  }
  const docs = await Message.find({}).sort({ createdAtMs: 1 }).lean();
  return docs.map(normalizeMessage);
}

async function createMessage(message) {
  const record = {
    ...message,
    createdAtMs: Number(message.createdAtMs) || Date.now(),
    read: Boolean(message.read),
  };
  if (!isMongoReady()) {
    memoryStore.messages.push(record);
    persistLocalStore();
    return normalizeMessage(record);
  }
  const created = await Message.create(record);
  return normalizeMessage(created);
}

async function updateMessageRead(id, read) {
  if (!isMongoReady()) {
    const msg = memoryStore.messages.find((m) => m.id === id);
    if (!msg) return null;
    msg.read = Boolean(read);
    persistLocalStore();
    return normalizeMessage(msg);
  }
  const updated = await Message.findOneAndUpdate(
    { id },
    { $set: { read: Boolean(read) } },
    { new: true }
  ).lean();
  return updated ? normalizeMessage(updated) : null;
}

async function deleteMessage(id) {
  if (!isMongoReady()) {
    const before = memoryStore.messages.length;
    memoryStore.messages = memoryStore.messages.filter((m) => m.id !== id);
    if (memoryStore.messages.length < before) persistLocalStore();
    return memoryStore.messages.length < before;
  }
  const result = await Message.deleteOne({ id });
  return result.deletedCount > 0;
}

// ---------- Password Resets ----------
function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

async function createPasswordReset(user) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const record = {
    uid: user.uid,
    email: String(user.email || '').trim().toLowerCase(),
    tokenHash: hashResetToken(rawToken),
    used: false,
    createdAtMs: Date.now(),
    expiresAtMs: Date.now() + 30 * 60 * 1000,
  };
  if (!isMongoReady()) {
    memoryStore.passwordResets.push(record);
    persistLocalStore();
    return { ...record, rawToken };
  }
  await PasswordReset.create(record);
  return { ...record, rawToken };
}

async function consumePasswordReset(rawToken, newPasswordHash) {
  const tokenHash = hashResetToken(rawToken);
  const now = Date.now();
  if (!isMongoReady()) {
    const reset = memoryStore.passwordResets.find(
      (r) => r.tokenHash === tokenHash && !r.used && Number(r.expiresAtMs) > now
    );
    if (!reset) return false;
    const user = memoryStore.users.find((u) => u.uid === reset.uid || u.email === reset.email);
    if (!user) return false;
    user.passwordHash = newPasswordHash;
    user.passwordUpdatedAtMs = now;
    reset.used = true;
    reset.usedAtMs = now;
    persistLocalStore();
    return true;
  }
  const reset = await PasswordReset.findOne({
    tokenHash,
    used: { $ne: true },
    expiresAtMs: { $gt: now },
  }).lean();
  if (!reset) return false;
  const userClauses = [];
  if (reset.uid) {
    userClauses.push({ uid: reset.uid }, { firebaseUid: reset.uid });
    if (isObjectIdHex(reset.uid)) userClauses.push({ _id: new mongoose.Types.ObjectId(reset.uid) });
  }
  if (reset.email) userClauses.push({ email: reset.email });
  if (!userClauses.length) return false;
  await User.updateOne(
    { $or: userClauses },
    { $set: { passwordHash: newPasswordHash, authProvider: 'mongodb', passwordUpdatedAtMs: now } }
  );
  await PasswordReset.updateOne({ _id: reset._id }, { $set: { used: true, usedAtMs: now } });
  return true;
}

// ---------- Analytics & Admin Stats ----------
function userIdentityKey(entry) {
  if (!entry || typeof entry !== 'object') return '';
  const email = String(entry.email || '').trim().toLowerCase();
  if (email) return `email:${email}`;
  const uid = String(entry.uid || entry.firebaseUid || '').trim();
  if (uid) return `uid:${uid}`;
  return '';
}

function recordKnownUsers(entries = []) {
  if (!Array.isArray(entries) || !entries.length) return;
  if (!memoryStore.analytics) {
    memoryStore.analytics = { totalViews: 0, visitorIds: [], knownUserKeys: [] };
  }
  const known = new Set(Array.isArray(memoryStore.analytics.knownUserKeys) ? memoryStore.analytics.knownUserKeys : []);
  let changed = false;
  for (const entry of entries) {
    const key = userIdentityKey(entry);
    if (key && !known.has(key)) {
      known.add(key);
      changed = true;
    }
  }
  if (changed) {
    memoryStore.analytics.knownUserKeys = [...known];
    persistLocalStore();
  }
}

async function recordSiteVisit(visitorId) {
  const cleanId = String(visitorId || '').trim().slice(0, 128);
  if (!isMongoReady()) {
    if (!memoryStore.analytics) {
      memoryStore.analytics = { totalViews: 0, visitorIds: [], knownUserKeys: [] };
    }
    memoryStore.analytics.totalViews = (Number(memoryStore.analytics.totalViews) || 0) + 1;
    if (cleanId) {
      const set = new Set(Array.isArray(memoryStore.analytics.visitorIds) ? memoryStore.analytics.visitorIds : []);
      set.add(cleanId);
      memoryStore.analytics.visitorIds = [...set];
    }
    persistLocalStore();
    return {
      totalViews: memoryStore.analytics.totalViews,
      websiteVisitors: memoryStore.analytics.visitorIds.length,
    };
  }

  const update = {
    $setOnInsert: { key: 'analytics' },
    $inc: { totalViews: 1 },
  };
  if (cleanId) {
    update.$addToSet = { visitorIds: cleanId };
  }
  const doc = await Meta.findOneAndUpdate(
    { _id: 'analytics' },
    update,
    { upsert: true, new: true }
  ).lean();
  return {
    totalViews: Number(doc?.totalViews) || 0,
    websiteVisitors: Array.isArray(doc?.visitorIds) ? doc.visitorIds.length : 0,
  };
}

async function countUsers() {
  if (isMongoReady()) {
    return User.countDocuments({});
  }
  const combined = new Set(
    Array.isArray(memoryStore.analytics?.knownUserKeys) ? memoryStore.analytics.knownUserKeys : []
  );
  for (const u of memoryStore.users || []) {
    const key = userIdentityKey(u);
    if (key) combined.add(key);
  }
  return combined.size;
}

async function getAdminStats({ extraUsers = [] } = {}) {
  if (Array.isArray(extraUsers) && extraUsers.length) {
    recordKnownUsers(extraUsers);
  }
  if (isMongoReady()) {
    const [registeredUsers, doc] = await Promise.all([
      User.countDocuments({}),
      Meta.findOne({ $or: [{ _id: 'analytics' }, { key: 'analytics' }] }).lean(),
    ]);
    return {
      registeredUsers: Number(registeredUsers) || 0,
      websiteVisitors: Array.isArray(doc?.visitorIds) ? doc.visitorIds.length : 0,
      totalViews: Number(doc?.totalViews) || 0,
    };
  }
  const analytics = memoryStore.analytics || { totalViews: 0, visitorIds: [], knownUserKeys: [] };
  const registeredUsers = await countUsers();
  return {
    registeredUsers,
    websiteVisitors: Array.isArray(analytics.visitorIds) ? analytics.visitorIds.length : 0,
    totalViews: Number(analytics.totalViews) || 0,
  };
}

// ---------- Did You Know Cards ----------
async function listDidYouKnow() {
  if (!isMongoReady()) {
    return Array.isArray(memoryStore.didYouKnow) ? [...memoryStore.didYouKnow] : [];
  }
  const docs = await DidYouKnow.find({}).sort({ createdAtMs: 1 }).lean();
  return docs.map(doc => {
    const { _id, __v, ...rest } = doc;
    return { ...rest, id: doc.id || String(_id) };
  });
}

async function saveDidYouKnow(id, payload) {
  const cleanId = String(id || `DYK-${Date.now()}`);
  const record = {
    id: cleanId,
    title: String(payload?.title || '').trim(),
    description: String(payload?.description || '').trim(),
    image: String(payload?.image || '').trim(),
    badge: String(payload?.badge || 'DID YOU KNOW').trim(),
    link: String(payload?.link || '').trim(),
    createdAtMs: Number(payload?.createdAtMs) || Date.now(),
  };
  if (!isMongoReady()) {
    if (!Array.isArray(memoryStore.didYouKnow)) memoryStore.didYouKnow = [];
    const idx = memoryStore.didYouKnow.findIndex(item => String(item.id) === cleanId);
    if (idx >= 0) {
      memoryStore.didYouKnow[idx] = { ...memoryStore.didYouKnow[idx], ...record };
    } else {
      memoryStore.didYouKnow.push(record);
    }
    persistLocalStore();
    return record;
  }
  const updated = await DidYouKnow.findOneAndUpdate(
    { id: cleanId },
    { $set: record },
    { upsert: true, new: true }
  ).lean();
  const { _id, __v, ...rest } = updated;
  return { ...rest, id: updated.id || String(_id) };
}

async function deleteDidYouKnow(id) {
  const cleanId = String(id);
  if (!isMongoReady()) {
    if (!Array.isArray(memoryStore.didYouKnow)) memoryStore.didYouKnow = [];
    const before = memoryStore.didYouKnow.length;
    memoryStore.didYouKnow = memoryStore.didYouKnow.filter(item => String(item.id) !== cleanId);
    if (memoryStore.didYouKnow.length < before) persistLocalStore();
    return memoryStore.didYouKnow.length < before;
  }
  const result = await DidYouKnow.deleteOne({ id: cleanId });
  return result.deletedCount > 0;
}

module.exports = {
  connectDB,
  ensureDBConnected,
  isMongoReady,
  publicUser,
  listProducts,
  saveProduct,
  deleteProduct,
  getCategoriesMeta,
  saveCategoriesMeta,
  findUserByEmail,
  findUserByUid,
  createUser,
  updateUserName,
  listOrders,
  createOrder,
  updateOrderItems,
  listMessages,
  createMessage,
  updateMessageRead,
  deleteMessage,
  createPasswordReset,
  consumePasswordReset,
  countUsers,
  recordKnownUsers,
  recordSiteVisit,
  getAdminStats,
  listDidYouKnow,
  saveDidYouKnow,
  deleteDidYouKnow,
  listDeletedProductIds,
  markProductDeleted,
  unmarkProductDeleted,
};
