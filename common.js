// Shared storefront data (Firebase Firestore + Cloudinary photos + MongoDB migration fallback) and cart helpers.

const AUTH_TOKEN_KEY = 'rk_auth_token';

function hasFirebase() {
    return Boolean(typeof window !== 'undefined' && window.RKFirebase && window.RKFirebase.db && window.RKFirebase.auth);
}

function hasFirebaseUser() {
    return Boolean(hasFirebase() && window.RKFirebase.auth.currentUser);
}

// In-memory copy of the data, kept fresh by Firebase Firestore.
const store = {
    products: [],
    categories: [],
    sizeCategories: [],      // categories whose products have sizes
    colorCategories: [],     // categories whose products have colors
    subcategories: {},       // { [categoryName]: string[] }
    allOrders: [],      // admin only
    myOrders: [],       // signed-in customer's own orders
    messages: [],       // contact-form messages (admin only)
    adminStats: { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 },
    pageViews: { siteViews: 0, totalProductViews: 0, totalCategoryViews: 0, productViews: [], categoryViews: [] },
    mongoStatus: { available: false, products: 0, categories: 0, users: 0, orders: 0, messages: 0, didYouKnow: 0, cloudinaryConfigured: false },
    needsMongoMigration: false,
    migratingToFirebase: false,
    migrationProgress: '',
    mediaStatus: { cloudinaryConfigured: false, cloudName: '', legacyPhotoCount: 0 },
    authProviders: { googleEnabled: true, googleClientId: '', loaded: false },
    recentOrders: {},   // orders placed in this session
    user: null,         // { uid, name, email, isAdmin }
    loadError: false    // true when the product list could not be loaded
};

let inventoryViewMode = (() => {
    try {
        return localStorage.getItem('rk_inventory_view') === 'grid' ? 'grid' : 'list';
    } catch {
        return 'list';
    }
})();

function setInventoryView(mode) {
    inventoryViewMode = mode === 'grid' ? 'grid' : 'list';
    try {
        localStorage.setItem('rk_inventory_view', inventoryViewMode);
    } catch {
        // Ignore storage restrictions
    }
    renderAdmin('inventory');
}

let appReady = false;
let authSettled = false;
let syncCounter = 0;

function sameId(first, second) {
    return String(first ?? '') === String(second ?? '');
}

let toastTimer = null;
function showToast(message, type = 'info') {
    const el = document.getElementById('app-toast');
    if (!el) return;
    el.textContent = String(message || '');
    el.className = `app-toast${type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : ''}`;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, type === 'error' ? 5000 : 3200);
}

function askConfirm(message) {
    return new Promise(resolve => {
        const modal = document.getElementById('app-confirm-modal');
        const msgEl = document.getElementById('app-confirm-message');
        const okBtn = document.getElementById('app-confirm-ok');
        const cancelBtn = document.getElementById('app-confirm-cancel');
        if (!modal || !msgEl || !okBtn || !cancelBtn) {
            resolve(true);
            return;
        }
        msgEl.textContent = String(message || 'Are you sure?');
        modal.hidden = false;
        const finish = (answer) => {
            modal.hidden = true;
            okBtn.onclick = null;
            cancelBtn.onclick = null;
            modal.onclick = null;
            resolve(answer);
        };
        okBtn.onclick = () => finish(true);
        cancelBtn.onclick = () => finish(false);
        modal.onclick = (e) => { if (e.target === modal) finish(false); };
    });
}

function isImageFile(file) {
    if (!file) return false;
    if (file.type && file.type.startsWith('image/')) return true;
    return /\.(jpe?g|png|webp|gif|bmp|avif|svg|heic|heif)$/i.test(file.name || '');
}

function getAuthToken() {
    try {
        return localStorage.getItem(AUTH_TOKEN_KEY) || '';
    } catch {
        return '';
    }
}

function setAuthToken(token) {
    try {
        if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
        else localStorage.removeItem(AUTH_TOKEN_KEY);
    } catch {
        // Ignore storage restrictions
    }
}

function resolveAssetUrl(src) {
    const value = String(src || '').trim();
    if (!value) return '';
    if (value.startsWith('/assets/')) return `.${value}`;
    if (value.startsWith('/api/')) {
        const apiBase = String((typeof window !== 'undefined' && window.RK_API_BASE) || '').replace(/\/+$/, '');
        return apiBase ? `${apiBase}${value}` : `.${value}`;
    }
    return value;
}

function resolveApiUrl(url) {
    const raw = String(url || '');
    const apiBase = String((typeof window !== 'undefined' && window.RK_API_BASE) || '').replace(/\/+$/, '');
    if (apiBase && raw.startsWith('/')) return `${apiBase}${raw}`;
    if (raw.startsWith('/api/')) return `.${raw}`;
    return raw;
}

async function apiRequest(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    let token = '';
    if (hasFirebaseUser()) {
        try {
            token = await window.RKFirebase.getIdToken();
        } catch {
            token = '';
        }
    }
    if (!token) token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);

    let response;
    try {
        response = await fetch(resolveApiUrl(url), {
            method: options.method || 'GET',
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
            signal: controller.signal
        });
    } catch {
        const netErr = new Error('Network error. Check your connection and try again.');
        netErr.code = 'auth/network-request-failed';
        throw netErr;
    } finally {
        clearTimeout(timer);
    }

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const err = new Error(data.error || `Request failed (${response.status})`);
        err.status = response.status;
        err.code = data.code || `http/${response.status}`;
        throw err;
    }
    return data;
}

// Remove data the old localStorage version left behind (it held passwords in plain text).
['products', 'categories', 'users', 'allOrders', 'currentUser'].forEach(key => localStorage.removeItem(key));
Object.keys(localStorage)
    .filter(key => key.startsWith('orders_'))
    .forEach(key => localStorage.removeItem(key));

document.addEventListener('DOMContentLoaded', () => {
    updateCartCount();
});

// ---------- Data access ----------
function getProducts() { return store.products; }
function getSavedCategories() { return store.categories; }
function getSizeCategories() { return store.sizeCategories; }
function getColorCategories() { return store.colorCategories; }
function getSubcategoriesMap() { return store.subcategories && typeof store.subcategories === 'object' ? store.subcategories : {}; }
function getSubcategoriesFor(category) {
    const list = getSubcategoriesMap()[category];
    return Array.isArray(list) ? list : [];
}
function getCurrentUser() { return store.user; }
function getAllOrders() { return store.allOrders; }
function getMessages() { return store.messages; }
function getMyOrders() { return store.myOrders; }

function getOrderById(id) {
    return store.recentOrders[id]
        || store.allOrders.find(order => order.id === id)
        || store.myOrders.find(order => order.id === id);
}

function rememberOrder(order) {
    store.recentOrders[order.id] = order;
}

// ---------- Storefront sync ----------
async function loadStoreData({ silent = false } = {}) {
    if (hasFirebase()) {
        try {
            const fbData = await window.RKFirebase.fetchStorefront();
            const hasFbData = (fbData.products && fbData.products.length > 0)
                || (fbData.categories && fbData.categories.length > 0);
            if (hasFbData) {
                store.loadError = false;
                store.needsMongoMigration = false;
                store.products = Array.isArray(fbData.products) ? fbData.products : [];
                store.categories = Array.isArray(fbData.categories) ? fbData.categories : [];
                store.sizeCategories = Array.isArray(fbData.sizeCategories) ? fbData.sizeCategories : [];
                store.colorCategories = Array.isArray(fbData.colorCategories) ? fbData.colorCategories : [];
                store.subcategories = fbData.subcategories && typeof fbData.subcategories === 'object' ? fbData.subcategories : {};
                if (appReady && typeof refreshView === 'function') refreshView();
                return;
            }
        } catch (err) {
            console.warn('[Firestore Storefront]', err?.message || err);
        }
    }

    let attempts = 2;
    while (attempts > 0) {
        try {
            const storeData = await apiRequest('/api/store');
            store.loadError = false;
            store.products = Array.isArray(storeData.products) ? storeData.products : [];
            store.categories = Array.isArray(storeData.categories) ? storeData.categories : [];
            store.sizeCategories = Array.isArray(storeData.sizeCategories) ? storeData.sizeCategories : [];
            store.colorCategories = Array.isArray(storeData.colorCategories) ? storeData.colorCategories : [];
            store.subcategories = storeData.subcategories && typeof storeData.subcategories === 'object' ? storeData.subcategories : {};
            store.needsMongoMigration = hasFirebase() && (store.products.length > 0 || store.categories.length > 0);
            if (appReady && typeof refreshView === 'function') refreshView();
            return;
        } catch (error) {
            attempts--;
            if (attempts > 0) {
                await new Promise(resolve => setTimeout(resolve, 2000));
            } else {
                console.warn('Could not load storefront data:', error);
                if (!silent) {
                    store.loadError = true;
                    if (appReady && typeof refreshView === 'function') refreshView();
                }
            }
        }
    }
}

async function retryLoadStore(button) {
    if (button) {
        button.disabled = true;
        button.textContent = 'Loading…';
    }
    store.loadError = false;
    await loadStoreData({ silent: false });
    if (typeof renderPage === 'function') renderPage();
}

