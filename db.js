const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const LOCAL_STORE_PATH = path.join(__dirname, '.local-dev-store.json');

mongoose.set('bufferCommands', false);

const ProductSchema = new mongoose.Schema(
  {
    id: { type: mongoose.Schema.Types.Mixed, index: true },
    name: String,
    price: Number,
    bulkPrice: Number,
    bulkMinQty: Number,
    image: String,
    gallery: [String],
    category: String,
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

const Product = mongoose.models.Product || mongoose.model('Product', ProductSchema);
const Meta = mongoose.models.Meta || mongoose.model('Meta', MetaSchema);
const User = mongoose.models.User || mongoose.model('User', UserSchema);
const Order = mongoose.models.Order || mongoose.model('Order', OrderSchema);
const Message = mongoose.models.Message || mongoose.model('Message', MessageSchema);
const PasswordReset = mongoose.models.PasswordReset || mongoose.model('PasswordReset', PasswordResetSchema);

// Local fallback used only when MONGODB_URI is not configured or unreachable
function loadLocalStore() {
  const empty = {
    products: [],
    metaCategories: {
      list: [],
      sizeCategories: [],
      colorCategories: [],
    },
    users: [],
    orders: [],
    messages: [],
    passwordResets: [],
  };
  try {
    if (!fs.existsSync(LOCAL_STORE_PATH)) return empty;
    const parsed = JSON.parse(fs.readFileSync(LOCAL_STORE_PATH, 'utf8'));
    return {
      ...empty,
      ...parsed,
      metaCategories: { ...empty.metaCategories, ...(parsed.metaCategories || {}) },
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

function normalizeMongoUri(rawUri) {
  let uri = String(rawUri || '').trim();
  if ((uri.startsWith('"') && uri.endsWith('"')) || (uri.startsWith("'") && uri.endsWith("'"))) {
    uri = uri.slice(1, -1).trim();
  }
  if (!uri || !/^mongodb(\+srv)?:\/\//i.test(uri)) return '';
  if (/<[^>]*password[^>]*>/i.test(uri)) return '';

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
  const rawPass = userInfo.slice(colonIndex + 1);
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
      console.log('[MongoDB] Using local fallback store.');
    }
    return false;
  }

  try {
    const options = {
      serverSelectionTimeoutMS: 5000,
    };
    const dbName = (process.env.MONGODB_DB || process.env.MONGODB_DB_NAME || '').trim();
    if (dbName) {
      options.dbName = dbName;
    }
    await mongoose.connect(uri, options);
    mongoConnected = true;
    console.log('[MongoDB] Connected directly.');
    return true;
  } catch (err) {
    mongoConnected = false;
    await mongoose.disconnect().catch(() => {});
    if (hasUpstream) {
      console.log(`[MongoDB] Direct connection skipped (${err.message}); using Render API backend.`);
    } else {
      console.log(`[MongoDB] Direct connection unavailable (${err.message}); using local fallback store.`);
    }
    return false;
  }
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
  } else {
    clauses.push({ _id: str });
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
    description: obj.description ?? '',
  };
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
  return {
    uid: obj.uid || String(obj._id),
    name: obj.name || '',
    email: obj.email || '',
    isAdmin: obj.isAdmin === true,
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
  const cleanPayload = { ...payload };
  delete cleanPayload._id;
  delete cleanPayload.__v;
  if (cleanPayload.id === undefined || cleanPayload.id === null || cleanPayload.id === '') {
    cleanPayload.id = rawId;
  }

  if (!isMongoReady()) {
    const idx = memoryStore.products.findIndex((p) => String(p.id) === String(rawId));
    if (idx >= 0) {
      memoryStore.products[idx] = { ...cleanPayload };
    } else {
      memoryStore.products.push({ ...cleanPayload });
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
    if (updateDoc.bulkPrice === undefined) unsetFields.bulkPrice = '';
    if (updateDoc.bulkMinQty === undefined) unsetFields.bulkMinQty = '';
    if (updateDoc.options === undefined) unsetFields.options = '';
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

// ---------- Categories Meta ----------
async function getCategoriesMeta() {
  if (!isMongoReady()) {
    const data = memoryStore.metaCategories;
    return {
      list: Array.isArray(data.list) ? [...data.list] : [],
      sizeCategories: Array.isArray(data.sizeCategories) ? [...data.sizeCategories] : [],
      colorCategories: Array.isArray(data.colorCategories) ? [...data.colorCategories] : [],
    };
  }
  const doc = await Meta.findOne({ $or: [{ _id: 'categories' }, { key: 'categories' }] }).lean();
  const data = doc || {};
  const legacy = Array.isArray(data.variantCategories) ? data.variantCategories : [];
  return {
    list: Array.isArray(data.list) ? data.list : [],
    sizeCategories: Array.isArray(data.sizeCategories) ? data.sizeCategories : legacy,
    colorCategories: Array.isArray(data.colorCategories) ? data.colorCategories : legacy,
  };
}

async function saveCategoriesMeta({ list, sizeCategories, colorCategories }) {
  const cleanList = Array.isArray(list) ? list : [];
  const cleanSizes = (Array.isArray(sizeCategories) ? sizeCategories : []).filter((c) => cleanList.includes(c));
  const cleanColors = (Array.isArray(colorCategories) ? colorCategories : []).filter((c) => cleanList.includes(c));
  const payload = {
    list: cleanList,
    sizeCategories: cleanSizes,
    colorCategories: cleanColors,
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

module.exports = {
  connectDB,
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
};
