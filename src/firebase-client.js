import { initializeApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  sendPasswordResetEmail,
  sendEmailVerification,
  updateProfile,
  onAuthStateChanged,
  signOut
} from 'firebase/auth';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  query,
  where,
  increment,
  serverTimestamp,
  Timestamp
} from 'firebase/firestore';
import firebaseConfig from '../firebase-applet-config.json';

const ADMIN_EMAIL = 'choolwechingobe2@gmail.com';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
const auth = getAuth(app);

const OperationType = {
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  LIST: 'list',
  GET: 'get',
  WRITE: 'write'
};

function handleFirestoreError(error, operationType, path) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid || null,
      email: auth.currentUser?.email || null,
      emailVerified: auth.currentUser?.emailVerified ?? null,
      isAnonymous: auth.currentUser?.isAnonymous ?? null,
      tenantId: auth.currentUser?.tenantId || null,
      providerInfo: (auth.currentUser?.providerData || []).map((provider) => ({
        providerId: provider.providerId || null,
        email: provider.email || null
      }))
    },
    operationType,
    path
  };
  console.error('Firestore Error:', JSON.stringify(errInfo));
  const wrapped = new Error(JSON.stringify(errInfo));
  wrapped.originalError = error;
  throw wrapped;
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

testConnection();

