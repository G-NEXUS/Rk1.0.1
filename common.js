// Shared storefront data (MongoDB via Express API) and cart helpers.
// Products, categories, accounts, orders and messages live in MongoDB.
// The shopping cart stays in this browser's localStorage, as before.

const AUTH_TOKEN_KEY = 'rk_auth_token';

// In-memory copy of the data, kept fresh by the MongoDB API.
const store = {
    products: [],
    categories: [],
    sizeCategories: [],      // categories whose products have sizes
    colorCategories: [],     // categories whose products have colors
    allOrders: [],      // admin only
    myOrders: [],       // signed-in customer's own orders
    messages: [],       // contact-form messages (admin only)
    adminStats: { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 },
    recentOrders: {},   // orders placed in this session
    user: null,         // { uid, name, email, isAdmin }
    loadError: false    // true when the product list could not be loaded
};

let appReady = false;
let authSettled = false;
let syncCounter = 0;

function sameId(first, second) {
    return String(first ?? '') === String(second ?? '');
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

async function apiRequest(url, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body !== undefined && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
    }
    const token = getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let response;
    try {
        response = await fetch(url, {
            method: options.method || 'GET',
            headers,
            body: options.body !== undefined ? JSON.stringify(options.body) : undefined
        });
    } catch {
        const netErr = new Error('Network error. Check your connection and try again.');
        netErr.code = 'auth/network-request-failed';
        throw netErr;
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
    try {
        const [productsData, categoriesData] = await Promise.all([
            apiRequest('/api/products'),
            apiRequest('/api/categories')
        ]);
        store.loadError = false;
        store.products = Array.isArray(productsData.products) ? productsData.products : [];
        store.categories = Array.isArray(categoriesData.categories) ? categoriesData.categories : [];
        store.sizeCategories = Array.isArray(categoriesData.sizeCategories) ? categoriesData.sizeCategories : [];
        store.colorCategories = Array.isArray(categoriesData.colorCategories) ? categoriesData.colorCategories : [];
        if (appReady && typeof refreshView === 'function') refreshView();
    } catch (error) {
        console.error('Could not load storefront data:', error);
        if (!silent) store.loadError = true;
    }
}

async function loadUserCollections(user) {
    if (!user) {
        store.allOrders = [];
        store.myOrders = [];
        store.messages = [];
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
        console.error('Could not load orders:', error);
    }
    if (user.isAdmin) {
        try {
            const messagesData = await apiRequest('/api/messages');
            store.messages = Array.isArray(messagesData.messages) ? messagesData.messages : [];
        } catch (error) {
            console.error('Could not load messages:', error);
        }
        try {
            const statsData = await apiRequest('/api/admin/stats');
            store.adminStats = {
                registeredUsers: Number(statsData.registeredUsers) || 0,
                websiteVisitors: Number(statsData.websiteVisitors) || 0,
                totalViews: Number(statsData.totalViews) || 0
            };
        } catch (error) {
            console.error('Could not load admin stats:', error);
        }
    } else {
        store.messages = [];
        store.adminStats = { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
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
        console.error('Could not check login status:', error);
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

const authReady = syncSession({ redraw: true });

// The shop waits only for the product list, never for login, so visitors who are not
// logged in see the goods straight away. Allow up to 45 s for Render cold starts.
const dataReady = Promise.race([
    loadStoreData(),
    new Promise(resolve => setTimeout(() => {
        console.warn('Server is slow to respond; showing the shop with what has loaded.');
        resolve();
    }, 45000))
]);

function logout() {
    setAuthToken('');
    store.user = null;
    store.allOrders = [];
    store.myOrders = [];
    store.messages = [];
    document.body.classList.remove('is-admin-view');
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

// ---------- Bulk pricing ----------
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
    return bulkApplies(item, cart) ? Number(item.bulkPrice) : (Number(item.price) || 0);
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
    } else if (['home', 'product'].includes(page)) {
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

function productCard(product) {
    const needsOptions = hasOptions(product);
    const inCart = isInCart(product.id);
    const idleText = needsOptions ? 'Select Options' : 'Add to Cart';
    const safeId = escapeHtml(String(product.id));
    return `<article class="product-card">
        <div class="product-image"><a href="#/product?id=${encodeURIComponent(product.id)}"><img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}"></a></div>
        <div class="product-info">
            <div><h3 class="product-title">${escapeHtml(product.name)}</h3><p class="product-price">${formatMoney(product.price)}</p>${bulkLineMarkup(product)}</div>
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

function renderHome() {
    const products = getProducts();
    app.innerHTML = `${heroMarkup()}
    <section class="shop-section">
        <h2 class="section-title">Our Products</h2>
        ${products.length ? productSectionsMarkup(products) : `<p>${store.loadError ? 'Products could not be loaded right now. Please check your connection and refresh the page.' : 'No products available yet.'}</p>`}
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
    const matches = products.filter(product => [product.name, product.category, product.description]
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
    const photos = getProductPhotos(product);
    const productId = String(product.id);
    const safeId = escapeHtml(productId);
    const inCart = isInCart(productId);
    app.innerHTML = `<div class="product-detail-container">
        <div class="detail-image">
            <img id="detail-main-image" src="${escapeHtml(photos[0] || '')}" alt="${escapeHtml(product.name)}">
            ${photos.length > 1 ? `<div class="gallery-thumbs">${photos.map((src, index) => `<button type="button" class="gallery-thumb${index === 0 ? ' is-active' : ''}" aria-label="Show photo ${index + 1} of ${photos.length}" onclick="showProductPhoto(${index})"><img src="${escapeHtml(src)}" alt=""></button>`).join('')}</div>` : ''}
        </div>
        <div class="detail-info">
            <p class="eyebrow">${escapeHtml(product.category)}</p>
            <h1>${escapeHtml(product.name)}</h1>
            <p class="detail-price">${formatMoney(product.price)}</p>
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
                            <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" class="cart-product-image">
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
                <p class="profile-guest-sub">Log in or create an account to place orders, view your order history, and manage your profile.</p>
                <div class="profile-auth-actions">
                    <a href="#/login" class="btn btn-full">Login</a>
                    <a href="#/register" class="btn btn-outline btn-full">Register</a>
                </div>
            </div>
            ${profileQuickLinksMarkup()}
        </section>`;
        return;
    }
    const orders = getMyOrders();
    let content = '';
    if (tab === 'orders') {
        content = `<h2 class="mb-20">Order History</h2>${orders.length ? [...orders].reverse().map(order => `<article class="order-card"><div class="order-header"><div><strong>Order ${escapeHtml(order.id)}</strong><p>Placed on ${escapeHtml(order.date)}</p></div><span class="status-badge">${escapeHtml(order.status)}</span></div><div class="summary-row"><span>${order.items.length} items</span><strong class="text-accent">${formatMoney(order.total)}</strong></div></article>`).join('') : '<article class="order-card"><p>No orders found yet.</p><a href="#/home" class="btn btn-small mt-20">Start Shopping</a></article>'}`;
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
        const sales = orders.reduce((sum, order) => sum + Number(order.total), 0);
        const stats = store.adminStats || { registeredUsers: 0, websiteVisitors: 0, totalViews: 0 };
        content = `<h2 class="mb-20">Store Overview</h2>
            <div class="stats-grid overview-stats">
                <div class="stat-card stat-card-featured"><p>Total Sales</p><div class="stat-val">${formatMoney(sales)}</div></div>
                <div class="stat-card"><p>Inventory</p><div class="stat-val">${products.length}</div></div>
                <div class="stat-card"><p>Total Orders</p><div class="stat-val">${orders.length}</div></div>
                <div class="stat-card"><p>Registered Users</p><div class="stat-val">${Number(stats.registeredUsers) || 0}</div></div>
                <div class="stat-card"><p>Website Visitors</p><div class="stat-val">${Number(stats.websiteVisitors) || 0}</div><small>${Number(stats.totalViews) || 0} total view${Number(stats.totalViews) === 1 ? '' : 's'}</small></div>
            </div>`;
    } else if (tab === 'inventory') {
        content = `<h2 class="mb-20">Inventory Management</h2>
            <div class="stats-grid inventory-stats">
                <div class="stat-card"><p>Inventory</p><div class="stat-val">${products.length}</div></div>
                <div class="stat-card"><p>Total Orders</p><div class="stat-val">${orders.length}</div></div>
            </div>
            <section class="category-manager" aria-labelledby="category-manager-title">
                <h3 id="category-manager-title">Product Categories</h3>
                <form class="category-form" onsubmit="addCategory(event)">
                    <label class="sr-only" for="new-category">New category name</label>
                    <input id="new-category" placeholder="New category name" maxlength="40" required>
                    <label class="category-variant-check"><input type="checkbox" id="new-category-size"> Needs size</label>
                    <label class="category-variant-check"><input type="checkbox" id="new-category-color"> Needs color</label>
                    <button class="btn" type="submit">Add Category</button>
                </form>
                <ul class="category-list">${categories.map(category => `<li><span>${escapeHtml(category)}</span>${[['size', 'Size', categoryNeedsSize(category)], ['color', 'Color', categoryNeedsColor(category)]].map(([option, label, on]) => `<button type="button" class="category-toggle${on ? ' is-on' : ''}" aria-pressed="${on}" aria-label="${label} option for ${escapeHtml(category)}: ${on ? 'on' : 'off'}" data-category="${escapeHtml(category)}" data-option="${option}" onclick="toggleCategoryOption(this)">${label}: ${on ? 'On' : 'Off'}</button>`).join('')}<button type="button" class="remove-btn" aria-label="Remove ${escapeHtml(category)} category" data-category="${escapeHtml(category)}" onclick="removeCategory(this)">Remove</button></li>`).join('')}</ul>
            </section>
            <div class="inventory-add-wrap">
                <button type="button" class="btn" onclick="openProductModal()">+ Add Product</button>
            </div>
            <div class="table-wrap"><table><thead><tr><th>ID</th><th>Photo</th><th>Product</th><th>Category</th><th>Price</th><th>Actions</th></tr></thead><tbody>${products.map(product => { const safeId = escapeHtml(String(product.id)); return `<tr><td>${safeId}</td><td><img class="inventory-thumb" src="${escapeHtml(product.image)}" alt=""></td><td>${escapeHtml(product.name)}</td><td>${escapeHtml(product.category)}</td><td>${formatMoney(product.price)}${hasBulk(product) ? `<br><small>${formatMoney(product.bulkPrice)} for ${Number(product.bulkMinQty)}+</small>` : ''}</td><td><div class="inventory-actions"><button class="btn btn-outline btn-small" onclick="openProductModal('${safeId}')">Edit</button><button class="remove-btn" onclick="deleteProduct('${safeId}')">Delete</button></div></td></tr>`; }).join('')}</tbody></table></div>`;
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
    app.innerHTML = `<div class="admin-page">
        <div class="admin-header">
            <span class="admin-header-badge">Admin Dashboard</span>
            <a href="#/profile" class="btn btn-outline btn-small">← Profile</a>
        </div>
        <section>${content}</section>
        <nav class="admin-bottom-nav" aria-label="Admin sections">
            <div class="admin-bottom-nav-inner">
                ${adminNavItems.map(item => `<button type="button" class="admin-bottom-item${tab === item.key ? ' is-active' : ''}" aria-current="${tab === item.key ? 'page' : 'false'}" onclick="renderAdmin('${item.key}')">
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
            <td>${escapeHtml(order.date)}</td><td>${formatMoney(order.total)}</td></tr>`;
    }).join('');
    return `<h2 class="mb-20">Order Tracking</h2>
        <p class="form-hint mb-20">For each item, enter how many units were sold and how many were unavailable (they can add up to at most the quantity ordered). These numbers feed the monthly report.</p>
        <div class="table-wrap"><table><thead><tr><th>Order ID</th><th>Customer</th><th>Email</th><th>Delivery Address</th><th>Items</th><th>Date</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function saveOrderItems(order, items) {
    const reportedAtMs = Date.now();
    try {
        const data = await apiRequest(`/api/orders/${encodeURIComponent(order.id)}`, {
            method: 'PUT',
            body: { items, reportedAtMs }
        });
        const nextOrder = data?.order || { ...order, items, reportedAtMs };
        store.allOrders = store.allOrders.map(entry => entry.id === order.id ? nextOrder : entry);
    } catch (error) {
        console.error(error);
        alert('The order could not be updated. Check your connection and admin access.');
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
        alert(`Only ${quantity} ordered, so Sold and Unavailable can add up to at most ${quantity}.`);
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
        const data = await Promise.race([
            apiRequest('/api/messages', { method: 'POST', body: message }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Sending timed out.')), 8000))
        ]);
        if (user?.isAdmin && data?.message) {
            store.messages = [...store.messages, data.message];
        }
    } catch (error) {
        console.error(error);
        alert('Your message could not be sent. Please check your connection and try again.');
        return;
    } finally {
        sendingMessage = false;
    }
    alert('Message sent! We will get back to you soon.');
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
        const data = await apiRequest(`/api/messages/${encodeURIComponent(id)}`, {
            method: 'PATCH',
            body: { read }
        });
        store.messages = store.messages.map(item => item.id === id ? (data?.message || { ...item, read: Boolean(read) }) : item);
    } catch (error) {
        console.error(error);
        alert('The message could not be updated. Check your connection and admin access.');
    }
    renderAdmin('contacts');
}

async function deleteMessage(id) {
    if (!confirm('Delete this message?')) return;
    try {
        await apiRequest(`/api/messages/${encodeURIComponent(id)}`, { method: 'DELETE' });
        store.messages = store.messages.filter(item => item.id !== id);
    } catch (error) {
        console.error(error);
        alert('The message could not be deleted. Check your connection and admin access.');
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
    const pages = {
        home: renderHome, search: renderSearch, product: renderProduct,
        login: showLoginPage, register: () => showTemplate('tpl-register'),
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
        alert(`Please select ${missing.map(select => select.dataset.optionName.toLowerCase()).join(' and ')}.`);
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
            alert('Just a moment, still checking your login. Please try again.');
        } else {
            requireLogin(location.hash || '#/home', 'Please log in or register to place an order.');
        }
        return;
    }
    const products = getProducts();
    const product = products.find(item => sameId(item.id, productId));
    if (!product) {
        alert('This product is no longer available.');
        return;
    }
    const selected = readSelectedOptions();
    if (!selected) return;
    const quantity = Math.max(1, Number.parseInt(document.getElementById('product-qty')?.value, 10) || 1);
    const options = Object.entries(selected).map(([name, value]) => `${name}: ${value}`);
    const unitPrice = hasBulk(product) && quantity >= Number(product.bulkMinQty) ? Number(product.bulkPrice) : Number(product.price);
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

function showLoginPage() {
    showTemplate('tpl-login');
    if (loginNotice) {
        showAuthNotice('login-notice', loginNotice, false);
    }
}

async function handleLogin(event) {
    event.preventDefault();
    showAuthNotice('login-notice', '');
    const email = document.getElementById('login-email').value.trim().toLowerCase();
    const password = document.getElementById('login-password').value;
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
    try {
        await apiRequest('/api/auth/register', {
            method: 'POST',
            body: { name, email, password }
        });
        loginNotice = 'Registration successful! Please login.';
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
        const saved = await Promise.race([
            apiRequest('/api/orders', { method: 'POST', body: order }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Saving the order timed out.')), 8000))
        ]);
        if (saved?.order) {
            if (user.isAdmin) store.allOrders = [...store.allOrders, saved.order];
            else store.myOrders = [...store.myOrders, saved.order];
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
        await apiRequest('/api/profile', { method: 'PATCH', body: { name } });
    } catch (error) {
        console.error(error);
        alert('Profile could not be updated. Check your connection and try again.');
        return;
    }
    user.name = name;
    alert('Profile updated.');
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

async function saveCategories(categories, sizeCategories = getSizeCategories(), colorCategories = getColorCategories()) {
    try {
        const data = await apiRequest('/api/admin/categories', {
            method: 'PUT',
            body: {
                list: categories,
                sizeCategories: sizeCategories.filter(category => categories.includes(category)),
                colorCategories: colorCategories.filter(category => categories.includes(category))
            }
        });
        store.categories = Array.isArray(data.categories) ? data.categories : categories;
        store.sizeCategories = Array.isArray(data.sizeCategories) ? data.sizeCategories : [];
        store.colorCategories = Array.isArray(data.colorCategories) ? data.colorCategories : [];
        return true;
    } catch (error) {
        console.error(error);
        alert('Categories could not be saved. Check your connection and admin access.');
        return false;
    }
}

async function addCategory(event) {
    event.preventDefault();
    const input = document.getElementById('new-category');
    const name = input.value.trim();
    const categories = getCategories();
    if (categories.some(category => category.toLowerCase() === name.toLowerCase())) {
        alert('That category already exists.');
        return;
    }
    categories.push(name);
    const sizeCategories = document.getElementById('new-category-size').checked ? [...getSizeCategories(), name] : getSizeCategories();
    const colorCategories = document.getElementById('new-category-color').checked ? [...getColorCategories(), name] : getColorCategories();
    if (await saveCategories(categories, sizeCategories, colorCategories)) renderAdmin('inventory');
}

async function toggleCategoryOption(button) {
    const category = button.dataset.category;
    const flip = list => (list.includes(category) ? list.filter(item => item !== category) : [...list, category]);
    const sizeCategories = button.dataset.option === 'size' ? flip(getSizeCategories()) : getSizeCategories();
    const colorCategories = button.dataset.option === 'color' ? flip(getColorCategories()) : getColorCategories();
    if (await saveCategories(getCategories(), sizeCategories, colorCategories)) renderAdmin('inventory');
}

// Colors and sizes are asked for separately, depending on the product's category.
function buildProductOptions(category, colorsText, sizesText) {
    const options = {};
    if (categoryNeedsColor(category)) {
        const colors = splitList(colorsText);
        if (!colors.length) return { error: 'Enter at least one color for this category.' };
        options.Color = colors;
    }
    if (categoryNeedsSize(category)) {
        const sizes = splitList(sizesText);
        if (!sizes.length) return { error: 'Enter at least one size for this category.' };
        options.Size = sizes;
    }
    return { options };
}

async function removeCategory(button) {
    const category = button.dataset.category;
    if (getProducts().some(product => product.category === category)) {
        alert('This category is assigned to products. Reassign those products before removing it.');
        return;
    }
    const categories = getSavedCategories().filter(item => item !== category);
    if (await saveCategories(categories)) renderAdmin('inventory');
}

const MAX_PHOTOS = 7;
const PHOTO_BUDGET = 115000; // characters per photo, so 7 photos always fit in one 1 MB Firestore document
let modalPhotos = [];

function renderPhotoList() {
    const list = document.getElementById('product-photo-list');
    if (!list) return;
    list.innerHTML = modalPhotos.map((src, index) => `<div class="photo-thumb">
        <img src="${escapeHtml(src)}" alt="Product photo ${index + 1}">
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
    const files = [...input.files];
    input.value = '';
    if (!files.length) return;
    const room = MAX_PHOTOS - modalPhotos.length;
    if (room <= 0) {
        alert('You can add up to 7 photos per product.');
        return;
    }
    if (files.length > room) {
        alert(`Only ${room} more photo${room === 1 ? '' : 's'} can be added (7 maximum). The first ${room} were kept.`);
    }
    for (const file of files.slice(0, room)) {
        if (!file.type.startsWith('image/')) {
            alert(`"${file.name}" is not an image file.`);
            continue;
        }
        if (file.size > 2 * 1024 * 1024) {
            alert(`"${file.name}" is larger than 2 MB.`);
            continue;
        }
        try {
            const photo = await compressImage(file);
            if (modalPhotos.length < MAX_PHOTOS) modalPhotos.push(photo);
            renderPhotoList();
        } catch (error) {
            alert(error.message);
        }
    }
}

function syncVariantFields() {
    const category = document.getElementById('p-category').value;
    document.getElementById('color-field').hidden = !categoryNeedsColor(category);
    document.getElementById('size-field').hidden = !categoryNeedsSize(category);
}

function openProductModal(productId = null) {
    const form = document.getElementById('product-form');
    const product = productId === null
        ? null
        : getProducts().find(item => sameId(item.id, productId));
    if (productId !== null && !product) {
        alert('Product could not be found.');
        return;
    }
    form.reset();
    document.getElementById('p-id').value = product ? String(product.id) : '';
    document.getElementById('p-name').value = product?.name || '';
    document.getElementById('p-price').value = product?.price ?? '';
    document.getElementById('p-bulk-price').value = product?.bulkPrice ?? '';
    document.getElementById('p-bulk-qty').value = product?.bulkMinQty ?? '';
    const categorySelect = document.getElementById('p-category');
    const wantedCategory = product?.category || 'Electronics';
    categorySelect.value = [...categorySelect.options].some(option => option.value === wantedCategory)
        ? wantedCategory
        : (categorySelect.options[0]?.value ?? '');
    document.getElementById('p-desc').value = product?.description || '';
    document.getElementById('p-colors').value = (product?.options?.Color || []).join(', ');
    document.getElementById('p-sizes').value = (product?.options?.Size || []).join(', ');
    syncVariantFields();
    document.getElementById('product-modal-title').textContent = product ? 'Edit Product' : 'Add New Product';
    document.getElementById('product-save-button').textContent = product ? 'Save Changes' : 'Save Product';
    modalPhotos = product ? getProductPhotos(product) : [];
    renderPhotoList();
    document.getElementById('product-modal').hidden = false;
}

function closeProductModal() {
    document.getElementById('product-modal').hidden = true;
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
    if (!modalPhotos.length) {
        alert('Add at least one product photo before saving.');
        return;
    }
    const products = getProducts();
    const productId = document.getElementById('p-id').value;
    const existingIndex = products.findIndex(product => String(product.id) === productId);
    const category = document.getElementById('p-category').value;
    const bulkPriceText = document.getElementById('p-bulk-price').value.trim();
    const bulkQtyText = document.getElementById('p-bulk-qty').value.trim();
    const normalPrice = Number(document.getElementById('p-price').value);
    let bulk = null;
    if (bulkPriceText || bulkQtyText) {
        const bulkPrice = Number(bulkPriceText);
        const bulkMinQty = Number(bulkQtyText);
        if (!bulkPriceText || !bulkQtyText) {
            alert('Enter both the bulk price and the quantity it applies from, or leave both empty.');
            return;
        }
        if (!(bulkPrice >= 0) || !(bulkPrice < normalPrice)) {
            alert('The bulk price must be lower than the normal price.');
            return;
        }
        if (!Number.isInteger(bulkMinQty) || bulkMinQty < 2) {
            alert('The bulk quantity must be a whole number of 2 or more.');
            return;
        }
        bulk = { bulkPrice, bulkMinQty };
    }
    savingProduct = true;
    try {
        // Older photos saved at a larger size are shrunk so all photos fit in one document.
        const photos = await Promise.all(modalPhotos.map(src => src.length > PHOTO_BUDGET ? compressImage(src) : src));
        const product = {
            id: existingIndex >= 0 ? products[existingIndex].id : Date.now(),
            name: document.getElementById('p-name').value.trim(),
            price: Number(document.getElementById('p-price').value),
            image: photos[0],
            gallery: photos.slice(1),
            category,
            description: document.getElementById('p-desc').value.trim()
        };
        if (bulk) Object.assign(product, bulk);
        const built = buildProductOptions(category, document.getElementById('p-colors').value, document.getElementById('p-sizes').value);
        if (built.error) {
            alert(built.error);
            return;
        }
        if (Object.keys(built.options).length) product.options = built.options;
        const saved = await apiRequest(`/api/admin/products/${encodeURIComponent(String(product.id))}`, {
            method: 'PUT',
            body: product
        });
        const nextProduct = saved?.product || product;
        if (existingIndex >= 0) {
            store.products = store.products.map((item, idx) => idx === existingIndex ? nextProduct : item);
        } else {
            store.products = [...store.products, nextProduct];
        }
    } catch (error) {
        console.error(error);
        alert(error.code
            ? 'Product could not be saved. Check your connection and that you are signed in as an admin.'
            : error.message);
        return;
    } finally {
        savingProduct = false;
    }
    closeProductModal();
    renderAdmin('inventory');
}

async function deleteProduct(id) {
    if (!confirm('Delete this product?')) return;
    try {
        await apiRequest(`/api/admin/products/${encodeURIComponent(String(id))}`, { method: 'DELETE' });
        store.products = store.products.filter(item => !sameId(item.id, id));
    } catch (error) {
        console.error(error);
        alert('Product could not be deleted. Check your connection and admin access.');
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
    }
});
// Re-draw the current page when shared data changes on another device,
// without interrupting typing, an open product form, or the current tab.
function refreshView() {
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const { page } = routeInfo();
    if (page === 'home') renderHome();
    else if (page === 'search') renderSearch();
    else if (page === 'admin') {
        if (document.getElementById('product-modal')?.hidden === false) return;
        renderAdmin(lastAdminTab);
    } else if (['profile', 'dashboard'].includes(page) && lastDashboardTab === 'orders') renderDashboard('orders');
}

window.addEventListener('hashchange', () => {
    if (appReady) renderPage();
});

setInterval(async () => {
    if (!appReady || document.visibilityState !== 'visible') return;
    await loadStoreData({ silent: true });
    if (store.user) await loadUserCollections(store.user);
    refreshView();
}, 15000);

function trackSiteVisit() {
    if (routeInfo().page === 'admin') return;
    try {
        if (sessionStorage.getItem('rk_visit_logged')) return;
        let visitorId = localStorage.getItem('rk_visitor_id');
        if (!visitorId) {
            visitorId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
                ? crypto.randomUUID()
                : `v-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem('rk_visitor_id', visitorId);
        }
        sessionStorage.setItem('rk_visit_logged', '1');
        fetch('/api/analytics/visit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId })
        }).catch(() => {});
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