async function loadUserCollections(user) {
    if (!user) {
        store.allOrders = [];
        store.myOrders = [];
        store.messages = [];
        store.adminStats = { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
        store.pageViews = { siteViews: 0, totalProductViews: 0, totalCategoryViews: 0, productViews: [], categoryViews: [] };
        store.mongoStatus = { available: false, products: 0, categories: 0, users: 0, orders: 0, messages: 0, didYouKnow: 0, cloudinaryConfigured: false };
        return;
    }

    if (hasFirebaseUser()) {
        try {
            const orders = await window.RKFirebase.fetchOrders(user);
            if (user.isAdmin) {
                store.allOrders = Array.isArray(orders) ? orders : [];
                store.myOrders = [];
            } else {
                store.myOrders = Array.isArray(orders) ? orders : [];
                store.allOrders = [];
            }
        } catch (error) {
            console.warn('Could not load Firestore orders:', error);
        }

        if (user.isAdmin) {
            const [messagesRes, pageViewsRes, usersCountRes, statsRes, mongoRes, mediaRes] = await Promise.allSettled([
                window.RKFirebase.fetchMessages(),
                window.RKFirebase.fetchPageViews(),
                window.RKFirebase.fetchRegisteredUsersCount(),
                apiRequest('/api/admin/stats'),
                apiRequest('/api/admin/mongodb-status'),
                apiRequest('/api/admin/media-status')
            ]);

            if (messagesRes.status === 'fulfilled') {
                store.messages = Array.isArray(messagesRes.value) ? messagesRes.value : [];
            }
            if (pageViewsRes.status === 'fulfilled' && pageViewsRes.value) {
                store.pageViews = pageViewsRes.value;
            }
            const fbUsersCount = usersCountRes.status === 'fulfilled' ? Number(usersCountRes.value) || 0 : 0;
            const apiStats = statsRes.status === 'fulfilled' ? statsRes.value : null;
            const siteViews = Number(store.pageViews?.siteViews) || 0;
            store.adminStats = {
                registeredUsers: Math.max(fbUsersCount, Number(apiStats?.registeredUsers) || 0),
                websiteVisitors: Number(apiStats?.websiteVisitors) || 0,
                totalViews: Math.max(siteViews, Number(apiStats?.totalViews) || 0)
            };
            if (mongoRes.status === 'fulfilled' && mongoRes.value) {
                store.mongoStatus = mongoRes.value;
            }
            if (mediaRes.status === 'fulfilled' && mediaRes.value) {
                store.mediaStatus = {
                    cloudinaryConfigured: Boolean(mediaRes.value.cloudinaryConfigured),
                    cloudName: String(mediaRes.value.cloudName || ''),
                    legacyPhotoCount: Number(mediaRes.value.legacyPhotoCount) || 0
                };
            }
        } else {
            store.messages = [];
            store.adminStats = { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
            store.pageViews = { siteViews: 0, totalProductViews: 0, totalCategoryViews: 0, productViews: [], categoryViews: [] };
            store.mediaStatus = { cloudinaryConfigured: false, cloudName: '', legacyPhotoCount: 0 };
        }
        return;
    }

    try {
        const ordersData = await apiRequest('/api/orders');
        const orders = Array.isArray(ordersData.orders) ? ordersData.orders : [];
        if (user.isAdmin) {
            store.allOrders = orders;
            store.myOrders = [];
        } else {
            store.myOrders = orders;
            store.allOrders = [];
        }
    } catch (error) {
        console.warn('Could not load orders:', error);
    }
    if (user.isAdmin) {
        try {
            const messagesData = await apiRequest('/api/messages');
            store.messages = Array.isArray(messagesData.messages) ? messagesData.messages : [];
        } catch (error) {
            console.warn('Could not load messages:', error);
        }
        try {
            const statsData = await apiRequest('/api/admin/stats');
            store.adminStats = {
                registeredUsers: Number(statsData.registeredUsers) || 0,
                websiteVisitors: Number(statsData.websiteVisitors) || 0,
                totalViews: Number(statsData.totalViews) || 0
            };
        } catch (error) {
            console.warn('Could not load admin stats:', error);
        }
        try {
            const mongoData = await apiRequest('/api/admin/mongodb-status');
            if (mongoData) store.mongoStatus = mongoData;
        } catch {
            // Optional
        }
        try {
            const mediaData = await apiRequest('/api/admin/media-status');
            store.mediaStatus = {
                cloudinaryConfigured: Boolean(mediaData.cloudinaryConfigured),
                cloudName: String(mediaData.cloudName || ''),
                legacyPhotoCount: Number(mediaData.legacyPhotoCount) || 0
            };
        } catch {
            // Optional endpoint
        }
    } else {
        store.messages = [];
        store.adminStats = { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
        store.mediaStatus = { cloudinaryConfigured: false, cloudName: '', legacyPhotoCount: 0 };
    }
}

async function syncSession({ redraw = false } = {}) {
    const token = ++syncCounter;
    const authToken = getAuthToken();
    if (!authToken) {
        store.user = null;
        store.allOrders = [];
        store.myOrders = [];
        store.messages = [];
        authSettled = true;
        if (redraw && appReady && typeof renderPage === 'function') renderPage();
        return null;
    }

    try {
        const data = await apiRequest('/api/auth/me');
        if (token !== syncCounter) return store.user;
        store.user = data.user || null;
        if (!store.user) setAuthToken('');
    } catch (error) {
        console.warn('Could not check login status:', error);
        if (token !== syncCounter) return store.user;
        store.user = null;
    }

    if (store.user) {
        await loadUserCollections(store.user);
    } else {
        store.allOrders = [];
        store.myOrders = [];
        store.messages = [];
    }

    if (token !== syncCounter) return store.user;
    authSettled = true;
    if (redraw && appReady && typeof renderPage === 'function') renderPage();
    return store.user;
}

const authReady = hasFirebase()
    ? new Promise(resolve => {
        let initialResolved = false;
        window.RKFirebase.onAuthChange(async (fbProfile) => {
            if (fbProfile) {
                store.user = fbProfile;
                authSettled = true;
                await loadUserCollections(store.user);
                if (!initialResolved) {
                    initialResolved = true;
                    resolve(store.user);
                }
                if (appReady && typeof renderPage === 'function') renderPage();
            } else {
                const legacyToken = getAuthToken();
                if (legacyToken) {
                    const user = await syncSession({ redraw: appReady });
                    if (!initialResolved) {
                        initialResolved = true;
                        resolve(user);
                    }
                } else {
                    store.user = null;
                    await loadUserCollections(null);
                    authSettled = true;
                    if (!initialResolved) {
                        initialResolved = true;
                        resolve(null);
                    }
                    if (appReady && typeof renderPage === 'function') renderPage();
                }
            }
        });
    })
    : syncSession({ redraw: true });

// The shop waits only for the product list, never for login, so visitors who are not
// logged in see the goods straight away.
const dataReady = Promise.race([
    loadStoreData(),
    new Promise(resolve => setTimeout(() => {
        console.warn('Storefront is slow to respond; showing the shop with what has loaded.');
        resolve();
    }, 45000))
]);

async function logout() {
    setAuthToken('');
    store.user = null;
    await loadUserCollections(null);
    document.body.classList.remove('is-admin-view');
    if (hasFirebase()) {
        await window.RKFirebase.logout().catch(() => {});
    }
    apiRequest('/api/auth/logout', { method: 'POST' }).catch(() => {});
    window.location.hash = '#/home';
    if (appReady && typeof renderPage === 'function') renderPage();
}

// ---------- Cart ----------
function getCart() {
    try {
        return JSON.parse(localStorage.getItem('cart')) || [];
    } catch (error) {
        return [];
    }
}

function saveCart(cart) {
    localStorage.setItem('cart', JSON.stringify(cart));
    updateCartCount();
}

function addToCart(productId, quantity = 1, options = {}) {
    const product = getProducts().find(p => sameId(p.id, productId));
    if (!product) return false;

    const safeQuantity = Math.max(1, Number.parseInt(quantity, 10) || 1);
    const selectedOptions = Object.fromEntries(
        Object.entries(options).sort(([first], [second]) => first.localeCompare(second))
    );
    const optionsKey = JSON.stringify(selectedOptions);
    const cart = getCart();
    const existingItem = cart.find(item =>
        sameId(item.id, productId) &&
        JSON.stringify(Object.fromEntries(
            Object.entries(item.options || {}).sort(([first], [second]) => first.localeCompare(second))
        )) === optionsKey
    );

    if (existingItem) {
        existingItem.quantity = Number(existingItem.quantity) + safeQuantity;
    } else {
        // The extra gallery photos stay out of the cart so it remains small.
        const { gallery, ...cartProduct } = product;
        cart.push({ ...cartProduct, options: selectedOptions, quantity: safeQuantity });
    }

    saveCart(cart);
    return true;
}

// ---------- Promotion & Bulk pricing ----------
function hasPromo(product) {
    if (!product || product.promoPrice === undefined || product.promoPrice === null || product.promoPrice === '') return false;
    const promoPrice = Number(product.promoPrice);
    const normalPrice = Number(product.price);
    return Number.isFinite(promoPrice) && promoPrice >= 0 && Number.isFinite(normalPrice) && promoPrice < normalPrice;
}

function baseUnitPrice(product) {
    return hasPromo(product) ? Number(product.promoPrice) : (Number(product?.price) || 0);
}

// A product can have a lower "bulk price" that applies when the cart holds at least
// `bulkMinQty` of it (all colors and sizes of that product are counted together).
function hasBulk(product) {
    if (!product || product.bulkPrice === undefined || product.bulkPrice === null) return false;
    const bulkPrice = Number(product.bulkPrice);
    const minQty = Number(product.bulkMinQty);
    return Number.isFinite(bulkPrice) && bulkPrice >= 0 && bulkPrice < Number(product.price)
        && Number.isFinite(minQty) && minQty >= 2;
}

function cartQuantityFor(productId, cart = getCart()) {
    return cart
        .filter(item => sameId(item.id, productId))
        .reduce((total, item) => total + (Number(item.quantity) || 0), 0);
}

function bulkApplies(item, cart = getCart()) {
    return hasBulk(item) && cartQuantityFor(item.id, cart) >= Number(item.bulkMinQty);
}

function cartUnitPrice(item, cart = getCart()) {
    const base = baseUnitPrice(item);
    if (bulkApplies(item, cart)) {
        return Math.min(base, Number(item.bulkPrice));
    }
    return base;
}

function cartTotal(cart = getCart()) {
    return cart.reduce((sum, item) => sum + cartUnitPrice(item, cart) * (Number(item.quantity) || 0), 0);
}

function updateCartCount() {
    const cart = getCart();
    const count = cart.reduce((total, item) => total + item.quantity, 0);
    const cartCountElement = document.getElementById('cart-count');
    if (cartCountElement) {
        cartCountElement.textContent = count > 99 ? '99+' : String(count);
        cartCountElement.classList.toggle('is-empty', count === 0);
    }
    if (typeof syncCartButtons === 'function') syncCartButtons();
}


// =====================================================================
// Page rendering, routing and actions (previously inline in index.html)
// =====================================================================

const app = document.getElementById('app');
const loadingMarkup = app.innerHTML; // the placeholder cards written in index.html
const brand = document.querySelector('.logo').textContent.trim();
let lastAdminTab = 'overview';
let lastDashboardTab = 'profile';
const currency = new Intl.NumberFormat('en-ZM', { maximumFractionDigits: 2 });

function formatMoney(value) {
    return `K${currency.format(Number(value) || 0)}`;
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
}

function routeInfo() {
    const [path = '/home', query = ''] = location.hash.slice(1).split('?');
    return { page: path.replace(/^\/+/, '') || 'home', params: new URLSearchParams(query) };
}

function togglePassword(id, button) {
    const input = document.getElementById(id);
    const visible = input.type === 'password';
    input.type = visible ? 'text' : 'password';
    button.setAttribute('aria-pressed', String(visible));
    const fieldName = id === 'card-cvv' ? 'security code' : id.includes('confirm') ? 'confirm password' : 'password';
    button.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} ${fieldName}`);
}

function toggleMenu(forceClose = false) {
    const menu = document.getElementById('primary-navigation');
    const button = document.getElementById('menu-toggle');
    if (!menu || !button) return;
    const isOpen = !forceClose && !menu.classList.contains('is-open');
    menu.classList.toggle('is-open', isOpen);
    button.setAttribute('aria-expanded', String(isOpen));
    button.setAttribute('aria-label', isOpen ? 'Close navigation menu' : 'Open navigation menu');
}

function updateBottomNav(page) {
    let activeKey = '';
    if (['profile', 'dashboard', 'admin', 'login', 'register', 'forgot-password', 'reset-password'].includes(page)) {
        activeKey = 'profile';
    } else if (page === 'search') {
        activeKey = 'search';
    } else if (['home', 'product', 'category'].includes(page)) {
        activeKey = 'home';
    }
    document.querySelectorAll('.bottom-nav-item[data-nav]').forEach(item => {
        const active = item.dataset.nav === activeKey;
        item.classList.toggle('is-active', active);
        if (item.tagName === 'A') {
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        }
    });
    const topCart = document.getElementById('top-cart-link');
    if (topCart) {
        const cartActive = ['cart', 'checkout', 'success'].includes(page);
        topCart.classList.toggle('is-active', cartActive);
        if (cartActive) topCart.setAttribute('aria-current', 'page');
        else topCart.removeAttribute('aria-current');
    }
}

// Fixed pages live in index.html as <template> blocks; this just shows one.
function showTemplate(id) {
    app.replaceChildren(document.getElementById(id).content.cloneNode(true));
}

function hasOptions(product) {
    return !!product.options && typeof product.options === 'object'
        && Object.values(product.options).some(values => Array.isArray(values) && values.length);
}

function getProductPhotos(product) {
    return [product.image, ...(Array.isArray(product.gallery) ? product.gallery : [])].filter(Boolean);
}

function cartSummaryMarkup(productId) {
    const lines = getCart().filter(item => sameId(item.id, productId));
    if (!lines.length) return '';
    return `<p class="cart-summary-title">In your cart</p>
        <ul class="cart-summary-list">${lines.map(item => {
            const details = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
            return `<li>${Number(item.quantity)} × ${escapeHtml(details || item.name)}</li>`;
        }).join('')}</ul>
        <a href="#/cart" class="btn btn-outline btn-small">View Cart</a>`;
}

function priceDisplayMarkup(product) {
    if (hasPromo(product)) {
        return `<span class="price-original">${formatMoney(product.price)}</span><span class="price-promo">${formatMoney(product.promoPrice)}</span>`;
    }
    return formatMoney(product.price);
}

function productCard(product) {
    const needsOptions = hasOptions(product);
    const inCart = isInCart(product.id);
    const idleText = needsOptions ? 'Select Options' : 'Add to Cart';
    const safeId = escapeHtml(String(product.id));
    return `<article class="product-card">
        <div class="product-image"><a href="#/product?id=${encodeURIComponent(product.id)}"><img src="${escapeHtml(resolveAssetUrl(product.image))}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async"></a></div>
        <div class="product-info">
            <div><h3 class="product-title">${escapeHtml(product.name)}</h3><p class="product-price${hasPromo(product) ? ' has-promo' : ''}">${priceDisplayMarkup(product)}</p>${bulkLineMarkup(product)}</div>
            <button class="btn btn-full${inCart ? ' is-added' : ''}" data-cart-id="${safeId}" data-original-text="${idleText}" onclick="addToCartFromButton('${safeId}')">${inCart ? 'Added to Cart ✓' : idleText}</button>
        </div>
    </article>`;
}

function renderProductOptions(product) {
    if (!product.options || typeof product.options !== 'object') return '';
    return Object.entries(product.options).map(([name, values], index) => {
        if (!Array.isArray(values) || !values.length) return '';
        const id = `product-option-${index}`;
        return `<div class="form-group product-option">
            <label for="${id}">${escapeHtml(name)}</label>
            <select id="${id}" data-option-name="${escapeHtml(name)}">
                <option value="" selected disabled>Select ${escapeHtml(name.toLowerCase())}</option>
                ${values.map(value => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`).join('')}
            </select>
        </div>`;
    }).join('');
}

function bulkLineMarkup(product) {
    return hasBulk(product)
        ? `<p class="product-bulk">${formatMoney(product.bulkPrice)} each for ${Number(product.bulkMinQty)}+</p>`
        : '';
}

// Products grouped by category: one grid per category, in category order, with no headings.
function productSectionsMarkup(products) {
    const names = getCategories(products);
    const groups = names
        .map(name => products.filter(product => product.category === name))
        .filter(group => group.length);
    const uncategorized = products.filter(product => !product.category);
    if (uncategorized.length) groups.push(uncategorized);
    return groups.map(group => `<div class="category-section"><div class="product-grid">${group.map(productCard).join('')}</div></div>`).join('');
}

// The banner lives in index.html; its letters animate the first time it is drawn,
// but not again when the shop refreshes itself with new data.
let heroPlayed = false;

function heroMarkup() {
    const markup = document.getElementById('tpl-hero').innerHTML;
    const result = heroPlayed ? markup.replace('class="hero"', 'class="hero is-static"') : markup;
    heroPlayed = true;
    return result;
}

let lastTrackedViewSignature = '';

function recordRouteView(type, targetId, label) {
    if (!hasFirebase() || !type || !targetId) return;
    const signature = `${type}:${String(targetId).toLowerCase()}`;
    if (signature === lastTrackedViewSignature) return;
    lastTrackedViewSignature = signature;
    window.RKFirebase.trackPageView({ type, targetId: String(targetId), label: String(label || targetId) }).catch(() => {});
}

function renderHome() {
    const products = getProducts();
    const categories = getCategories(products);
    const categoryBar = categories.length
        ? `<nav class="home-category-bar" aria-label="Shop by category">
            <a href="#/home" class="home-cat-link is-active">All</a>
            ${categories.map(cat => `<a href="#/category?name=${encodeURIComponent(cat)}" class="home-cat-link">${escapeHtml(cat)}</a>`).join('')}
        </nav>`
        : '';
    app.innerHTML = `${heroMarkup()}
    <section class="shop-section">
        <h2 class="section-title">Our Products</h2>
        ${categoryBar}
        ${products.length
            ? productSectionsMarkup(products)
            : (store.loadError
                ? '<div class="empty-state"><p>Products could not be loaded right now. Please check your connection or database configuration and try again.</p><button type="button" class="btn mt-20" onclick="retryLoadStore(this)">Retry Loading Products</button></div>'
                : '<p>No products available yet.</p>')}
    </section>`;
}

function renderCategory() {
    const params = routeInfo().params;
    const rawName = (params.get('name') || '').trim();
    const activeSub = (params.get('sub') || '').trim();
    const categories = getCategories();
    const matchedCategory = categories.find(c => c.toLowerCase() === rawName.toLowerCase()) || rawName;

    if (!matchedCategory) {
        location.hash = '#/home';
        return;
    }

    document.title = `${matchedCategory} | ${brand}`;
    const allProducts = getProducts();
    const inCategory = allProducts.filter(p => String(p.category || '').toLowerCase() === matchedCategory.toLowerCase());
    const subs = getSubcategoriesFor(matchedCategory);
    const filtered = activeSub
        ? inCategory.filter(p => String(p.subcategory || '').toLowerCase() === activeSub.toLowerCase())
        : inCategory;

    recordRouteView('category', matchedCategory, matchedCategory);

    const categoryNav = categories.length
        ? `<nav class="home-category-bar" aria-label="Categories">
            <a href="#/home" class="home-cat-link">All</a>
            ${categories.map(cat => `<a href="#/category?name=${encodeURIComponent(cat)}" class="home-cat-link${cat.toLowerCase() === matchedCategory.toLowerCase() ? ' is-active' : ''}">${escapeHtml(cat)}</a>`).join('')}
        </nav>`
        : '';

    const subBar = subs.length
        ? `<div class="category-sub-bar" aria-label="Filter by subcategory">
            <a href="#/category?name=${encodeURIComponent(matchedCategory)}" class="category-sub-link${!activeSub ? ' is-active' : ''}">All ${escapeHtml(matchedCategory)}</a>
            ${subs.map(sub => `<a href="#/category?name=${encodeURIComponent(matchedCategory)}&sub=${encodeURIComponent(sub)}" class="category-sub-link${activeSub.toLowerCase() === sub.toLowerCase() ? ' is-active' : ''}">${escapeHtml(sub)}</a>`).join('')}
        </div>`
        : '';

    app.innerHTML = `<section class="category-page">
        <div class="category-page-head">
            <div>
                <a href="#/home" class="category-back-link">← All Products</a>
                <h1 class="section-title">${escapeHtml(matchedCategory)}</h1>
                <p class="category-page-count">${filtered.length} ${filtered.length === 1 ? 'product' : 'products'}</p>
            </div>
        </div>
        ${categoryNav}
        ${subBar}
        ${filtered.length
            ? `<div class="product-grid">${filtered.map(productCard).join('')}</div>`
            : `<div class="empty-state"><p>No products found in ${escapeHtml(matchedCategory)}${activeSub ? ` / ${escapeHtml(activeSub)}` : ''} yet.</p><a href="#/home" class="btn mt-20">Browse All Products</a></div>`}
    </section>`;
}

function searchResultsMarkup(query) {
    const trimmed = String(query || '').trim();
    const products = getProducts();
    if (!trimmed) {
        return `<div class="text-center empty-state">
            <h2>Search RK CONNEKT</h2>
            <p class="mt-20">Type a product name, category, or keyword above to find what you need.</p>
        </div>`;
    }
    const normalizedQuery = trimmed.toLowerCase();
    const matches = products.filter(product => [product.name, product.category, product.subcategory, product.description]
        .some(value => String(value || '').toLowerCase().includes(normalizedQuery)));
    if (!matches.length) {
        return `<div class="text-center empty-state">
            <h2>No products found for "${escapeHtml(trimmed)}".</h2>
            <button type="button" class="btn btn-outline mt-20" onclick="clearSearchQuery()">Clear Search</button>
        </div>`;
    }
    return `<p class="search-results-meta">${matches.length} result${matches.length === 1 ? '' : 's'} for "${escapeHtml(trimmed)}"</p>
        ${productSectionsMarkup(matches)}`;
}

function handleLiveSearch(value) {
    const container = document.getElementById('search-results');
    if (container) container.innerHTML = searchResultsMarkup(value);
    const normalized = String(value || '').trim().toLowerCase();
    document.querySelectorAll('.search-chip').forEach(chip => {
        chip.classList.toggle('is-active', chip.dataset.category.toLowerCase() === normalized);
    });
}

function pickSearchCategory(category) {
    const input = document.getElementById('search-input');
    if (input) input.value = category;
    location.hash = `#/search?q=${encodeURIComponent(category)}`;
}

function clearSearchQuery() {
    const input = document.getElementById('search-input');
    if (input) {
        input.value = '';
        input.focus();
    }
    if (routeInfo().params.get('q')) {
        location.hash = '#/search';
    } else {
        handleLiveSearch('');
    }
}

function renderSearch() {
    const query = routeInfo().params.get('q') || '';
    const categories = getCategories();
    const normalized = query.trim().toLowerCase();
    const matchedCat = normalized ? categories.find(cat => cat.toLowerCase() === normalized) : '';
    if (matchedCat) {
        recordRouteView('category', matchedCat, matchedCat);
    }
    app.innerHTML = `<section class="search-page">
        <h1 class="section-title">Search</h1>
        <div class="search-page-box">
            <form class="search-form" onsubmit="searchProducts(event)">
                <input type="search" id="search-input" value="${escapeHtml(query)}" placeholder="Search products..." aria-label="Search products" oninput="handleLiveSearch(this.value)">
                <button class="btn" type="submit">Search</button>
            </form>
            ${categories.length ? `<div class="search-page-chips" aria-label="Filter by category">${categories.map(cat => `<button type="button" class="search-chip${cat.toLowerCase() === normalized ? ' is-active' : ''}" data-category="${escapeHtml(cat)}" onclick="pickSearchCategory(this.dataset.category)">${escapeHtml(cat)}</button>`).join('')}</div>` : ''}
        </div>
        <div id="search-results">${searchResultsMarkup(query)}</div>
    </section>`;
    if (!query) {
        const input = document.getElementById('search-input');
        if (input) input.focus();
    }
}

function showProductPhoto(index) {
    const thumbs = [...document.querySelectorAll('.gallery-thumb')];
    const main = document.getElementById('detail-main-image');
    const target = thumbs[index]?.querySelector('img');
    if (!main || !target) return;
    main.src = target.src;
    thumbs.forEach((thumb, position) => {
        thumb.classList.toggle('is-active', position === index);
        thumb.setAttribute('aria-current', String(position === index));
    });
}

function renderProduct() {
    const id = routeInfo().params.get('id');
    const product = getProducts().find(item => String(item.id) === id);
    if (!product) {
        app.innerHTML = '<div class="empty-state"><h1>Product not found.</h1><a class="btn mt-20" href="#/home">Back to shop</a></div>';
        return;
    }
    document.title = `${product.name} | ${brand}`;
    recordRouteView('product', String(product.id), product.name);
    const photos = getProductPhotos(product);
    const productId = String(product.id);
    const safeId = escapeHtml(productId);
    const inCart = isInCart(productId);
    const categoryText = escapeHtml(product.category || 'General');
    const categoryLink = product.category
        ? `<a class="detail-category-link" href="#/category?name=${encodeURIComponent(product.category)}">${categoryText}</a>${product.subcategory ? ` / ${escapeHtml(product.subcategory)}` : ''}`
        : categoryText;
    app.innerHTML = `<div class="product-detail-container">
        <div class="detail-image">
            <img id="detail-main-image" src="${escapeHtml(resolveAssetUrl(photos[0] || ''))}" alt="${escapeHtml(product.name)}" decoding="async">
            ${photos.length > 1 ? `<div class="gallery-thumbs">${photos.map((src, index) => `<button type="button" class="gallery-thumb${index === 0 ? ' is-active' : ''}" aria-label="Show photo ${index + 1} of ${photos.length}" onclick="showProductPhoto(${index})"><img src="${escapeHtml(resolveAssetUrl(src))}" alt="" loading="lazy" decoding="async"></button>`).join('')}</div>` : ''}
        </div>
        <div class="detail-info">
            <p class="eyebrow">${categoryLink}</p>
            <h1>${escapeHtml(product.name)}</h1>
            <p class="detail-price${hasPromo(product) ? ' has-promo' : ''}">${priceDisplayMarkup(product)}</p>
            ${hasBulk(product) ? `<p class="detail-bulk">Buy ${Number(product.bulkMinQty)} or more: <strong>${formatMoney(product.bulkPrice)}</strong> each</p>` : ''}
            <p class="detail-desc">${escapeHtml(product.description || 'No description available.')}</p>
            <div class="product-options">${renderProductOptions(product)}</div>
            <div class="detail-actions"><label for="product-qty">Quantity</label><input type="number" id="product-qty" value="1" min="1"><button class="btn${inCart ? ' is-added' : ''}" data-cart-id="${safeId}" data-original-text="Add to Cart" onclick="addProductQuantity('${safeId}')">${inCart ? 'Added to Cart ✓' : 'Add to Cart'}</button><button class="btn btn-outline whatsapp-order-button" onclick="orderProductViaWhatsApp('${safeId}')">Order via WhatsApp</button></div>
            <div id="product-cart-summary" class="product-cart-summary" data-product-id="${safeId}">${cartSummaryMarkup(productId)}</div>
        </div>
    </div>`;
}

function renderCart() {
    const cart = getCart();
    if (!cart.length) {
        app.innerHTML = '<div class="text-center empty-state"><h1>Your cart is empty.</h1><a href="#/home" class="btn mt-20">Go Shopping</a></div>';
        return;
    }
    const total = cartTotal(cart);
    app.innerHTML = `<h1 class="section-title mt-20">Shopping Cart</h1>
        <div class="cart-list">
            ${cart.map((item, index) => {
                const sizeOption = Object.entries(item.options || {})
                    .find(([name]) => name.toLowerCase() === 'size')?.[1];
                const size = String(item.size || sizeOption || '').trim();
                const color = String(Object.entries(item.options || {})
                    .find(([name]) => name.toLowerCase() === 'color')?.[1] || '').trim();
                const quantity = Math.max(1, Number.parseInt(item.quantity, 10) || 1);
                const unitPrice = cartUnitPrice(item, cart);
                return `<article class="cart-row">
                    <div class="cart-row-main">
                        <div class="cart-product">
                            <img src="${escapeHtml(resolveAssetUrl(item.image))}" alt="${escapeHtml(item.name)}" class="cart-product-image">
                            <div class="cart-product-details">
                                <h2 class="cart-product-name">${escapeHtml(item.name)}</h2>
                                <p class="cart-unit-price">${formatMoney(unitPrice)} <span>each</span>${bulkApplies(item, cart) ? ' <span class="bulk-tag">Bulk price</span>' : ''}</p>
                            </div>
                        </div>
                        <div class="cart-row-actions">
                            ${color ? `<span class="cart-size-badge">Color: ${escapeHtml(color)}</span>` : ''}
                            ${size ? `<span class="cart-size-badge">Size: ${escapeHtml(size)}</span>` : ''}
                            <div class="cart-quantity-control" aria-label="Quantity controls for ${escapeHtml(item.name)}">
                                <button type="button" aria-label="Decrease quantity of ${escapeHtml(item.name)}" onclick="decreaseCartQuantity(${index})">−</button>
                                <span aria-live="polite">${quantity}</span>
                                <button type="button" aria-label="Increase quantity of ${escapeHtml(item.name)}" onclick="increaseCartQuantity(${index})">+</button>
                            </div>
                            <p class="cart-row-total">Subtotal: <strong>${formatMoney(quantity * unitPrice)}</strong></p>
                        </div>
                    </div>
                    <div class="cart-row-remove-wrap">
                        <button type="button" class="cart-row-remove" onclick="removeCartItem(${index})" aria-label="Remove ${escapeHtml(item.name)} from cart">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="m9 7 .5 12m5-12-.5 12M4 5h16M10 5V3h4v2m4 0-.8 14.2a2 2 0 0 1-2 1.8H8.8a2 2 0 0 1-2-1.8L6 5"/></svg>
                            Remove
                        </button>
                    </div>
                </article>`;
            }).join('')}
        </div>
        <div class="cart-summary"><div class="summary-row"><span>Subtotal</span><span>${formatMoney(total)}</span></div><div class="summary-row"><span>Shipping</span><span>Free</span></div><div class="summary-total summary-row"><span>Total</span><span>${formatMoney(total)}</span></div><a href="#/checkout" class="btn btn-full mt-20">Checkout via WhatsApp</a></div>`;
}

function renderCheckout() {
    const cart = getCart();
    if (!cart.length) {
        location.hash = '#/home';
        return;
    }
    const total = cartTotal(cart);
    app.innerHTML = `<h1 class="section-title mt-20">Checkout</h1>
        <div class="checkout-grid whatsapp-checkout-grid"><section class="checkout-section">
            <h2>Order Summary</h2>
            ${cart.map(item => {
                const options = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
                return `<div class="order-summary-item"><span>${escapeHtml(item.name)} × ${Number(item.quantity)}${options ? `<small class="order-options">${escapeHtml(options)}</small>` : ''}</span><span>${formatMoney(cartUnitPrice(item, cart) * Number(item.quantity))}</span></div>`;
            }).join('')}
            <div class="summary-total summary-row"><span>Total</span><span>${formatMoney(total)}</span></div>
            <p class="payment-note">You'll confirm delivery and payment details with the admin on WhatsApp. No payment information is collected on this website.</p>
            <button type="button" class="btn btn-full mt-20" onclick="processOrder()">Confirm Order on WhatsApp</button>
            <a href="#/cart" class="btn btn-outline btn-full mt-20">Back to Cart</a>
        </section></div>`;
}

function renderOrderSuccess() {
    const orderId = routeInfo().params.get('id') || '';
    const order = getOrderById(orderId);
    const whatsappUrl = order ? `https://wa.me/260961005957?text=${encodeURIComponent(formatOrderMessage(order))}` : '';
    app.innerHTML = `<div class="text-center empty-state"><div class="success-mark" aria-hidden="true">✓</div><h1>Order Confirmed!</h1>
        <p class="mb-20">Thank you for your purchase. Your order <strong>${escapeHtml(orderId)}</strong> is being processed.</p><p>Your order details are saved in the admin dashboard.</p>
        ${whatsappUrl ? `<p class="whatsapp-note">Continue to WhatsApp to share your order with the admin. You will need to press Send in WhatsApp.</p><a class="btn whatsapp-button" href="${whatsappUrl}" target="_blank" rel="noopener noreferrer">Share Order on WhatsApp</a>` : ''}
        <div class="mt-20"><a href="#/home" class="btn">Continue Shopping</a> <a href="#/dashboard" class="btn btn-outline">View Profile</a></div></div>`;
}

function renderLegal() {
    showTemplate('tpl-legal');
    const section = routeInfo().params.get('section');
    if (section) document.getElementById(section)?.scrollIntoView();
}

function profileQuickLinksMarkup() {
    return `<section class="profile-links-card" aria-label="Store information and legal">
        <p class="profile-links-title">Store Info &amp; Help</p>
        <div class="profile-links-grid">
            <a href="#/about" class="profile-quick-link"><span>About Us</span><span aria-hidden="true">→</span></a>
            <a href="#/contact" class="profile-quick-link"><span>Contact</span><span aria-hidden="true">→</span></a>
            <a href="#/faq" class="profile-quick-link"><span>FAQ</span><span aria-hidden="true">→</span></a>
        </div>
        <p class="profile-links-title profile-links-subhead">Legal &amp; Policies</p>
        <div class="profile-links-grid">
            <a href="#/legal?section=privacy" class="profile-quick-link"><span>Privacy Policy</span><span aria-hidden="true">→</span></a>
            <a href="#/legal?section=terms" class="profile-quick-link"><span>Terms of Service</span><span aria-hidden="true">→</span></a>
            <a href="#/legal?section=returns" class="profile-quick-link"><span>Returns Policy</span><span aria-hidden="true">→</span></a>
        </div>
    </section>`;
}

function userInitials(user) {
    const source = String(user?.name || user?.email || 'U').trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
}

function renderDashboard(tab = 'profile') {
    lastDashboardTab = tab;
    const user = getCurrentUser();
    if (!user) {
        app.innerHTML = `<section class="profile-page">
            <div class="profile-guest-card">
                <div class="profile-avatar" aria-hidden="true">
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="8" r="4"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/></svg>
                </div>
                <h1>Your Account</h1>
                <p class="profile-guest-sub">Sign in or create an account to place orders, view your order history, and manage your profile.</p>
                <div class="profile-auth-actions">
                    <a href="#/login" class="btn btn-full">Sign In / Sign Up</a>
                </div>
            </div>
            ${profileQuickLinksMarkup()}
        </section>`;
        return;
    }
    const orders = getMyOrders();
    let content = '';
    if (tab === 'orders') {
        content = `<h2 class="mb-20">Order History</h2>${orders.length ? [...orders].reverse().map(order => `<article class="order-card"><div class="order-header"><div><strong>Order ${escapeHtml(order.id)}</strong><p>Placed on ${escapeHtml(order.date)}</p></div><span class="status-badge">${escapeHtml(order.status)}</span></div><div class="summary-row"><span>${order.items.length} items</span><strong class="text-accent">${formatMoney(getOrderTotal(order))}</strong></div></article>`).join('') : '<article class="order-card"><p>No orders found yet.</p><a href="#/home" class="btn btn-small mt-20">Start Shopping</a></article>'}`;
    } else if (tab === 'addresses') {
        content = `<h2 class="mb-20">Saved Addresses</h2><article class="order-card"><p>No saved addresses yet.</p></article>`;
    } else {
        content = `<h2 class="mb-20">Profile Details</h2><div class="form-container profile-form"><div class="form-group"><label for="profile-name">Full Name</label><input id="profile-name" value="${escapeHtml(user.name)}"></div><div class="form-group"><label for="profile-email">Email</label><input type="email" value="${escapeHtml(user.email)}" disabled></div><button class="btn" onclick="updateProfile()">Update Profile</button></div>`;
    }
    app.innerHTML = `<section class="profile-page is-signed-in">
        <header class="profile-hero-card">
            <div class="profile-hero-identity">
                <div class="profile-avatar" aria-hidden="true">${escapeHtml(userInitials(user))}</div>
                <div class="profile-hero-meta">
                    <h1>${escapeHtml(user.name || 'Account')}</h1>
                    <p class="profile-hero-email">${escapeHtml(user.email)}</p>
                    ${user.isAdmin ? '<span class="profile-role-badge">Admin</span>' : ''}
                </div>
            </div>
            <div class="profile-hero-actions">
                ${user.isAdmin ? '<a href="#/admin" class="btn">Admin Dashboard</a>' : ''}
                <button type="button" class="btn btn-danger-outline" onclick="logout()">Logout</button>
            </div>
        </header>
        <div class="dashboard-grid"><aside class="sidebar">
            <button class="sidebar-link ${tab === 'profile' ? 'active' : ''}" onclick="renderDashboard('profile')">Profile</button>
            <button class="sidebar-link ${tab === 'orders' ? 'active' : ''}" onclick="renderDashboard('orders')">Order History</button>
            <button class="sidebar-link ${tab === 'addresses' ? 'active' : ''}" onclick="renderDashboard('addresses')">Saved Addresses</button>
        </aside><section>${content}</section></div>
        ${profileQuickLinksMarkup()}
    </section>`;
}

function getOrderTotal(order) {
    if (!order) return 0;
    const itemsTotal = Array.isArray(order.items)
        ? order.items.reduce((sum, item) => sum + (Number(item.price) || 0) * (Number(item.quantity) || 0), 0)
        : 0;
    const direct = Number(order.total);
    if (itemsTotal > 0) return itemsTotal;
    if (Number.isFinite(direct) && direct >= 0) return direct;
    return 0;
}

function renderAdmin(tab = 'overview') {
    lastAdminTab = tab;
    const user = getCurrentUser();
    if (!user?.isAdmin) {
        document.body.classList.remove('is-admin-view');
        location.hash = '#/login';
        return;
    }
    document.body.classList.add('is-admin-view');
    const products = getProducts();
    const categories = getCategories(products);
    const orders = getAllOrders();
    const unreadMessages = getMessages().filter(item => !item.read).length;
    let content;
    if (tab === 'overview') {
        const uniqueOrders = Array.from(new Map(orders.map(o => [String(o.id || Math.random()), o])).values());
        const summary = summarizeOrders(uniqueOrders);
        const sales = summary.made;
        const stats = store.adminStats || { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
        const pv = store.pageViews || { siteViews: 0, totalProductViews: 0, totalCategoryViews: 0, productViews: [], categoryViews: [] };
        const mongo = store.mongoStatus || {};

        const prodViewMap = new Map((pv.productViews || []).map(v => [String(v.targetId), Number(v.views) || 0]));
        const productViewRows = products
            .map(p => ({
                id: String(p.id),
                name: p.name,
                category: p.category || 'Uncategorized',
                image: p.image,
                views: prodViewMap.get(String(p.id)) || 0
            }))
            .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));

        const catViewMap = new Map((pv.categoryViews || []).map(v => [String(v.targetId).toLowerCase(), Number(v.views) || 0]));
        const categoryViewRows = categories
            .map(cat => ({
                name: cat,
                count: products.filter(p => String(p.category || '').toLowerCase() === cat.toLowerCase()).length,
                views: catViewMap.get(cat.toLowerCase()) || 0
            }))
            .sort((a, b) => b.views - a.views || a.name.localeCompare(b.name));

        const migrationCard = mongo.available
            ? `<div class="migration-card">
                <div class="migration-card-info">
                    <h3>MongoDB → Firebase Migration</h3>
                    <p>${store.needsMongoMigration
                        ? `Ready to migrate ${mongo.products} products, ${mongo.categories} categories, ${mongo.users} user accounts (with passwords), ${mongo.orders} orders &amp; ${mongo.messages} messages into Firebase.`
                        : `Firebase is active (${products.length} products loaded). You can re-sync from MongoDB (${mongo.products} products, ${mongo.users} accounts) anytime.`}
                        ${mongo.cloudinaryConfigured ? ' Cloudinary is connected for photos.' : ' Add CLOUDINARY_URL in secrets to move photos onto Cloudinary.'}
                    </p>
                    ${store.migrationProgress ? `<p class="migration-progress">${escapeHtml(store.migrationProgress)}</p>` : ''}
                </div>
                <button type="button" class="btn" ${store.migratingToFirebase ? 'disabled' : ''} onclick="runMongoToFirebaseMigration(this)">
                    ${store.migratingToFirebase ? 'Migrating…' : (store.needsMongoMigration ? 'Migrate All Data to Firebase' : 'Re-sync MongoDB → Firebase')}
                </button>
            </div>`
            : '';

        content = `<h2 class="mb-20">Store Overview</h2>
            ${migrationCard}
            <div class="stats-grid overview-stats">
                <div class="stat-card stat-card-featured"><p>Total Sales</p><div class="stat-val">${formatMoney(sales)}</div><small>${formatMoney(summary.made)} sold · ${formatMoney(summary.pending)} pending (unavailable excluded)</small></div>
                <div class="stat-card"><p>Inventory</p><div class="stat-val">${products.length}</div></div>
                <div class="stat-card"><p>Total Orders</p><div class="stat-val">${uniqueOrders.length}</div></div>
                <div class="stat-card"><p>Registered Users</p><div class="stat-val">${Number(stats.registeredUsers) || 0}</div></div>
                <div class="stat-card"><p>Website Visitors</p><div class="stat-val">${Number(stats.websiteVisitors) || 0}</div><small>${Number(stats.totalViews) || 0} total view${Number(stats.totalViews) === 1 ? '' : 's'}</small></div>
                <div class="stat-card"><p>Product Page Views</p><div class="stat-val">${Number(pv.totalProductViews) || 0}</div><small>${(pv.productViews || []).length} viewed product${(pv.productViews || []).length === 1 ? '' : 's'}</small></div>
                <div class="stat-card"><p>Category Page Views</p><div class="stat-val">${Number(pv.totalCategoryViews) || 0}</div><small>${(pv.categoryViews || []).length} viewed categor${(pv.categoryViews || []).length === 1 ? 'y' : 'ies'}</small></div>
            </div>
            <div class="admin-views-grid">
                <section class="admin-views-card" aria-label="Category page view counts">
                    <div class="admin-views-head">
                        <h3>Category Page Views</h3>
                        <span>${categoryViewRows.length} categor${categoryViewRows.length === 1 ? 'y' : 'ies'}</span>
                    </div>
                    ${categoryViewRows.length
                        ? `<ul class="views-list">${categoryViewRows.map(row => `<li class="views-row">
                            <a href="#/category?name=${encodeURIComponent(row.name)}" class="views-row-name">${escapeHtml(row.name)} <small>(${row.count} items)</small></a>
                            <span class="views-count-badge">${row.views} view${row.views === 1 ? '' : 's'}</span>
                        </li>`).join('')}</ul>`
                        : '<p class="form-hint">No categories yet.</p>'}
                </section>
                <section class="admin-views-card" aria-label="Product page view counts">
                    <div class="admin-views-head">
                        <h3>Product Page Views</h3>
                        <span>Top ${Math.min(productViewRows.length, 25)} of ${productViewRows.length}</span>
                    </div>
                    ${productViewRows.length
                        ? `<ul class="views-list">${productViewRows.slice(0, 25).map(row => `<li class="views-row">
                            <a href="#/product?id=${encodeURIComponent(row.id)}" class="views-row-name">${escapeHtml(row.name)} <small>${escapeHtml(row.category)}</small></a>
                            <span class="views-count-badge">${row.views} view${row.views === 1 ? '' : 's'}</span>
                        </li>`).join('')}</ul>`
                        : '<p class="form-hint">No products yet.</p>'}
                </section>
            </div>`;
    } else if (tab === 'inventory') {
        const subMap = getSubcategoriesMap();
        const totalSubcategories = Object.values(subMap).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const categorySummary = `${categories.length} ${categories.length === 1 ? 'category' : 'categories'}${totalSubcategories ? ` · ${totalSubcategories} ${totalSubcategories === 1 ? 'subcategory' : 'subcategories'}` : ''}`;
        const viewIsGrid = inventoryViewMode === 'grid';
        const inventoryItemsMarkup = viewIsGrid
            ? `<div class="inventory-grid">${products.map(product => {
                const safeId = escapeHtml(String(product.id));
                const catPath = product.subcategory ? `${escapeHtml(product.category)} / ${escapeHtml(product.subcategory)}` : escapeHtml(product.category || 'Uncategorized');
                return `<article class="inventory-grid-card">
                    <div class="inventory-grid-media">
                        <img src="${escapeHtml(resolveAssetUrl(product.image))}" alt="${escapeHtml(product.name)}" loading="lazy" decoding="async">
                    </div>
                    <div class="inventory-grid-body">
                        <p class="inventory-grid-meta">${catPath}</p>
                        <h3 class="inventory-grid-title">${escapeHtml(product.name)}</h3>
                        <div class="inventory-grid-price">
                            <span class="inventory-price${hasPromo(product) ? ' has-promo' : ''}">${priceDisplayMarkup(product)}</span>
                            ${hasBulk(product) ? `<small class="inventory-bulk-note">${formatMoney(product.bulkPrice)} for ${Number(product.bulkMinQty)}+</small>` : ''}
                        </div>
                        <div class="inventory-grid-actions">
                            <button type="button" class="btn btn-outline btn-small" onclick="openProductModal('${safeId}')">Edit</button>
                            <button type="button" class="remove-btn" onclick="deleteProduct('${safeId}')">Delete</button>
                        </div>
                    </div>
                </article>`;
            }).join('')}</div>`
            : `<div class="table-wrap"><table><thead><tr><th>ID</th><th>Photo</th><th>Product</th><th>Category</th><th>Price</th><th>Actions</th></tr></thead><tbody>${products.map(product => {
                const safeId = escapeHtml(String(product.id));
                const catPath = product.subcategory ? `${escapeHtml(product.category)} <span class="cat-sep">/</span> ${escapeHtml(product.subcategory)}` : escapeHtml(product.category);
                return `<tr><td>${safeId}</td><td><img class="inventory-thumb" src="${escapeHtml(resolveAssetUrl(product.image))}" alt="" loading="lazy" decoding="async"></td><td>${escapeHtml(product.name)}</td><td>${catPath}</td><td><span class="inventory-price${hasPromo(product) ? ' has-promo' : ''}">${priceDisplayMarkup(product)}</span>${hasBulk(product) ? `<br><small>${formatMoney(product.bulkPrice)} for ${Number(product.bulkMinQty)}+</small>` : ''}</td><td><div class="inventory-actions"><button class="btn btn-outline btn-small" onclick="openProductModal('${safeId}')">Edit</button><button class="remove-btn" onclick="deleteProduct('${safeId}')">Delete</button></div></td></tr>`;
            }).join('')}</tbody></table></div>`;

        content = `<div class="inventory-topbar">
                <div class="inventory-title-group">
                    <h2>Inventory Management</h2>
                    <span class="inventory-count">${products.length} ${products.length === 1 ? 'product' : 'products'} · ${categorySummary}</span>
                </div>
                <div class="inventory-view-toggle" role="group" aria-label="Inventory layout view">
                    <button type="button" class="inventory-view-btn${!viewIsGrid ? ' is-active' : ''}" aria-pressed="${!viewIsGrid}" onclick="setInventoryView('list')">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>
                        <span>List</span>
                    </button>
                    <button type="button" class="inventory-view-btn${viewIsGrid ? ' is-active' : ''}" aria-pressed="${viewIsGrid}" onclick="setInventoryView('grid')">
                        <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                        <span>Grid</span>
                    </button>
                </div>
            </div>
            <div class="inventory-add-wrap">
                <button type="button" class="btn" onclick="openProductModal()">+ Add Product</button>
                <button type="button" class="btn btn-outline inventory-dir-btn" onclick="renderAdmin('categories')">
                    <span>Categories &amp; Subcategories</span>
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m-6-6 6 6-6 6"/></svg>
                </button>
                ${store.mediaStatus?.cloudinaryConfigured && store.mediaStatus?.legacyPhotoCount > 0 ? `<button type="button" class="btn btn-outline" onclick="migratePhotosToCloudinary(this)">Move ${store.mediaStatus.legacyPhotoCount} Photos to Cloudinary</button>` : ''}
            </div>
            ${products.length ? inventoryItemsMarkup : '<p class="empty-msg">No products in your inventory yet. Click "+ Add Product" to create your first item.</p>'}`;
    } else if (tab === 'categories') {
        const subMap = getSubcategoriesMap();
        const totalSubcategories = Object.values(subMap).reduce((sum, list) => sum + (Array.isArray(list) ? list.length : 0), 0);
        const categoryCounts = new Map();
        products.forEach(p => {
            const key = p.category || '';
            categoryCounts.set(key, (categoryCounts.get(key) || 0) + 1);
        });
        content = `<div class="categories-page-head">
                <button type="button" class="btn btn-outline btn-small categories-back-btn" onclick="renderAdmin('inventory')">
                    <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m6 6-6-6 6-6"/></svg>
                    <span>Back to Inventory</span>
                </button>
                <div class="inventory-title-group">
                    <h2>Categories &amp; Subcategories</h2>
                    <span class="inventory-count">${categories.length} ${categories.length === 1 ? 'category' : 'categories'} · ${totalSubcategories} ${totalSubcategories === 1 ? 'subcategory' : 'subcategories'}</span>
                </div>
            </div>
            <div class="category-forms-grid">
                <section class="category-form-card" aria-labelledby="add-cat-heading">
                    <h3 id="add-cat-heading">Add Category</h3>
                    <form class="category-stack-form" onsubmit="addCategory(event)">
                        <div class="form-group">
                            <label for="new-category">Category Name</label>
                            <input id="new-category" placeholder="e.g. Footwear, Electronics" maxlength="40" required>
                        </div>
                        <div class="category-checks-row">
                            <label class="category-variant-check"><input type="checkbox" id="new-category-size"> Default Size option</label>
                            <label class="category-variant-check"><input type="checkbox" id="new-category-color"> Default Color option</label>
                        </div>
                        <button class="btn" type="submit">Add Category</button>
                    </form>
                </section>
                <section class="category-form-card" aria-labelledby="add-subcat-heading">
                    <h3 id="add-subcat-heading">Add Subcategory</h3>
                    <form class="category-stack-form" onsubmit="addSubcategory(event)">
                        <div class="form-group">
                            <label for="subcategory-parent">Parent Category</label>
                            <select id="subcategory-parent" required>
                                ${categories.length ? categories.map(cat => `<option value="${escapeHtml(cat)}">${escapeHtml(cat)}</option>`).join('') : '<option value="">Add a category first</option>'}
                            </select>
                        </div>
                        <div class="form-group">
                            <label for="new-subcategory">Subcategory Name</label>
                            <input id="new-subcategory" placeholder="e.g. Sneakers, Phone Chargers" maxlength="50" ${categories.length ? 'required' : 'disabled'}>
                        </div>
                        <button class="btn" type="submit" ${categories.length ? '' : 'disabled'}>Add Subcategory</button>
                    </form>
                </section>
            </div>
            <div class="category-directory-list">
                ${categories.length ? categories.map(category => {
                    const subs = getSubcategoriesFor(category);
                    const prodCount = categoryCounts.get(category) || 0;
                    const safeCat = escapeHtml(category);
                    return `<article class="category-directory-card">
                        <div class="category-directory-head">
                            <div class="category-directory-info">
                                <h3>${safeCat}</h3>
                                <span class="category-directory-meta">${prodCount} ${prodCount === 1 ? 'product' : 'products'} · ${subs.length} ${subs.length === 1 ? 'subcategory' : 'subcategories'}</span>
                            </div>
                            <div class="category-directory-controls">
                                ${[['size', 'Size', categoryNeedsSize(category)], ['color', 'Color', categoryNeedsColor(category)]].map(([option, label, on]) => `<button type="button" class="category-toggle${on ? ' is-on' : ''}" aria-pressed="${on}" aria-label="${label} option for ${safeCat}: ${on ? 'on' : 'off'}" data-category="${safeCat}" data-option="${option}" onclick="toggleCategoryOption(this)">${label}: ${on ? 'On' : 'Off'}</button>`).join('')}
                                <button type="button" class="remove-btn" aria-label="Delete ${safeCat} category" data-category="${safeCat}" onclick="removeCategory(this)">Delete Category</button>
                            </div>
                        </div>
                        <div class="subcategory-section">
                            ${subs.length ? `<ul class="subcategory-items">${subs.map(sub => {
                                const safeSub = escapeHtml(sub);
                                return `<li class="subcategory-item">
                                    <span>${safeSub}</span>
                                    <button type="button" class="subcategory-remove-btn" aria-label="Remove subcategory ${safeSub}" data-category="${safeCat}" data-subcategory="${safeSub}" onclick="removeSubcategory(this)">×</button>
                                </li>`;
                            }).join('')}</ul>` : '<p class="subcategory-empty">No subcategories yet.</p>'}
                            <form class="subcategory-inline-form" data-category="${safeCat}" onsubmit="addInlineSubcategory(event, this)">
                                <label class="sr-only">Add subcategory to ${safeCat}</label>
                                <input type="text" placeholder="Add subcategory under ${safeCat}…" maxlength="50" required>
                                <button type="submit" class="btn btn-outline btn-small">Add</button>
                            </form>
                        </div>
                    </article>`;
                }).join('') : '<p class="empty-msg">No categories created yet. Add your first category above.</p>'}
            </div>`;
    } else if (tab === 'contacts') {
        content = contactsMarkup(getMessages());
    } else if (tab === 'reports') {
        content = reportsMarkup(orders);
    } else {
        content = orderTrackingMarkup(orders);
    }
    const adminNavItems = [
        {
            key: 'overview',
            label: 'Overview',
            icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="5" rx="1.5"/><rect x="13" y="10" width="8" height="11" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/></svg>'
        },
        {
            key: 'inventory',
            label: 'Inventory',
            icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 3.5 7.5 12 12l8.5-4.5L12 3Z"/><path d="M3.5 12 12 16.5 20.5 12"/><path d="M3.5 16.5 12 21l8.5-4.5"/></svg>'
        },
        {
            key: 'orders',
            label: 'Orders',
            icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M8 12h8M8 16h5"/></svg>'
        },
        {
            key: 'reports',
            label: 'Reports',
            icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"/><path d="M7 16v-5"/><path d="M12 16V7"/><path d="M17 16v-8"/></svg>'
        },
        {
            key: 'contacts',
            label: 'Contacts',
            badge: unreadMessages,
            icon: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'
        }
    ];
    const activeAdminNav = tab === 'categories' ? 'inventory' : tab;
    app.innerHTML = `<div class="admin-page">
        <div class="admin-header">
            <span class="admin-header-badge">Admin Dashboard</span>
            <a href="#/profile" class="blood-strike-back-btn" aria-label="Back to profile">
                <svg class="blood-strike-back-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>
                <span>Back</span>
            </a>
        </div>
        <section>${content}</section>
        <nav class="admin-bottom-nav" aria-label="Admin sections">
            <div class="admin-bottom-nav-inner">
                ${adminNavItems.map(item => `<button type="button" class="admin-bottom-item${activeAdminNav === item.key ? ' is-active' : ''}" aria-current="${activeAdminNav === item.key ? 'page' : 'false'}" onclick="renderAdmin('${item.key}')">
                    <span class="admin-bottom-icon">
                        ${item.icon}
                        ${item.badge ? `<span class="admin-bottom-badge" aria-label="${item.badge} unread">${item.badge > 99 ? '99+' : item.badge}</span>` : ''}
                    </span>
                    <span class="admin-bottom-label">${item.label}</span>
                </button>`).join('')}
            </div>
        </nav>
    </div>`;
    app.append(document.getElementById('tpl-product-modal').content.cloneNode(true));
    // Category choices come from the data, so they are filled in here.
    document.getElementById('p-category').innerHTML = categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    syncProductSubcategoryOptions();
}

// How many units of an order item were sold / unavailable / still unmarked.
// (Orders marked with the earlier single Sold/Unavailable choice are understood too.)
function itemSplit(item) {
    const quantity = Number(item.quantity) || 0;
    if (item.soldQty !== undefined || item.unavailableQty !== undefined) {
        const sold = Math.min(quantity, Math.max(0, Number(item.soldQty) || 0));
        const unavailable = Math.min(quantity - sold, Math.max(0, Number(item.unavailableQty) || 0));
        return { sold, unavailable, pending: quantity - sold - unavailable };
    }
    if (item.result === 'sold') return { sold: quantity, unavailable: 0, pending: 0 };
    if (item.result === 'unavailable') return { sold: 0, unavailable: quantity, pending: 0 };
    return { sold: 0, unavailable: 0, pending: quantity };
}

function itemSplitInputs(order, index) {
    const item = order.items[index];
    const quantity = Number(item.quantity) || 0;
    const { sold, unavailable, pending } = itemSplit(item);
    const handler = kind => `setItemSplit('${escapeHtml(order.id)}', ${index}, '${kind}', this.value)`;
    return `<div class="item-split">
        <label>Sold <input type="number" min="0" max="${quantity}" step="1" value="${sold}" aria-label="Units sold of ${escapeHtml(item.name)}" onchange="${handler('sold')}"></label>
        <label>Unavailable <input type="number" min="0" max="${quantity}" step="1" value="${unavailable}" aria-label="Units unavailable of ${escapeHtml(item.name)}" onchange="${handler('unavailable')}"></label>
        <small class="item-pending${pending ? ' has-pending' : ''}">${pending ? `${pending} not marked yet` : 'All marked'}</small>
    </div>`;
}

function orderTrackingMarkup(orders) {
    const rows = [...orders].reverse().map(order => {
        const items = order.items.map((item, index) => {
            const details = Object.entries(item.options || {}).map(([name, value]) => `${name}: ${value}`).join(', ');
            return `<div class="order-item-line"><span>${escapeHtml(item.name)} × ${Number(item.quantity)}${details ? ` <small>(${escapeHtml(details)})</small>` : ''}</span>${itemSplitInputs(order, index)}</div>`;
        }).join('');
        return `<tr><td>${escapeHtml(order.id)}</td><td>${escapeHtml(order.customer)}</td><td>${escapeHtml(order.email)}</td><td>${escapeHtml(order.address)}, ${escapeHtml(order.city)} ${escapeHtml(order.zip)}</td>
            <td>${items}<div class="order-item-bulk"><button type="button" class="btn btn-outline btn-small" onclick="markOrderItems('${escapeHtml(order.id)}', 'sold')">All sold</button> <button type="button" class="btn btn-outline btn-small" onclick="markOrderItems('${escapeHtml(order.id)}', 'unavailable')">All unavailable</button></div></td>
            <td>${escapeHtml(order.date)}</td><td>${formatMoney(getOrderTotal(order))}</td></tr>`;
    }).join('');
    return `<h2 class="mb-20">Order Tracking</h2>
        <p class="form-hint mb-20">For each item, enter how many units were sold and how many were unavailable (they can add up to at most the quantity ordered). These numbers feed the monthly report.</p>
        <div class="table-wrap"><table><thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Delivery Address</th><th>Items</th><th>Date</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function saveOrderItems(order, items) {
    const reportedAtMs = Date.now();
    try {
        if (hasFirebaseUser()) {
            const updated = await window.RKFirebase.updateOrderItems(order.id, items);
            const nextOrder = { ...order, items: updated?.items || items, status: updated?.status || order.status, reportedAtMs };
            store.allOrders = store.allOrders.map(entry => entry.id === order.id ? nextOrder : entry);
        } else {
            const data = await apiRequest(`/api/orders/${encodeURIComponent(order.id)}`, {
                method: 'PUT',
                body: { items, reportedAtMs }
            });
            const nextOrder = data?.order || { ...order, items, reportedAtMs };
            store.allOrders = store.allOrders.map(entry => entry.id === order.id ? nextOrder : entry);
        }
    } catch (error) {
        console.warn(error);
        showToast('The order could not be updated. Check your connection and admin access.', 'error');
    }
    renderAdmin('orders');
}

function withSplit(item, split) {
    const { result, ...rest } = item;
    return { ...rest, soldQty: split.sold, unavailableQty: split.unavailable };
}

async function setItemSplit(orderId, index, kind, value) {
    const order = getAllOrders().find(entry => entry.id === orderId);
    if (!order) return;
    const item = order.items[index];
    const quantity = Number(item.quantity) || 0;
    const current = itemSplit(item);
    let amount = Math.floor(Number(value));
    if (!Number.isFinite(amount) || amount < 0) amount = 0;
    const other = kind === 'sold' ? current.unavailable : current.sold;
    if (amount + other > quantity) {
        showToast(`Only ${quantity} ordered, so Sold and Unavailable can add up to at most ${quantity}.`, 'error');
        renderAdmin('orders');
        return;
    }
    const split = kind === 'sold' ? { sold: amount, unavailable: other } : { sold: other, unavailable: amount };
    await saveOrderItems(order, order.items.map((entry, position) => position === index ? withSplit(entry, split) : entry));
}

async function markOrderItems(orderId, result) {
    const order = getAllOrders().find(entry => entry.id === orderId);
    if (!order) return;
    await saveOrderItems(order, order.items.map(entry => {
        const quantity = Number(entry.quantity) || 0;
        return withSplit(entry, result === 'sold' ? { sold: quantity, unavailable: 0 } : { sold: 0, unavailable: quantity });
    }));
}

let reportMonth = '';

function monthKeyOf(order) {
    const date = new Date(Number(order.createdAtMs) || Date.now());
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(key) {
    const [year, month] = key.split('-').map(Number);
    return new Date(year, month - 1, 1).toLocaleString('en-GB', { month: 'long', year: 'numeric' });
}

// Adds up what was sold (made), what was unavailable (lost) and what is not marked yet.
function summarizeOrders(orders) {
    const summary = { made: 0, lost: 0, pending: 0, madeQty: 0, lostQty: 0, pendingQty: 0, rows: new Map() };
    orders.forEach(order => (order.items || []).forEach(item => {
        const price = Number(item.price) || 0;
        const { sold, unavailable, pending } = itemSplit(item);
        const key = String(item.id ?? item.name);
        const row = summary.rows.get(key) || { name: item.name, soldQty: 0, sold: 0, lostQty: 0, lost: 0, pendingQty: 0, pending: 0 };
        summary.made += price * sold; summary.madeQty += sold; row.sold += price * sold; row.soldQty += sold;
        summary.lost += price * unavailable; summary.lostQty += unavailable; row.lost += price * unavailable; row.lostQty += unavailable;
        summary.pending += price * pending; summary.pendingQty += pending; row.pending += price * pending; row.pendingQty += pending;
        summary.rows.set(key, row);
    }));
    return summary;
}

function setReportMonth(value) {
    reportMonth = value;
    renderAdmin('reports');
}

function reportsMarkup(orders) {
    const currentKey = monthKeyOf({ createdAtMs: Date.now() });
    if (!reportMonth) reportMonth = currentKey;
    const byMonth = new Map([[currentKey, []]]);
    orders.forEach(order => {
        const key = monthKeyOf(order);
        if (!byMonth.has(key)) byMonth.set(key, []);
        byMonth.get(key).push(order);
    });
    if (!byMonth.has(reportMonth)) byMonth.set(reportMonth, []);
    const keys = [...byMonth.keys()].sort().reverse();
    const monthOrders = byMonth.get(reportMonth);
    const summary = summarizeOrders(monthOrders);
    const productRows = [...summary.rows.values()].sort((a, b) => b.sold - a.sold || b.lost - a.lost);
    const history = keys.map(key => {
        const monthSummary = summarizeOrders(byMonth.get(key));
        return `<tr><td>${escapeHtml(monthLabel(key))}${key === currentKey ? ' <small>(this month)</small>' : ''}</td><td>${byMonth.get(key).length}</td><td class="text-made">${formatMoney(monthSummary.made)}</td><td class="text-lost">${formatMoney(monthSummary.lost)}</td><td>${formatMoney(monthSummary.pending)}</td><td><button type="button" class="btn btn-outline btn-small" onclick="setReportMonth('${key}')">View</button></td></tr>`;
    }).join('');
    return `<h2 class="mb-20">Sales Report</h2>
        <div class="report-controls"><label for="report-month">Month</label>
            <select id="report-month" onchange="setReportMonth(this.value)">${keys.map(key => `<option value="${key}"${key === reportMonth ? ' selected' : ''}>${escapeHtml(monthLabel(key))}</option>`).join('')}</select>
        </div>
        <div class="stats-grid report-stats">
            <div class="stat-card"><p>Made (sold)</p><div class="stat-val text-made">${formatMoney(summary.made)}</div><small>${summary.madeQty} item${summary.madeQty === 1 ? '' : 's'}</small></div>
            <div class="stat-card"><p>Lost (unavailable)</p><div class="stat-val text-lost">${formatMoney(summary.lost)}</div><small>${summary.lostQty} item${summary.lostQty === 1 ? '' : 's'}</small></div>
            <div class="stat-card"><p>Not marked yet</p><div class="stat-val">${formatMoney(summary.pending)}</div><small>${summary.pendingQty} item${summary.pendingQty === 1 ? '' : 's'}</small></div>
            <div class="stat-card"><p>Orders</p><div class="stat-val">${monthOrders.length}</div></div>
        </div>
        ${summary.pendingQty ? '<p class="form-hint mb-20">Items still Pending are not counted as made or lost. Mark them in the Orders tab.</p>' : ''}
        <h3 class="mb-20">By product</h3>
        ${productRows.length ? `<div class="table-wrap"><table><thead><tr><th>Product</th><th>Sold</th><th>Made</th><th>Unavailable</th><th>Lost</th><th>Pending</th></tr></thead><tbody>${productRows.map(row => `<tr><td>${escapeHtml(row.name)}</td><td>${row.soldQty}</td><td class="text-made">${formatMoney(row.sold)}</td><td>${row.lostQty}</td><td class="text-lost">${formatMoney(row.lost)}</td><td>${row.pendingQty}</td></tr>`).join('')}</tbody></table></div>` : '<p class="mb-20">No orders in this month.</p>'}
        <h3 class="mb-20 mt-20">All months</h3>
        <div class="table-wrap"><table><thead><tr><th>Month</th><th>Orders</th><th>Made</th><th>Lost</th><th>Not marked</th><th></th></tr></thead><tbody>${history}</tbody></table></div>`;
}

// ---------- Contact messages ----------
let sendingMessage = false;

async function sendContactMessage(event) {
    event.preventDefault();
    if (sendingMessage) return;
    sendingMessage = true;
    const user = getCurrentUser();
    const id = `MSG-${Date.now()}`;
    const message = {
        id,
        name: document.getElementById('contact-name').value.trim(),
        email: document.getElementById('contact-email').value.trim(),
        subject: document.getElementById('contact-subject').value.trim(),
        message: document.getElementById('contact-message').value.trim(),
        createdAtMs: Date.now(),
        read: false,
        uid: user?.uid || null
    };
    try {
        let savedMessage = null;
        if (hasFirebase()) {
            savedMessage = await window.RKFirebase.sendContactMessage(message);
        } else {
            const data = await Promise.race([
                apiRequest('/api/messages', { method: 'POST', body: message }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Sending timed out.')), 8000))
            ]);
            savedMessage = data?.message || message;
        }
        if (user?.isAdmin && savedMessage) {
            store.messages = [...store.messages, savedMessage];
        }
    } catch (error) {
        console.warn(error);
        showToast('Your message could not be sent. Please check your connection and try again.', 'error');
        return;
    } finally {
        sendingMessage = false;
    }
    showToast('Message sent! We will get back to you soon.', 'success');
    location.hash = '#/home';
}

function contactsMarkup(messages) {
    const unread = messages.filter(item => !item.read).length;
    const cards = [...messages].reverse().map(item => `<article class="contact-card${item.read ? '' : ' is-unread'}">
        <header class="contact-head"><h3>${escapeHtml(item.subject)}</h3>${item.read ? '' : '<span class="unread-dot">New</span>'}</header>
        <p class="contact-meta">From <strong>${escapeHtml(item.name)}</strong> · ${escapeHtml(item.email)} · ${escapeHtml(new Date(Number(item.createdAtMs) || 0).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }))}</p>
        <p class="contact-body">${escapeHtml(item.message)}</p>
        <div class="contact-actions">
            <button type="button" class="btn btn-outline btn-small" onclick="setMessageRead('${escapeHtml(item.id)}', ${item.read ? 'false' : 'true'})">${item.read ? 'Mark as unread' : 'Mark as read'}</button>
            <button type="button" class="remove-btn" onclick="deleteMessage('${escapeHtml(item.id)}')">Delete</button>
        </div>
    </article>`).join('');
    return `<h2 class="mb-20">Contact Messages</h2>
        ${messages.length ? `<p class="form-hint mb-20">${unread} unread of ${messages.length} message${messages.length === 1 ? '' : 's'}.</p>` : ''}
        ${cards || '<p>No messages yet.</p>'}`;
}

async function setMessageRead(id, read) {
    try {
        if (hasFirebaseUser()) {
            await window.RKFirebase.updateMessageRead(id, read);
            store.messages = store.messages.map(item => item.id === id ? { ...item, read: Boolean(read) } : item);
        } else {
            const data = await apiRequest(`/api/messages/${encodeURIComponent(id)}`, {
                method: 'PATCH',
                body: { read }
            });
            store.messages = store.messages.map(item => item.id === id ? (data?.message || { ...item, read: Boolean(read) }) : item);
        }
    } catch (error) {
        console.warn(error);
        showToast('The message could not be updated. Check your connection and admin access.', 'error');
    }
    renderAdmin('contacts');
}

async function deleteMessage(id) {
    if (!(await askConfirm('Delete this message?'))) return;
    try {
        if (hasFirebaseUser()) {
            await window.RKFirebase.deleteMessage(id);
        } else {
            await apiRequest(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
        }
        store.messages = store.messages.filter(item => item.id !== id);
        showToast('Message deleted.', 'success');
    } catch (error) {
        console.warn(error);
        showToast('The message could not be deleted. Check your connection and admin access.', 'error');
    }
    renderAdmin('contacts');
}

function renderPage() {
    const { page } = routeInfo();
    toggleMenu(true);
    document.title = `${page === 'home' ? 'Shop' : page.replace(/-/g, ' ').replace(/\b\w/g, char => char.toUpperCase())} | ${brand}`;
    const user = getCurrentUser();
    const authLinks = document.getElementById('auth-links');
    if (authLinks) {
        authLinks.innerHTML = user
            ? `<a href="#/profile">Profile</a> ${user.isAdmin ? '<a href="#/admin">Admin</a>' : ''} <a href="#/home" onclick="logout()">Logout</a>`
            : (authSettled ? '<a href="#/login">Login</a> <a href="#/register">Register</a>' : '');
    }
    updateBottomNav(page);
    document.body.classList.toggle('is-admin-view', page === 'admin' && Boolean(user?.isAdmin));
    // Account pages need to know who is logged in; everything else can show straight away.
    if (!authSettled && ['profile', 'dashboard', 'admin', 'checkout'].includes(page)) {
        app.innerHTML = loadingMarkup;
        return;
    }
    // Someone who is already logged in has no use for the login / register forms.
    if (user && ['login', 'register', 'forgot-password', 'reset-password'].includes(page)) {
        location.hash = postLoginHash(user);
        return;
    }
    if (!['login', 'register', 'forgot-password', 'reset-password'].includes(page)) {
        afterLoginHash = '';
        loginNotice = '';
    }
    // Ordering needs an account.
    if (page === 'checkout' && !user) {
        requireLogin('#/checkout', 'Please log in or register to place your order.');
        return;
    }
    if (!['product', 'category', 'search'].includes(page)) {
        lastTrackedViewSignature = '';
    }
    const pages = {
        home: renderHome, category: renderCategory, search: renderSearch, product: renderProduct,
        login: showLoginPage, register: showRegisterPage,
        'forgot-password': () => showTemplate('tpl-forgot-password'),
        'reset-password': () => showTemplate('tpl-reset-password'),
        cart: renderCart,
        checkout: renderCheckout, success: renderOrderSuccess, about: () => showTemplate('tpl-about'),
        contact: () => showTemplate('tpl-contact'), faq: () => showTemplate('tpl-faq'), legal: renderLegal,
        profile: () => renderDashboard(), dashboard: () => renderDashboard(), admin: () => renderAdmin()
    };
    (pages[page] || renderHome)();
    app.removeAttribute('aria-busy');
    updateCartCount();
}

function searchProducts(event) {
    event.preventDefault();
    const query = document.getElementById('search-input').value.trim();
    location.hash = `#/search?q=${encodeURIComponent(query)}`;
}