function cleanSafeId(raw, fallbackPrefix = 'item') {
  const cleaned = String(raw || '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return cleaned || `${fallbackPrefix}_${Date.now()}`;
}

function categoryViewKey(categoryName) {
  const slug = String(categoryName || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 96);
  return `category_${slug || 'general'}`;
}

function productViewKey(productId) {
  return `product_${cleanSafeId(productId, 'prod')}`;
}

function isBootstrappedAdmin(fbUser) {
  return Boolean(
    fbUser &&
    fbUser.email &&
    fbUser.email.toLowerCase() === ADMIN_EMAIL &&
    fbUser.emailVerified === true
  );
}

function sanitizeProductPayload(rawId, raw) {
  const id = cleanSafeId(rawId || raw?.id, 'prod');
  const out = {
    id,
    name: String(raw?.name || 'Untitled Product').trim().slice(0, 160) || 'Untitled Product',
    price: Math.max(0, Number(raw?.price) || 0),
    image: String(raw?.image || '').slice(0, 2048),
    gallery: Array.isArray(raw?.gallery)
      ? raw.gallery.filter((u) => typeof u === 'string' && u.length > 0 && u.length <= 2048).slice(0, 10)
      : [],
    category: String(raw?.category || '').trim().slice(0, 80),
    subcategory: String(raw?.subcategory || '').trim().slice(0, 80),
    description: String(raw?.description || '').trim().slice(0, 4000),
    updatedAt: serverTimestamp()
  };
  if (raw?.promoPrice !== undefined && raw?.promoPrice !== null && raw?.promoPrice !== '' && Number.isFinite(Number(raw.promoPrice))) {
    out.promoPrice = Math.max(0, Number(raw.promoPrice));
  }
  if (raw?.bulkPrice !== undefined && raw?.bulkPrice !== null && raw?.bulkPrice !== '' && Number.isFinite(Number(raw.bulkPrice))) {
    out.bulkPrice = Math.max(0, Number(raw.bulkPrice));
  }
  if (raw?.bulkMinQty !== undefined && raw?.bulkMinQty !== null && raw?.bulkMinQty !== '' && Number.isFinite(Number(raw.bulkMinQty)) && Number(raw.bulkMinQty) >= 2) {
    out.bulkMinQty = Math.floor(Number(raw.bulkMinQty));
  }
  if (raw?.options && typeof raw.options === 'object' && !Array.isArray(raw.options) && Object.keys(raw.options).length > 0) {
    out.options = raw.options;
  }
  if (raw?.sku) out.sku = String(raw.sku).trim().slice(0, 64);
  if (raw?.createdAtMs && Number.isFinite(Number(raw.createdAtMs))) {
    out.createdAtMs = Number(raw.createdAtMs);
  } else {
    out.createdAtMs = Date.now();
  }
  return out;
}

function sortProductsList(list) {
  return [...list].sort((a, b) => {
    const aNum = Number(a.id);
    const bNum = Number(b.id);
    if (Number.isFinite(aNum) && Number.isFinite(bNum)) return aNum - bNum;
    if (a.createdAtMs && b.createdAtMs) return Number(a.createdAtMs) - Number(b.createdAtMs);
    return String(a.id).localeCompare(String(b.id));
  });
}

async function syncUserProfile(fbUser) {
  if (!fbUser) return null;
  const uid = cleanSafeId(fbUser.uid, 'usr');
  const email = String(fbUser.email || '').trim().toLowerCase();
  const displayName = String(fbUser.displayName || email.split('@')[0] || 'Customer').trim().slice(0, 120);
  const path = `users/${uid}`;
  let existingData = null;

  try {
    const snap = await getDoc(doc(db, 'users', uid));
    if (snap.exists()) existingData = snap.data();
  } catch {
    // Profile may not exist yet or user lacks permissions before verification
  }

  let adminFlag = existingData?.isAdmin === true || isBootstrappedAdmin(fbUser);
  if (!adminFlag) {
    try {
      const adminSnap = await getDoc(doc(db, 'admins', uid));
      if (adminSnap.exists()) adminFlag = true;
    } catch {
      // Not an admin
    }
  }

  if (fbUser.emailVerified) {
    try {
      if (!existingData) {
        await setDoc(doc(db, 'users', uid), {
          uid,
          name: displayName,
          email,
          isAdmin: isBootstrappedAdmin(fbUser),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      } else if (existingData.name !== displayName) {
        await updateDoc(doc(db, 'users', uid), {
          name: existingData.name || displayName,
          updatedAt: serverTimestamp()
        });
      }
    } catch (err) {
      console.warn('[Firestore Profile Sync]', err.message || err);
    }
  }

  return {
    uid,
    name: existingData?.name || displayName,
    email,
    isAdmin: adminFlag,
    emailVerified: Boolean(fbUser.emailVerified)
  };
}

function onAuthChange(callback) {
  return onAuthStateChanged(auth, async (fbUser) => {
    if (!fbUser) {
      callback(null);
      return;
    }
    const profile = await syncUserProfile(fbUser);
    callback(profile);
  });
}

async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const cred = await signInWithPopup(auth, provider);
  return syncUserProfile(cred.user);
}

async function signInWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return syncUserProfile(cred.user);
}

async function registerWithEmail(name, email, password) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  if (name && cred.user) {
    await updateProfile(cred.user, { displayName: String(name).trim().slice(0, 120) }).catch(() => {});
  }
  if (cred.user && !cred.user.emailVerified) {
    await sendEmailVerification(cred.user).catch(() => {});
  }
  return syncUserProfile(cred.user);
}

async function sendPasswordReset(email) {
  await sendPasswordResetEmail(auth, email);
}

async function logout() {
  await signOut(auth);
}

async function getIdToken() {
  if (!auth.currentUser) return '';
  return auth.currentUser.getIdToken();
}

async function updateProfileName(uid, name) {
  const cleanUid = cleanSafeId(uid, 'usr');
  const cleanName = String(name || '').trim().slice(0, 120);
  if (!cleanName) throw new Error('Name is required.');
  if (auth.currentUser) {
    await updateProfile(auth.currentUser, { displayName: cleanName }).catch(() => {});
  }
  try {
    await updateDoc(doc(db, 'users', cleanUid), {
      name: cleanName,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `users/${cleanUid}`);
  }
}

async function fetchStorefront() {
  let products = [];
  let categories = [];
  let sizeCategories = [];
  let colorCategories = [];
  let subcategories = {};
  let didYouKnow = [];

  try {
    const prodSnap = await getDocs(collection(db, 'products'));
    products = sortProductsList(prodSnap.docs.map((d) => ({ ...d.data(), id: d.data()?.id || d.id })));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'products');
  }

  try {
    const metaSnap = await getDoc(doc(db, 'meta', 'categories'));
    if (metaSnap.exists()) {
      const m = metaSnap.data() || {};
      categories = Array.isArray(m.list) ? m.list : [];
      sizeCategories = Array.isArray(m.sizeCategories) ? m.sizeCategories : [];
      colorCategories = Array.isArray(m.colorCategories) ? m.colorCategories : [];
      subcategories = m.subcategories && typeof m.subcategories === 'object' ? m.subcategories : {};
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'meta/categories');
  }

  try {
    const dykSnap = await getDocs(collection(db, 'didYouKnow'));
    didYouKnow = dykSnap.docs
      .map((d) => ({ ...d.data(), id: d.data()?.id || d.id }))
      .sort((a, b) => (Number(a.createdAtMs) || 0) - (Number(b.createdAtMs) || 0));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'didYouKnow');
  }

  return { products, categories, sizeCategories, colorCategories, subcategories, didYouKnow };
}

async function saveProduct(rawId, rawProduct) {
  const payload = sanitizeProductPayload(rawId, rawProduct);
  const path = `products/${payload.id}`;
  try {
    await setDoc(doc(db, 'products', payload.id), payload);
    return { ...payload, updatedAt: Date.now() };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, path);
  }
}

async function deleteProduct(rawId) {
  const id = cleanSafeId(rawId, 'prod');
  const path = `products/${id}`;
  try {
    await deleteDoc(doc(db, 'products', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, path);
  }
}

async function saveCategoriesMeta({ list = [], sizeCategories = [], colorCategories = [], subcategories = {} }) {
  const cleanList = [...new Set((Array.isArray(list) ? list : []).map((c) => String(c || '').trim().slice(0, 80)).filter(Boolean))].slice(0, 100);
  const cleanSizes = [...new Set((Array.isArray(sizeCategories) ? sizeCategories : []).filter((c) => cleanList.includes(c)))].slice(0, 100);
  const cleanColors = [...new Set((Array.isArray(colorCategories) ? colorCategories : []).filter((c) => cleanList.includes(c)))].slice(0, 100);
  const cleanSubs = {};
  for (const cat of cleanList) {
    const items = Array.isArray(subcategories?.[cat]) ? subcategories[cat].map((s) => String(s || '').trim().slice(0, 80)).filter(Boolean) : [];
    if (items.length) cleanSubs[cat] = [...new Set(items)].slice(0, 50);
  }
  const payload = {
    key: 'categories',
    list: cleanList,
    sizeCategories: cleanSizes,
    colorCategories: cleanColors,
    subcategories: cleanSubs,
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'meta', 'categories'), payload);
    return {
      categories: cleanList,
      sizeCategories: cleanSizes,
      colorCategories: cleanColors,
      subcategories: cleanSubs
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'meta/categories');
  }
}

async function saveDidYouKnow(rawId, data) {
  const id = cleanSafeId(rawId || `DYK-${Date.now()}`, 'dyk');
  const payload = {
    id,
    title: String(data?.title || 'Update').trim().slice(0, 160),
    description: String(data?.description || '').trim().slice(0, 2000),
    image: String(data?.image || '').trim().slice(0, 2048),
    badge: String(data?.badge || 'DID YOU KNOW').trim().slice(0, 64),
    link: String(data?.link || '').trim().slice(0, 1024),
    createdAtMs: Number(data?.createdAtMs) || Date.now(),
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'didYouKnow', id), payload);
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, `didYouKnow/${id}`);
  }
}