function isInCart(productId) {
    return getCart().some(item => sameId(item.id, productId));
}

// Keeps every "Add to Cart" button in step with what is actually in this visitor's cart.
function syncCartButtons() {
    const inCart = new Set(getCart().map(item => String(item.id)));
    document.querySelectorAll('[data-cart-id]').forEach(button => {
        const added = inCart.has(button.dataset.cartId);
        button.classList.toggle('is-added', added);
        button.textContent = added ? 'Added to Cart ✓' : (button.dataset.originalText || 'Add to Cart');
    });
    const summary = document.getElementById('product-cart-summary');
    if (summary) summary.innerHTML = cartSummaryMarkup(summary.dataset.productId);
}

function readSelectedOptions() {
    const selects = [...document.querySelectorAll('.product-option select')];
    const missing = selects.filter(select => !select.value);
    if (missing.length) {
        showToast(`Please select ${missing.map(select => select.dataset.optionName.toLowerCase()).join(' and ')}.`, 'error');
        missing[0].focus();
        return null;
    }
    return Object.fromEntries(selects.map(select => [select.dataset.optionName, select.value]));
}

function addToCartFromButton(id) {
    const product = getProducts().find(item => sameId(item.id, id));
    if (!product) return;
    if (hasOptions(product)) {
        location.hash = `#/product?id=${encodeURIComponent(id)}`;
    } else if (isInCart(id)) {
        location.hash = '#/cart';
    } else {
        addToCart(id);
    }
}