async function deleteDidYouKnow(rawId) {
  const id = cleanSafeId(rawId, 'dyk');
  try {
    await deleteDoc(doc(db, 'didYouKnow', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `didYouKnow/${id}`);
  }
}

async function fetchOrders(user) {
  if (!user) return [];
  try {
    const q = user.isAdmin
      ? collection(db, 'orders')
      : query(collection(db, 'orders'), where('uid', '==', user.uid));
    const snap = await getDocs(q);
    return snap.docs
      .map((d) => ({ ...d.data(), id: d.data()?.id || d.id }))
      .sort((a, b) => (Number(a.createdAtMs) || 0) - (Number(b.createdAtMs) || 0));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'orders');
  }
}

async function createOrder(order) {
  const id = cleanSafeId(order?.id || `ORD-${Date.now()}`, 'ORD');
  const uid = cleanSafeId(auth.currentUser?.uid || order?.uid, 'usr');
  const payload = {
    id,
    uid,
    customer: String(order?.customer || 'Customer').trim().slice(0, 120) || 'Customer',
    email: String(order?.email || auth.currentUser?.email || '').trim().slice(0, 254),
    date: String(order?.date || new Date().toLocaleDateString()).slice(0, 64),
    items: Array.isArray(order?.items) ? order.items.slice(0, 100) : [],
    total: Math.max(0, Number(order?.total) || 0),
    status: 'Awaiting WhatsApp confirmation',
    createdAtMs: Number(order?.createdAtMs) || Date.now(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'orders', id), payload);
    return { ...payload, createdAt: Date.now(), updatedAt: Date.now() };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `orders/${id}`);
  }
}

async function updateOrderStatus(orderId, status) {
  const id = cleanSafeId(orderId, 'ORD');
  try {
    await updateDoc(doc(db, 'orders', id), {
      status: String(status || 'Awaiting WhatsApp confirmation'),
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `orders/${id}`);
  }
}

async function updateOrderItems(orderId, items) {
  const id = cleanSafeId(orderId, 'ORD');
  const safeItems = Array.isArray(items) && items.length ? items.slice(0, 100) : [{ name: 'Item', price: 0, quantity: 1 }];
  let totalQty = 0;
  let soldQty = 0;
  let unavailableQty = 0;
  for (const item of safeItems) {
    const q = Math.max(0, Number(item.quantity) || 0);
    totalQty += q;
    soldQty += Math.min(q, Math.max(0, Number(item.soldQty) || 0));
    unavailableQty += Math.min(q, Math.max(0, Number(item.unavailableQty) || 0));
  }
  let nextStatus = 'Awaiting WhatsApp confirmation';
  if (totalQty > 0 && unavailableQty >= totalQty) {
    nextStatus = 'Unavailable';
  } else if (soldQty > 0 && soldQty + unavailableQty >= totalQty) {
    nextStatus = 'Delivered';
  } else if (soldQty > 0) {
    nextStatus = 'Confirmed';
  }
  try {
    await updateDoc(doc(db, 'orders', id), {
      items: safeItems,
      status: nextStatus,
      updatedAt: serverTimestamp()
    });
    return { id, items: safeItems, status: nextStatus };
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `orders/${id}`);
  }
}

async function fetchMessages() {
  try {
    const snap = await getDocs(collection(db, 'messages'));
    return snap.docs
      .map((d) => ({ ...d.data(), id: d.data()?.id || d.id }))
      .sort((a, b) => (Number(a.createdAtMs) || 0) - (Number(b.createdAtMs) || 0));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'messages');
  }
}

async function sendContactMessage(msg) {
  const id = cleanSafeId(msg?.id || `MSG-${Date.now()}`, 'MSG');
  const payload = {
    id,
    name: String(msg?.name || '').trim().slice(0, 120),
    email: String(msg?.email || '').trim().slice(0, 254),
    subject: String(msg?.subject || '').trim().slice(0, 200),
    message: String(msg?.message || '').trim().slice(0, 4000),
    read: false,
    createdAtMs: Date.now(),
    createdAt: serverTimestamp()
  };
  try {
    await setDoc(doc(db, 'messages', id), payload);
    return payload;
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `messages/${id}`);
  }
}