function addProductQuantity(id) {
    const options = readSelectedOptions();
    if (!options) return;
    const quantityInput = document.getElementById('product-qty');
    const quantity = Math.max(1, Number.parseInt(quantityInput.value, 10) || 1);
    if (!addToCart(id, quantity, options)) return;
    // Ready for the next color / size / quantity choice.
    document.querySelectorAll('.product-option select').forEach(select => { select.selectedIndex = 0; });
    quantityInput.value = 1;
}

function orderProductViaWhatsApp(productId) {
    if (!getCurrentUser()) {
        if (!authSettled) {
            showToast('Just a moment, still checking your login. Please try again.');
        } else {
            requireLogin(location.hash || '#/home', 'Please log in or register to place an order.');
        }
        return;
    }
    const products = getProducts();
    const product = products.find(item => sameId(item.id, productId));
    if (!product) {
        showToast('This product is no longer available.', 'error');
        return;
    }
    const selected = readSelectedOptions();
    if (!selected) return;
    const quantity = Math.max(1, Number.parseInt(document.getElementById('product-qty')?.value, 10) || 1);
    const options = Object.entries(selected).map(([name, value]) => `${name}: ${value}`);
    const basePrice = baseUnitPrice(product);
    const unitPrice = hasBulk(product) && quantity >= Number(product.bulkMinQty)
        ? Math.min(basePrice, Number(product.bulkPrice))
        : basePrice;
    const sku = product.sku || product.id;
    const message = [
        'Hello! I would like to order:',
        `- Product: ${product.name}`,
        `- SKU: ${sku}`,
        `- Price: ${formatMoney(unitPrice)}${quantity > 1 ? ` x ${quantity} = ${formatMoney(unitPrice * quantity)}` : ''}`,
        `- Options: ${options.length ? options.join(', ') : 'None'}`,
        `Link: ${window.location.href}`
    ].join('\n');
    const whatsappUrl = `https://wa.me/260961005957?text=${encodeURIComponent(message)}`;
    window.open(whatsappUrl, '_blank', 'noopener,noreferrer');
}