async function updateMessageRead(msgId, read) {
  const id = cleanSafeId(msgId, 'MSG');
  try {
    await updateDoc(doc(db, 'messages', id), { read: Boolean(read) });
  } catch (err) {
    handleFirestoreError(err, OperationType.UPDATE, `messages/${id}`);
  }
}

async function deleteMessage(msgId) {
  const id = cleanSafeId(msgId, 'MSG');
  try {
    await deleteDoc(doc(db, 'messages', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `messages/${id}`);
  }
}

async function fetchRegisteredUsersCount() {
  try {
    const snap = await getDocs(collection(db, 'users'));
    return snap.size;
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'users');
  }
}

// ---------- Product & Category Page View Counters ----------
async function trackPageView({ type, targetId, label }) {
  if (!type || !targetId) return;
  const viewKey = type === 'product'
    ? productViewKey(targetId)
    : type === 'category'
      ? categoryViewKey(targetId)
      : 'site_total';
  const cleanTarget = String(targetId).trim().slice(0, 128);
  const cleanLabel = String(label || targetId).trim().slice(0, 160) || cleanTarget;
  const ref = doc(db, 'pageViews', viewKey);

  try {
    await updateDoc(ref, {
      views: increment(1),
      label: cleanLabel,
      updatedAt: serverTimestamp()
    });
  } catch (err) {
    const code = String(err?.code || '');
    if (code === 'not-found' || String(err?.message || '').toLowerCase().includes('no document to update')) {
      try {
        await setDoc(ref, {
          viewKey,
          type,
          targetId: cleanTarget,
          label: cleanLabel,
          views: 1,
          updatedAt: serverTimestamp()
        });
      } catch (createErr) {
        console.warn('[PageView Create]', viewKey, createErr?.message || createErr);
      }
    } else {
      console.warn('[PageView Update]', viewKey, err?.message || err);
    }
  }
}

async function fetchPageViews() {
  try {
    const snap = await getDocs(collection(db, 'pageViews'));
    const productViews = [];
    const categoryViews = [];
    let siteViews = 0;
    let totalProductViews = 0;
    let totalCategoryViews = 0;

    for (const d of snap.docs) {
      const data = d.data() || {};
      const views = Number(data.views) || 0;
      if (data.type === 'product') {
        productViews.push({
          viewKey: d.id,
          targetId: String(data.targetId || ''),
          label: String(data.label || data.targetId || ''),
          views
        });
        totalProductViews += views;
      } else if (data.type === 'category') {
        categoryViews.push({
          viewKey: d.id,
          targetId: String(data.targetId || ''),
          label: String(data.label || data.targetId || ''),
          views
        });
        totalCategoryViews += views;
      } else if (data.type === 'site') {
        siteViews += views;
      }
    }

    productViews.sort((a, b) => b.views - a.views);
    categoryViews.sort((a, b) => b.views - a.views);

    return {
      siteViews,
      totalProductViews,
      totalCategoryViews,
      productViews,
      categoryViews
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'pageViews');
  }
}