function updateCartQuantity(index, quantity) {
    const cart = getCart();
    const item = cart[Number(index)];
    if (!item) return;
    item.quantity = Math.max(1, Number.parseInt(quantity, 10) || 1);
    saveCart(cart);
    renderCart();
}

function increaseCartQuantity(index) {
    const item = getCart()[Number(index)];
    if (item) updateCartQuantity(index, Number(item.quantity) + 1);
}

function decreaseCartQuantity(index) {
    const item = getCart()[Number(index)];
    if (item) updateCartQuantity(index, Number(item.quantity) - 1);
}

function removeCartItem(index) {
    const cart = getCart();
    cart.splice(Number(index), 1);
    saveCart(cart);
    renderCart();
}

function authErrorMessage(error) {
    switch (error?.code) {
        case 'auth/invalid-credential':
        case 'auth/wrong-password':
        case 'auth/user-not-found':
        case 'auth/invalid-email':
            return 'Invalid email or password.';
        case 'auth/operation-not-allowed':
            return 'Email/Password sign-in is not enabled in Firebase Authentication yet. Use Google Sign-In above, or enable Email/Password in your Firebase Console.';
        case 'auth/popup-closed-by-user':
            return 'Google sign-in was cancelled.';
        case 'auth/popup-blocked':
            return 'Your browser blocked the Google sign-in popup. Please allow popups for this site and try again.';
        case 'auth/password-reset-required':
            return 'This account needs a password reset before logging in. Use Forgot Password below to set a new password.';
        case 'auth/invalid-reset-token':
            return 'This reset link is invalid or has expired. Please request a new one.';
        case 'auth/missing-name':
            return 'Please enter your full name.';
        case 'auth/email-already-in-use':
            return 'Email already registered.';
        case 'auth/weak-password':
            return 'Password must be at least 6 characters.';
        case 'auth/too-many-requests':
            return 'Too many attempts. Please try again later.';
        case 'auth/database-unavailable':
            return 'Service is waking up or temporarily unavailable. Please try again in a moment.';
        case 'auth/network-request-failed':
            return 'Network error. Check your connection and try again.';
        default:
            return error?.message || 'Something went wrong. Please try again.';
    }
}

// Where to go after logging in: back to what the person was doing, else their own page.
let afterLoginHash = '';
let loginNotice = '';

function postLoginHash(user) {
    const target = afterLoginHash || (user?.isAdmin ? '#/admin' : '#/profile');
    afterLoginHash = '';
    loginNotice = '';
    return target;
}

function requireLogin(returnHash, message) {
    afterLoginHash = returnHash;
    loginNotice = message;
    location.hash = '#/login';
}

function showAuthNotice(elementId, message, isError = false) {
    const el = document.getElementById(elementId);
    if (!el) return;
    if (!message) {
        el.textContent = '';
        el.hidden = true;
        el.classList.remove('is-error');
        return;
    }
    el.textContent = message;
    el.classList.toggle('is-error', isError);
    el.hidden = false;
}

async function loadAuthProviders() {
    if (hasFirebase()) {
        store.authProviders = { googleEnabled: true, googleClientId: '', loaded: true };
        return store.authProviders;
    }
    if (store.authProviders.loaded) return store.authProviders;
    try {
        const data = await apiRequest('/api/auth/providers');
        store.authProviders = {
            googleEnabled: Boolean(data?.googleEnabled && data?.googleClientId),
            googleClientId: String(data?.googleClientId || ''),
            loaded: true
        };
    } catch {
        store.authProviders = { googleEnabled: false, googleClientId: '', loaded: true };
    }
    return store.authProviders;
}

async function syncGoogleAuthUi(mode) {
    const providers = await loadAuthProviders();
    const wrap = document.getElementById(`${mode}-google-wrap`);
    const subtitle = document.getElementById(`${mode}-subtitle`);
    if (!providers.googleEnabled) {
        if (wrap) wrap.hidden = true;
        return;
    }
    if (wrap) wrap.hidden = false;
    if (subtitle) {
        subtitle.textContent = mode === 'login'
            ? 'Choose Google or your email and password to access your account.'
            : 'Register with Google or create an email and password account.';
    }
}

async function triggerGoogleAuth(mode = 'login') {
    const noticeId = mode === 'register' ? 'register-notice' : 'login-notice';
    showAuthNotice(noticeId, '');
    if (!hasFirebase()) {
        showAuthNotice(noticeId, 'Firebase Authentication is loading. Please try again in a moment.', true);
        return;
    }
    try {
        const profile = await window.RKFirebase.signInWithGoogle();
        if (!profile) {
            showAuthNotice(noticeId, 'Google sign-in was cancelled.', true);
            return;
        }
        store.user = profile;
        authSettled = true;
        await loadUserCollections(store.user);
        location.hash = postLoginHash(store.user);
        if (appReady && typeof renderPage === 'function') renderPage();
    } catch (error) {
        showAuthNotice(noticeId, authErrorMessage(error), true);
    }
}

function showLoginPage() {
    showTemplate('tpl-login');
    if (loginNotice) {
        showAuthNotice('login-notice', loginNotice, false);
    }
    syncGoogleAuthUi('login');
}

function showRegisterPage() {
    showTemplate('tpl-register');
    syncGoogleAuthUi('register');
}

async function handleLogin(event) {
    event.preventDefault();
    showAuthNotice('login-notice', '');
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;
    if (hasFirebase()) {
        try {
            const profile = await window.RKFirebase.signInWithEmail(email, password);
            store.user = profile;
            authSettled = true;
            await loadUserCollections(store.user);
            location.hash = postLoginHash(store.user);
            if (appReady && typeof renderPage === 'function') renderPage();
            return;
        } catch (fbError) {
            if (!['auth/user-not-found', 'auth/invalid-credential', 'auth/operation-not-allowed'].includes(fbError?.code)) {
                showAuthNotice('login-notice', authErrorMessage(fbError), true);
                return;
            }
            // Fallback: check migrated MongoDB password and enroll into Firebase Auth if enabled
            try {
                const legacy = await apiRequest('/api/auth/login', {
                    method: 'POST',
                    body: { email, password }
                });
                if (legacy?.user) {
                    if (fbError?.code !== 'auth/operation-not-allowed') {
                        try {
                            const migratedProfile = await window.RKFirebase.registerWithEmail(legacy.user.name, email, password);
                            store.user = migratedProfile || legacy.user;
                            authSettled = true;
                            await loadUserCollections(store.user);
                            location.hash = postLoginHash(store.user);
                            if (appReady && typeof renderPage === 'function') renderPage();
                            return;
                        } catch {
                            // Fall through to verified legacy session if Firebase Email/Password isn't enabled
                        }
                    }
                    setAuthToken(legacy.token);
                    store.user = legacy.user;
                    authSettled = true;
                    await loadUserCollections(store.user);
                    location.hash = postLoginHash(store.user);
                    if (appReady && typeof renderPage === 'function') renderPage();
                    return;
                }
            } catch {
                // Report Firebase error below
            }
            showAuthNotice('login-notice', authErrorMessage(fbError), true);
            return;
        }
    }
    try {
        const data = await apiRequest('/api/auth/login', {
            method: 'POST',
            body: { email, password }
        });
        setAuthToken(data.token);
        store.user = data.user;
        authSettled = true;
        await loadUserCollections(store.user);
        location.hash = postLoginHash(store.user);
        if (appReady && typeof renderPage === 'function') renderPage();
    } catch (error) {
        showAuthNotice('login-notice', authErrorMessage(error), true);
    }
}

async function handleRegister(event) {
    event.preventDefault();
    showAuthNotice('register-notice', '');
    const name = document.getElementById('reg-name').value.trim();
    const email = document.getElementById('reg-email').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirmPassword = document.getElementById('reg-confirm-password')?.value ?? password;
    if (password.length < 6) {
        showAuthNotice('register-notice', 'Password must be at least 6 characters.', true);
        return;
    }
    if (password !== confirmPassword) {
        showAuthNotice('register-notice', 'Passwords do not match. Please re-enter your password.', true);
        return;
    }
    if (hasFirebase()) {
        try {
            const profile = await window.RKFirebase.registerWithEmail(name, email, password);
            store.user = profile;
            authSettled = true;
            await loadUserCollections(store.user);
            showToast('Account created! Please check your email to verify your address.', 'success');
            location.hash = postLoginHash(store.user);
            if (appReady && typeof renderPage === 'function') renderPage();
            return;
        } catch (error) {
            showAuthNotice('register-notice', authErrorMessage(error), true);
            return;
        }
    }
    try {
        await apiRequest('/api/auth/register', {
            method: 'POST',
            body: { name, email, password }
        });
        loginNotice = 'Registration successful! Please sign in.';
        location.hash = '#/login';
    } catch (error) {
        showAuthNotice('register-notice', authErrorMessage(error), true);
    }
}