// ---------- Full MongoDB -> Firebase Migration ----------
async function migrateFromMongoExport(exportData, { uploadPhotoFn, onProgress } = {}) {
  const report = {
    products: 0,
    cloudinaryPhotos: 0,
    categories: 0,
    users: 0,
    credentials: 0,
    orders: 0,
    messages: 0,
    didYouKnow: 0
  };
  const step = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };

  // 1. Categories & Subcategories
  step('Migrating categories & subcategories…');
  const meta = exportData?.meta || {};
  await saveCategoriesMeta({
    list: Array.isArray(meta.list) ? meta.list : [],
    sizeCategories: Array.isArray(meta.sizeCategories) ? meta.sizeCategories : [],
    colorCategories: Array.isArray(meta.colorCategories) ? meta.colorCategories : [],
    subcategories: meta.subcategories && typeof meta.subcategories === 'object' ? meta.subcategories : {}
  });
  report.categories = Array.isArray(meta.list) ? meta.list.length : 0;

  // 2. Products (preserving Cloudinary or uploading new ones to Cloudinary)
  const rawProducts = Array.isArray(exportData?.products) ? exportData.products : [];
  for (let idx = 0; idx < rawProducts.length; idx++) {
    const raw = rawProducts[idx];
    const prodId = cleanSafeId(raw?.id, `prod_${idx}`);
    step(`Migrating product ${idx + 1} of ${rawProducts.length}: ${raw?.name || prodId}…`);

    let nextImage = String(raw?.image || '');
    let nextGallery = Array.isArray(raw?.gallery) ? [...raw.gallery] : [];

    if (typeof uploadPhotoFn === 'function') {
      const photos = [nextImage, ...nextGallery].filter(Boolean);
      const uploadedList = [];
      for (let pIdx = 0; pIdx < photos.length; pIdx++) {
        let src = photos[pIdx];
        if (typeof src === 'string' && src.startsWith('data:image/')) {
          try {
            const uploadedUrl = await uploadPhotoFn(prodId, pIdx, src);
            if (uploadedUrl && uploadedUrl.startsWith('http')) {
              src = uploadedUrl;
              report.cloudinaryPhotos++;
            } else {
              // Avoid storing oversized data URIs directly in Firestore; keep proxy URL fallback
              src = `/api/products/${encodeURIComponent(String(raw.id))}/photo/${pIdx}`;
            }
          } catch {
            src = `/api/products/${encodeURIComponent(String(raw.id))}/photo/${pIdx}`;
          }
        }
        uploadedList.push(src);
      }
      nextImage = uploadedList[0] || '';
      nextGallery = uploadedList.slice(1);
    } else if (nextImage.startsWith('data:image/')) {
      nextImage = `/api/products/${encodeURIComponent(String(raw.id))}/photo/0`;
      nextGallery = nextGallery.map((g, i) => (
        typeof g === 'string' && g.startsWith('data:image/')
          ? `/api/products/${encodeURIComponent(String(raw.id))}/photo/${i + 1}`
          : g
      ));
    }

    await saveProduct(prodId, {
      ...raw,
      id: prodId,
      image: nextImage,
      gallery: nextGallery
    });
    report.products++;
  }

  // 3. Users & Migrated Passwords (isolated credentials subcollection)
  const users = Array.isArray(exportData?.users) ? exportData.users : [];
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    const uid = cleanSafeId(u?.uid, `usr_${i}`);
    const email = String(u?.email || '').trim().toLowerCase();
    if (!email) continue;
    step(`Migrating user account ${i + 1} of ${users.length}…`);
    const createdAt = u.createdAtMs ? Timestamp.fromMillis(Number(u.createdAtMs)) : serverTimestamp();
    await setDoc(doc(db, 'users', uid), {
      uid,
      name: String(u.name || email.split('@')[0] || 'Customer').trim().slice(0, 120),
      email: email.slice(0, 254),
      isAdmin: Boolean(u.isAdmin || email === ADMIN_EMAIL),
      migratedFromMongo: true,
      createdAt,
      updatedAt: serverTimestamp()
    });
    report.users++;

    if (u.passwordHash && String(u.passwordHash).length >= 10) {
      await setDoc(doc(db, 'users', uid, 'private', 'credentials'), {
        uid,
        email: email.slice(0, 254),
        passwordHash: String(u.passwordHash).slice(0, 255),
        migratedFromMongo: true,
        updatedAt: serverTimestamp()
      });
      report.credentials++;
    }
  }

  // 4. Orders
  const orders = Array.isArray(exportData?.orders) ? exportData.orders : [];
  const validStatuses = new Set(['Awaiting WhatsApp confirmation', 'Confirmed', 'Delivered', 'Unavailable', 'Cancelled']);
  for (let i = 0; i < orders.length; i++) {
    const ord = orders[i];
    const ordId = cleanSafeId(ord?.id || `ORD-${Date.now()}-${i}`, 'ORD');
    const ordUid = cleanSafeId(ord?.uid || auth.currentUser?.uid || `legacy_${i}`, 'usr');
    const createdAtMs = Number(ord?.createdAtMs) || Date.now();
    const status = validStatuses.has(ord?.status) ? ord.status : 'Awaiting WhatsApp confirmation';
    await setDoc(doc(db, 'orders', ordId), {
      id: ordId,
      uid: ordUid,
      customer: String(ord?.customer || 'Customer').trim().slice(0, 120) || 'Customer',
      email: String(ord?.email || '').trim().slice(0, 254),
      date: String(ord?.date || new Date(createdAtMs).toLocaleDateString()).slice(0, 64),
      items: Array.isArray(ord?.items) && ord.items.length ? ord.items.slice(0, 100) : [{ name: 'Item', price: 0, quantity: 1 }],
      total: Math.max(0, Number(ord?.total) || 0),
      status,
      createdAtMs,
      createdAt: Timestamp.fromMillis(createdAtMs),
      updatedAt: serverTimestamp()
    });
    report.orders++;
  }

  // 5. Messages
  const messages = Array.isArray(exportData?.messages) ? exportData.messages : [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const msgId = cleanSafeId(m?.id || `MSG-${Date.now()}-${i}`, 'MSG');
    const createdAtMs = Number(m?.createdAtMs) || Date.now();
    await setDoc(doc(db, 'messages', msgId), {
      id: msgId,
      name: String(m?.name || 'Customer').trim().slice(0, 120) || 'Customer',
      email: String(m?.email || 'unknown@example.com').trim().slice(0, 254),
      subject: String(m?.subject || 'Message').trim().slice(0, 200) || 'Message',
      message: String(m?.message || '-').trim().slice(0, 4000) || '-',
      read: Boolean(m?.read),
      createdAtMs,
      createdAt: Timestamp.fromMillis(createdAtMs)
    });
    report.messages++;
  }

  // 6. Did You Know
  const dyk = Array.isArray(exportData?.didYouKnow) ? exportData.didYouKnow : [];
  for (let i = 0; i < dyk.length; i++) {
    const item = dyk[i];
    await saveDidYouKnow(item?.id || `DYK-${i}`, item);
    report.didYouKnow++;
  }

  // 7. Existing site views seed
  const priorViews = Number(exportData?.analytics?.totalViews) || 0;
  if (priorViews > 0) {
    await setDoc(doc(db, 'pageViews', 'site_total'), {
      viewKey: 'site_total',
      type: 'site',
      targetId: 'site',
      label: 'Total Website Views',
      views: Math.floor(priorViews),
      updatedAt: serverTimestamp()
    });
  }

  return report;
}

window.RKFirebase = {
  db,
  auth,
  config: firebaseConfig,
  onAuthChange,
  signInWithGoogle,
  signInWithEmail,
  registerWithEmail,
  sendPasswordReset,
  logout,
  getIdToken,
  updateProfileName,
  fetchStorefront,
  saveProduct,
  deleteProduct,
  saveCategoriesMeta,
  saveDidYouKnow,
  deleteDidYouKnow,
  fetchOrders,
  createOrder,
  updateOrderStatus,
  updateOrderItems,
  fetchMessages,
  sendContactMessage,
  updateMessageRead,
  deleteMessage,
  fetchRegisteredUsersCount,
  trackPageView,
  fetchPageViews,
  migrateFromMongoExport,
  categoryViewKey,
  productViewKey
};