async function handlePasswordReset(event) {
    event.preventDefault();
    showAuthNotice('reset-notice', '');
    const emailInput = document.getElementById('reset-email');
    const email = (emailInput?.value || '').trim();
    if (!email) {
        showAuthNotice('reset-notice', 'Please enter your email address.', true);
        return;
    }
    const submitBtn = event.target?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
        if (hasFirebase()) {
            await window.RKFirebase.sendPasswordReset(email);
            showAuthNotice('reset-notice', 'If an account exists for this email, a password reset link has been sent to your inbox.', false);
            if (emailInput) emailInput.value = '';
        } else {
            const result = await apiRequest('/api/auth/forgot-password', {
                method: 'POST',
                body: { email }
            });
            showAuthNotice(
                'reset-notice',
                result?.message || 'If an account exists for this email, a password reset link has been created.',
                false
            );
            if (emailInput) emailInput.value = '';
        }
    } catch (error) {
        showAuthNotice('reset-notice', authErrorMessage(error), true);
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

async function handleCompletePasswordReset(event) {
    event.preventDefault();
    showAuthNotice('complete-reset-notice', '');
    const token = routeInfo().params.get('token') || '';
    const password = document.getElementById('new-password').value;
    const confirmation = document.getElementById('confirm-password').value;
    if (!token) {
        showAuthNotice('complete-reset-notice', 'This reset link is missing or invalid. Please request a new one.', true);
        return;
    }
    if (password.length < 6) {
        showAuthNotice('complete-reset-notice', 'Password must be at least 6 characters.', true);
        return;
    }
    if (password !== confirmation) {
        showAuthNotice('complete-reset-notice', 'Passwords do not match.', true);
        return;
    }
    const submitBtn = event.target?.querySelector('button[type="submit"]');
    if (submitBtn) submitBtn.disabled = true;
    try {
        await apiRequest('/api/auth/reset-password', {
            method: 'POST',
            body: { token, password }
        });
        loginNotice = 'Your password has been updated. You can now log in.';
        location.hash = '#/login';
    } catch (error) {
        showAuthNotice('complete-reset-notice', authErrorMessage(error), true);
    } finally {
        if (submitBtn) submitBtn.disabled = false;
    }
}

let processingOrder = false;

async function processOrder() {
    if (processingOrder) return;
    processingOrder = true;
    // Make sure a logged-in customer is recognised before the order is saved.
    await Promise.race([authReady, new Promise(resolve => setTimeout(resolve, 3000))]);
    const cart = getCart();
    if (!cart.length) {
        processingOrder = false;
        location.hash = '#/cart';
        return;
    }
    const user = getCurrentUser();
    if (!user) {
        processingOrder = false;
        requireLogin('#/checkout', 'Please log in or register to place your order.');
        return;
    }
    const order = {
        id: `ORD-${Date.now()}`,
        date: new Date().toLocaleDateString(),
        // Photos are left out so the order stays small; everything shown in orders is kept.
        items: cart.map(item => ({
            id: Number.isFinite(Number(item.id)) && String(item.id).trim() !== '' ? Number(item.id) : String(item.id),
            name: String(item.name),
            price: cartUnitPrice(item, cart),
            quantity: Number(item.quantity),
            options: item.options || {}
        })),
        total: cartTotal(cart),
        status: 'Awaiting WhatsApp confirmation',
        customer: user?.name || 'WhatsApp customer',
        email: user?.email || '',
        address: '',
        city: '',
        zip: '',
        uid: user?.uid || null,
        createdAtMs: Date.now()
    };
    try {
        let savedOrder = null;
        if (hasFirebaseUser()) {
            savedOrder = await window.RKFirebase.createOrder(order);
        } else {
            const saved = await Promise.race([
                apiRequest('/api/orders', { method: 'POST', body: order }),
                new Promise((_, reject) => setTimeout(() => reject(new Error('Saving the order timed out.')), 8000))
            ]);
            savedOrder = saved?.order || null;
        }
        if (savedOrder) {
            if (user.isAdmin) store.allOrders = [...store.allOrders, savedOrder];
            else store.myOrders = [...store.myOrders, savedOrder];
        }
    } catch (error) {
        // Never block the sale: the WhatsApp message still carries the full order.
        console.error('Order could not be saved to the database:', error);
    }
    rememberOrder(order);
    const whatsappUrl = `https://wa.me/260961005957?text=${encodeURIComponent(formatCartWhatsAppMessage(order))}`;
    localStorage.removeItem('cart');
    processingOrder = false;
    window.location.assign(whatsappUrl);
}

function formatCartWhatsAppMessage(order) {
    const messageCurrency = new Intl.NumberFormat('en-ZM', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
    const money = value => `K${messageCurrency.format(Number(value) || 0)}`;
    const items = order.items.map(item => {
        const options = Object.entries(item.options || {})
            .map(([name, value]) => `${name}: ${value}`)
            .join(', ');
        const details = options ? ` (${options})` : '';
        const subtotal = Number(item.price) * Number(item.quantity);
        return `• ${Number(item.quantity)}x ${item.name}${details} - ${money(subtotal)}`;
    });
    return [
        '🛒 *New Order from Website*',
        '-------------------------',
        ...items,
        '-------------------------',
        `💰 *Total Amount:* ${money(order.total)}`,
        '',
        'Please confirm my order!'
    ].join('\n');
}

function formatOrderMessage(order) {
    const items = order.items.map(item => `- ${item.name} x ${item.quantity}: ${formatMoney(Number(item.price) * Number(item.quantity))}`).join('\n');
    return [
        `New order for ${brand}`,
        `Order: ${order.id}`,
        `Customer: ${order.customer}`,
        `Email: ${order.email}`,
        `Delivery: ${order.address}, ${order.city} ${order.zip}`,
        'Items:',
        items,
        `Total: ${formatMoney(order.total)}`,
        `Status: ${order.status}`
    ].join('\n');
}

async function updateProfile() {
    const user = getCurrentUser();
    if (!user) return;
    const name = document.getElementById('profile-name').value.trim();
    try {
        if (hasFirebaseUser()) {
            await window.RKFirebase.updateProfileName(user.uid, name);
        } else {
            await apiRequest('/api/profile', { method: 'PATCH', body: { name } });
        }
    } catch (error) {
        console.warn(error);
        showToast('Profile could not be updated. Check your connection and try again.', 'error');
        return;
    }
    user.name = name;
    showToast('Profile updated.', 'success');
    renderDashboard('profile');
}

function getCategories(products = getProducts()) {
    return [...new Set([...getSavedCategories(), ...products.map(product => product.category).filter(Boolean)])]
        .sort((a, b) => a.localeCompare(b));
}

function categoryNeedsSize(category) {
    return getSizeCategories().includes(category);
}

function categoryNeedsColor(category) {
    return getColorCategories().includes(category);
}

async function saveCategories(
    categories,
    sizeCategories = getSizeCategories(),
    colorCategories = getColorCategories(),
    subcategories = getSubcategoriesMap()
) {
    const cleanSubs = {};
    for (const cat of categories) {
        const list = Array.isArray(subcategories?.[cat]) ? subcategories[cat].filter(Boolean) : [];
        if (list.length) cleanSubs[cat] = list;
    }
    try {
        if (hasFirebaseUser()) {
            const data = await window.RKFirebase.saveCategoriesMeta({
                list: categories,
                sizeCategories: sizeCategories.filter(category => categories.includes(category)),
                colorCategories: colorCategories.filter(category => categories.includes(category)),
                subcategories: cleanSubs
            });
            store.categories = Array.isArray(data.categories) ? data.categories : categories;
            store.sizeCategories = Array.isArray(data.sizeCategories) ? data.sizeCategories : [];
            store.colorCategories = Array.isArray(data.colorCategories) ? data.colorCategories : [];
            store.subcategories = data.subcategories && typeof data.subcategories === 'object' ? data.subcategories : cleanSubs;
            return true;
        }
        const data = await apiRequest('/api/admin/categories', {
            method: 'PUT',
            body: {
                list: categories,
                sizeCategories: sizeCategories.filter(category => categories.includes(category)),
                colorCategories: colorCategories.filter(category => categories.includes(category)),
                subcategories: cleanSubs
            }
        });
        store.categories = Array.isArray(data.categories) ? data.categories : categories;
        store.sizeCategories = Array.isArray(data.sizeCategories) ? data.sizeCategories : [];
        store.colorCategories = Array.isArray(data.colorCategories) ? data.colorCategories : [];
        store.subcategories = data.subcategories && typeof data.subcategories === 'object' ? data.subcategories : cleanSubs;
        return true;
    } catch (error) {
        console.warn(error);
        showToast(error.message || 'Categories could not be saved. Check your connection and admin access.', 'error');
        return false;
    }
}

async function addCategory(event) {
    event.preventDefault();
    const input = document.getElementById('new-category');
    const name = input.value.trim();
    if (!name) return;
    const categories = getCategories();
    if (categories.some(category => category.toLowerCase() === name.toLowerCase())) {
        showToast('That category already exists.', 'error');
        return;
    }
    categories.push(name);
    const sizeCategories = document.getElementById('new-category-size')?.checked ? [...getSizeCategories(), name] : getSizeCategories();
    const colorCategories = document.getElementById('new-category-color')?.checked ? [...getColorCategories(), name] : getColorCategories();
    if (await saveCategories(categories, sizeCategories, colorCategories, getSubcategoriesMap())) {
        showToast('Category added.', 'success');
        renderAdmin(lastAdminTab === 'categories' ? 'categories' : 'inventory');
    }
}

async function addSubcategory(event) {
    event.preventDefault();
    const parentSelect = document.getElementById('subcategory-parent');
    const input = document.getElementById('new-subcategory');
    const category = parentSelect?.value.trim() || '';
    const name = input?.value.trim() || '';
    if (!category) {
        showToast('Select a parent category first.', 'error');
        return;
    }
    if (!name) return;
    await saveNewSubcategory(category, name);
}

async function addInlineSubcategory(event, form) {
    event.preventDefault();
    const category = form?.dataset.category || '';
    const input = form?.querySelector('input');
    const name = input?.value.trim() || '';
    if (!category || !name) return;
    await saveNewSubcategory(category, name);
}

async function saveNewSubcategory(category, name) {
    const categories = getCategories();
    if (!categories.includes(category)) {
        showToast('Parent category was not found.', 'error');
        return;
    }
    const subMap = { ...getSubcategoriesMap() };
    const existing = Array.isArray(subMap[category]) ? [...subMap[category]] : [];
    if (existing.some(item => item.toLowerCase() === name.toLowerCase())) {
        showToast('That subcategory already exists under this category.', 'error');
        return;
    }
    existing.push(name);
    subMap[category] = existing;
    if (await saveCategories(categories, getSizeCategories(), getColorCategories(), subMap)) {
        showToast(`Subcategory "${name}" added.`, 'success');
        renderAdmin('categories');
    }
}

async function removeSubcategory(button) {
    const category = button.dataset.category || '';
    const subcategory = button.dataset.subcategory || '';
    if (!category || !subcategory) return;
    const subMap = { ...getSubcategoriesMap() };
    const nextList = (Array.isArray(subMap[category]) ? subMap[category] : []).filter(item => item !== subcategory);
    if (nextList.length) subMap[category] = nextList;
    else delete subMap[category];
    if (await saveCategories(getCategories(), getSizeCategories(), getColorCategories(), subMap)) {
        showToast('Subcategory removed.', 'success');
        renderAdmin('categories');
    }
}

async function toggleCategoryOption(button) {
    const category = button.dataset.category;
    const flip = list => (list.includes(category) ? list.filter(item => item !== category) : [...list, category]);
    const sizeCategories = button.dataset.option === 'size' ? flip(getSizeCategories()) : getSizeCategories();
    const colorCategories = button.dataset.option === 'color' ? flip(getColorCategories()) : getColorCategories();
    if (await saveCategories(getCategories(), sizeCategories, colorCategories, getSubcategoriesMap())) {
        renderAdmin(lastAdminTab === 'categories' ? 'categories' : 'inventory');
    }
}

// Colors and sizes are optional for every product.
function buildProductOptions(category, colorsText, sizesText) {
    const options = {};
    const colors = splitList(colorsText);
    if (colors.length) options.Color = colors;
    const sizes = splitList(sizesText);
    if (sizes.length) options.Size = sizes;
    return { options };
}

async function removeCategory(button) {
    const category = button.dataset.category || '';
    if (!category) return;
    const affectedProducts = getProducts().filter(product => product.category === category);
    const confirmMessage = affectedProducts.length
        ? `Delete category "${category}"? ${affectedProducts.length} ${affectedProducts.length === 1 ? 'product' : 'products'} in this category will become uncategorized.`
        : `Delete category "${category}"?`;
    if (!(await askConfirm(confirmMessage))) return;

    if (button) {
        button.disabled = true;
        button.textContent = 'Deleting…';
    }

    try {
        for (const prod of affectedProducts) {
            const updatedBody = { ...prod, category: '', subcategory: '' };
            let savedProd = updatedBody;
            if (hasFirebaseUser()) {
                savedProd = await window.RKFirebase.saveProduct(prod.id, updatedBody);
            } else {
                const res = await apiRequest(`/api/admin/products/${encodeURIComponent(String(prod.id))}`, {
                    method: 'PUT',
                    body: updatedBody
                });
                savedProd = res?.product || updatedBody;
            }
            store.products = store.products.map(item => (sameId(item.id, prod.id) ? savedProd : item));
        }
        const categories = getCategories().filter(item => item !== category);
        const subMap = { ...getSubcategoriesMap() };
        delete subMap[category];
        if (await saveCategories(categories, getSizeCategories(), getColorCategories(), subMap)) {
            showToast(`Category "${category}" deleted.`, 'success');
            renderAdmin(lastAdminTab === 'categories' ? 'categories' : 'inventory');
            return;
        }
    } catch (error) {
        showToast(error.message || 'Could not delete category right now.', 'error');
    }
    if (button) {
        button.disabled = false;
        button.textContent = 'Delete Category';
    }
}

const MAX_PHOTOS = 7;
const MAX_RAW_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_BUDGET = 115000; // characters per photo, so 7 photos always fit cleanly
let modalPhotos = [];
let pendingPhotoPromise = Promise.resolve();

function setProductNotice(message = '') {
    const el = document.getElementById('product-form-notice');
    if (!el) return;
    if (!message) {
        el.textContent = '';
        el.hidden = true;
        return;
    }
    el.textContent = message;
    el.hidden = false;
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderPhotoList() {
    const list = document.getElementById('product-photo-list');
    if (!list) return;
    list.innerHTML = modalPhotos.map((src, index) => `<div class="photo-thumb">
        <img src="${escapeHtml(resolveAssetUrl(src))}" alt="Product photo ${index + 1}">
        ${index === 0 ? '<span class="photo-main-tag">Main</span>' : `<button type="button" class="photo-main-btn" onclick="makeMainPhoto(${index})">Make main</button>`}
        <button type="button" class="photo-remove" aria-label="Remove photo ${index + 1}" onclick="removeProductPhoto(${index})">×</button>
    </div>`).join('');
}

function removeProductPhoto(index) {
    modalPhotos.splice(index, 1);
    renderPhotoList();
}

function makeMainPhoto(index) {
    const [photo] = modalPhotos.splice(index, 1);
    modalPhotos.unshift(photo);
    renderPhotoList();
}

async function addProductPhotos(event) {
    const input = event.target;
    const files = [...(input.files || [])];
    input.value = '';
    if (!files.length) return;
    setProductNotice('');
    const room = MAX_PHOTOS - modalPhotos.length;
    if (room <= 0) {
        const msg = 'You can add up to 7 photos per product.';
        setProductNotice(msg);
        showToast(msg, 'error');
        return;
    }
    if (files.length > room) {
        showToast(`Only ${room} more photo${room === 1 ? '' : 's'} can be added (7 maximum). The first ${room} were kept.`);
    }
    const saveBtn = document.getElementById('product-save-button');
    const prevLabel = saveBtn ? saveBtn.textContent : '';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Processing photo…';
    }
    const task = (async () => {
        for (const file of files.slice(0, room)) {
            if (!isImageFile(file)) {
                const msg = `"${file.name}" is not an image file.`;
                setProductNotice(msg);
                showToast(msg, 'error');
                continue;
            }
            if (file.size > MAX_RAW_PHOTO_BYTES) {
                const msg = `"${file.name}" is larger than 20 MB.`;
                setProductNotice(msg);
                showToast(msg, 'error');
                continue;
            }
            try {
                const photo = await compressImage(file);
                if (modalPhotos.length < MAX_PHOTOS) modalPhotos.push(photo);
                renderPhotoList();
            } catch (error) {
                setProductNotice(error.message);
                showToast(error.message, 'error');
            }
        }
    })().finally(() => {
        if (saveBtn && !savingProduct) {
            saveBtn.disabled = false;
            saveBtn.textContent = prevLabel || 'Save Product';
        }
    });
    pendingPhotoPromise = pendingPhotoPromise.then(() => task, () => task);
    await task;
}

function syncProductSubcategoryOptions(selectedSubcategory = '') {
    const category = document.getElementById('p-category')?.value || '';
    const subSelect = document.getElementById('p-subcategory');
    if (!subSelect) return;
    const subs = [...getSubcategoriesFor(category)];
    const cleanSelected = String(selectedSubcategory || '').trim();
    if (cleanSelected && !subs.includes(cleanSelected)) {
        subs.push(cleanSelected);
    }
    subSelect.innerHTML = `<option value="">None (optional)</option>${subs.map(sub => `<option value="${escapeHtml(sub)}">${escapeHtml(sub)}</option>`).join('')}`;
    subSelect.value = cleanSelected;
}

function syncVariantFields() {
    const colorField = document.getElementById('color-field');
    const sizeField = document.getElementById('size-field');
    if (colorField) colorField.hidden = false;
    if (sizeField) sizeField.hidden = false;
}

function openProductModal(productId = null) {
    const modal = document.getElementById('product-modal');
    const form = document.getElementById('product-form');
    if (!modal || !form) return;
    const product = productId === null
        ? null
        : getProducts().find(item => sameId(item.id, productId));
    if (productId !== null && !product) {
        showToast('Product could not be found.', 'error');
        return;
    }
    form.reset();
    setProductNotice('');
    document.getElementById('p-id').value = product ? String(product.id) : '';
    document.getElementById('p-name').value = product?.name || '';
    document.getElementById('p-price').value = product?.price ?? '';
    document.getElementById('p-promo-price').value = product?.promoPrice ?? '';
    document.getElementById('p-bulk-price').value = product?.bulkPrice ?? '';
    document.getElementById('p-bulk-qty').value = product?.bulkMinQty ?? '';
    const categorySelect = document.getElementById('p-category');
    const availableCategories = getCategories();
    const categoryList = availableCategories.length ? availableCategories : ['General'];
    categorySelect.innerHTML = categoryList.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    const wantedCategory = product?.category || 'Electronics';
    categorySelect.value = [...categorySelect.options].some(option => option.value === wantedCategory)
        ? wantedCategory
        : (categorySelect.options[0]?.value ?? '');
    syncProductSubcategoryOptions(product?.subcategory || '');
    document.getElementById('p-desc').value = product?.description || '';
    document.getElementById('p-colors').value = (product?.options?.Color || []).join(', ');
    document.getElementById('p-sizes').value = (product?.options?.Size || []).join(', ');
    syncVariantFields();
    document.getElementById('product-modal-title').textContent = product ? 'Edit Product' : 'Add New Product';
    const saveBtn = document.getElementById('product-save-button');
    saveBtn.disabled = false;
    saveBtn.textContent = product ? 'Save Changes' : 'Save Product';
    modalPhotos = product ? getProductPhotos(product) : [];
    renderPhotoList();
    modal.hidden = false;
}

function closeProductModal() {
    const modal = document.getElementById('product-modal');
    if (modal) modal.hidden = true;
    setProductNotice('');
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('The selected photo could not be read.'));
        img.src = src;
    });
}

// Accepts a File or an existing data URL; returns a JPEG data URL within the per-photo size budget.
async function compressImage(source, budget = PHOTO_BUDGET) {
    const isFile = typeof source !== 'string';
    const url = isFile ? URL.createObjectURL(source) : source;
    try {
        const img = await loadImage(url);
        let side = 800;
        let quality = 0.8;
        for (let attempt = 0; attempt < 14; attempt++) {
            const scale = Math.min(1, side / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const context = canvas.getContext('2d');
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.drawImage(img, 0, 0, canvas.width, canvas.height);
            const dataUrl = canvas.toDataURL('image/jpeg', quality);
            if (dataUrl.length <= budget) return dataUrl;
            if (quality > 0.5) quality -= 0.1;
            else side = Math.round(side * 0.85);
        }
        throw new Error('That photo is too detailed to store. Try a smaller image.');
    } finally {
        if (isFile) URL.revokeObjectURL(url);
    }
}

function splitList(value) {
    const items = String(value || '').split(',').map(item => item.trim().slice(0, 40)).filter(Boolean);
    const seen = new Set();
    return items.filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    }).slice(0, 40);
}

let savingProduct = false;

async function saveNewProduct(event) {
    event.preventDefault();
    if (savingProduct) return;
    setProductNotice('');
    await pendingPhotoPromise;
    if (!modalPhotos.length) {
        const msg = 'Add at least one product photo before saving.';
        setProductNotice(msg);
        showToast(msg, 'error');
        return;
    }
    const products = getProducts();
    const productId = document.getElementById('p-id').value;
    const existingIndex = products.findIndex(product => String(product.id) === productId);
    const category = document.getElementById('p-category').value || 'General';
    const promoPriceText = document.getElementById('p-promo-price').value.trim();
    const bulkPriceText = document.getElementById('p-bulk-price').value.trim();
    const bulkQtyText = document.getElementById('p-bulk-qty').value.trim();
    const normalPrice = Number(document.getElementById('p-price').value);
    let promoPrice = null;
    if (promoPriceText !== '') {
        const parsedPromo = Number(promoPriceText);
        if (!Number.isFinite(parsedPromo) || !(parsedPromo >= 0) || !(parsedPromo < normalPrice)) {
            const msg = 'The promotion amount must be lower than the actual price.';
            setProductNotice(msg);
            showToast(msg, 'error');
            return;
        }
        promoPrice = parsedPromo;
    }
    let bulk = null;
    if (bulkPriceText || bulkQtyText) {
        const bulkPrice = Number(bulkPriceText);
        const bulkMinQty = Number(bulkQtyText);
        if (!bulkPriceText || !bulkQtyText) {
            const msg = 'Enter both the bulk price and the quantity it applies from, or leave both empty.';
            setProductNotice(msg);
            showToast(msg, 'error');
            return;
        }
        if (!(bulkPrice >= 0) || !(bulkPrice < normalPrice)) {
            const msg = 'The bulk price must be lower than the normal price.';
            setProductNotice(msg);
            showToast(msg, 'error');
            return;
        }
        if (!Number.isInteger(bulkMinQty) || bulkMinQty < 2) {
            const msg = 'The bulk quantity must be a whole number of 2 or more.';
            setProductNotice(msg);
            showToast(msg, 'error');
            return;
        }
        bulk = { bulkPrice, bulkMinQty };
    }
    const built = buildProductOptions(category, document.getElementById('p-colors').value, document.getElementById('p-sizes').value);
    if (built.error) {
        setProductNotice(built.error);
        showToast(built.error, 'error');
        return;
    }
    savingProduct = true;
    const saveBtn = document.getElementById('product-save-button');
    const originalBtnText = saveBtn ? saveBtn.textContent : 'Save Product';
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';
    }
    try {
        // Compress oversized raw photos before uploading to Cloudinary / saving
        let photos = await Promise.all(
            modalPhotos.map(src => (src.startsWith('data:image/') && src.length > PHOTO_BUDGET ? compressImage(src) : src))
        );
        const subcategory = (document.getElementById('p-subcategory')?.value || '').trim();
        const targetId = existingIndex >= 0 ? String(products[existingIndex].id) : String(Date.now());

        if (hasFirebaseUser()) {
            const uploadedPhotos = [];
            for (let i = 0; i < photos.length; i++) {
                let src = photos[i];
                if (typeof src === 'string' && src.startsWith('data:image/')) {
                    const uploadRes = await apiRequest('/api/media/upload', {
                        method: 'POST',
                        body: { dataUri: src, productId: targetId, index: i }
                    });
                    if (!uploadRes?.url) {
                        throw new Error('Could not upload photo to Cloudinary.');
                    }
                    src = uploadRes.url;
                }
                uploadedPhotos.push(src);
            }
            photos = uploadedPhotos;
        }

        const product = {
            id: targetId,
            name: document.getElementById('p-name').value.trim(),
            price: normalPrice,
            image: photos[0],
            gallery: photos.slice(1),
            category,
            description: document.getElementById('p-desc').value.trim()
        };
        if (subcategory) product.subcategory = subcategory;
        if (promoPrice !== null) product.promoPrice = promoPrice;
        if (bulk) Object.assign(product, bulk);
        if (Object.keys(built.options).length) product.options = built.options;

        let nextProduct = product;
        if (hasFirebaseUser()) {
            nextProduct = await window.RKFirebase.saveProduct(targetId, product);
        } else {
            const saved = await apiRequest(`/api/admin/products/${encodeURIComponent(targetId)}`, {
                method: 'PUT',
                body: product
            });
            nextProduct = saved?.product || product;
        }

        if (existingIndex >= 0) {
            store.products = store.products.map((item, idx) => idx === existingIndex ? nextProduct : item);
        } else {
            store.products = [...store.products, nextProduct];
        }
    } catch (error) {
        console.warn('[Save Product Error]', error);
        const msg = error.message || 'Product could not be saved. Check your connection and that you are signed in as an admin.';
        setProductNotice(msg);
        showToast(msg, 'error');
        return;
    } finally {
        savingProduct = false;
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = originalBtnText;
        }
    }
    closeProductModal();
    showToast(existingIndex >= 0 ? 'Product updated.' : 'Product added!', 'success');
    renderAdmin('inventory');
}

async function deleteProduct(id) {
    if (!(await askConfirm('Delete this product?'))) return;
    try {
        if (hasFirebaseUser()) {
            await window.RKFirebase.deleteProduct(id);
        } else {
            await apiRequest(`/api/admin/products/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
        }
        store.products = store.products.filter(item => !sameId(item.id, id));
        showToast('Product deleted.', 'success');
    } catch (error) {
        console.warn(error);
        showToast(error.message || 'Product could not be deleted. Check your connection and admin access.', 'error');
        return;
    }
    renderAdmin('inventory');
}

document.getElementById('primary-navigation')?.addEventListener('click', event => {
    if (event.target.closest('a')) toggleMenu(true);
});

document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
        toggleMenu(true);
        closeProductModal();
    }
});

// Re-draw the current page when shared data changes on another device,
// without interrupting typing, an open product form, or the current tab.
function refreshView() {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const { page } = routeInfo();
    if (page === 'home') renderHome();
    else if (page === 'category') renderCategory();
    else if (page === 'search') renderSearch();
    else if (page === 'admin') {
        if (document.getElementById('product-modal')?.hidden === false) return;
        renderAdmin(lastAdminTab);
    } else if (['profile', 'dashboard'].includes(page) && lastDashboardTab === 'orders') renderDashboard('orders');
}

window.addEventListener('hashchange', () => {
    if (appReady) renderPage();
});

async function migratePhotosToCloudinary(button) {
    if (button) {
        button.disabled = true;
        button.textContent = 'Moving photos to Cloudinary…';
    }
    try {
        const result = await apiRequest('/api/admin/migrate-photos', { method: 'POST' });
        store.mediaStatus.legacyPhotoCount = Number(result?.remainingLegacy) || 0;
        await loadStoreData({ silent: true });
        showToast(`Moved ${result?.uploadedPhotos || 0} photos across ${result?.migratedProducts || 0} products to Cloudinary!`, 'success');
        renderAdmin('inventory');
    } catch (error) {
        showToast(error.message || 'Could not migrate photos to Cloudinary.', 'error');
        if (button) {
            button.disabled = false;
            button.textContent = `Move ${store.mediaStatus?.legacyPhotoCount || ''} Photos to Cloudinary`;
        }
    }
}

async function runMongoToFirebaseMigration(button) {
    if (!hasFirebaseUser()) {
        showToast('Please sign in with Google as admin first to migrate into Firebase.', 'error');
        return;
    }
    if (store.migratingToFirebase) return;
    store.migratingToFirebase = true;
    store.migrationProgress = 'Exporting products, categories, user passwords & orders from MongoDB…';
    if (button) button.disabled = true;
    renderAdmin('overview');

    try {
        const exportData = await apiRequest('/api/admin/mongodb-export');
        const uploadPhotoFn = exportData.cloudinaryConfigured
            ? async (prodId, idx, dataUri) => {
                const up = await apiRequest('/api/media/upload', {
                    method: 'POST',
                    body: { dataUri, productId: prodId, index: idx }
                });
                return up?.url || '';
            }
            : null;

        const report = await window.RKFirebase.migrateFromMongoExport(exportData, {
            uploadPhotoFn,
            onProgress: (msg) => {
                store.migrationProgress = msg;
                const el = document.querySelector('.migration-progress');
                if (el) el.textContent = msg;
            }
        });

        store.needsMongoMigration = false;
        store.migrationProgress = `Migration complete: ${report.products} products, ${report.categories} categories, ${report.users} users (${report.credentials} passwords), ${report.orders} orders, ${report.messages} messages${report.cloudinaryPhotos ? `, ${report.cloudinaryPhotos} photos uploaded to Cloudinary` : ''}.`;
        await loadStoreData({ silent: true });
        await loadUserCollections(store.user);
        showToast('MongoDB to Firebase migration completed!', 'success');
    } catch (error) {
        console.warn('[Migration Error]', error);
        store.migrationProgress = `Migration failed: ${error?.message || 'Unknown error'}`;
        showToast(error?.message || 'Migration failed.', 'error');
    } finally {
        store.migratingToFirebase = false;
        renderAdmin('overview');
    }
}

setInterval(async () => {
    if (!appReady || document.visibilityState !== 'visible') return;
    await loadStoreData({ silent: true });
    if (store.user) await loadUserCollections(store.user);
    refreshView();
}, 60000);

function trackSiteVisit() {
    if (routeInfo().page === 'admin') return;
    try {
        if (!sessionStorage.getItem('rk_visit_logged')) {
            let visitorId = localStorage.getItem('rk_visitor_id');
            if (!visitorId) {
                visitorId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
                    ? crypto.randomUUID()
                    : `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
                localStorage.setItem('rk_visitor_id', visitorId);
            }
            sessionStorage.setItem('rk_visit_logged', '1');
            fetch(resolveApiUrl('/api/analytics/visit'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ visitorId })
            }).catch(() => {});
        }
        if (hasFirebase() && !sessionStorage.getItem('rk_fb_site_view')) {
            sessionStorage.setItem('rk_fb_site_view', '1');
            window.RKFirebase.trackPageView({ type: 'site', targetId: 'site', label: 'Total Website Views' }).catch(() => {});
        }
    } catch {
        // Ignore storage restrictions
    }
}

(async function boot() {
    trackSiteVisit();
    await dataReady;
    appReady = true;
    if (!location.hash) location.hash = '#/home';
    else renderPage();
})();
