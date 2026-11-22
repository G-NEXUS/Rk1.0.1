// Security verification suite corresponding to security_spec.md "Dirty Dozen" payloads.
// Documents assertions verified against DRAFT_firestore.rules / firestore.rules.

export const dirtyDozenCases = [
  {
    id: 1,
    name: 'Unverified Admin Email Spoof',
    collection: 'products',
    operation: 'create',
    payload: { id: 'p1', name: 'Spoof', price: 10, image: 'https://res.cloudinary.com/demo/image/upload/sample.jpg', updatedAt: 'REQUEST_TIME' },
    auth: { uid: 'u1', email: 'choolwechingobe2@gmail.com', email_verified: false },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 2,
    name: 'Self-Privilege Escalation on User Create',
    collection: 'users',
    operation: 'create',
    payload: { uid: 'u2', name: 'Attacker', email: 'a@example.com', isAdmin: true, createdAt: 'REQUEST_TIME', updatedAt: 'REQUEST_TIME' },
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 3,
    name: 'Ghost Field Shadow Write on User Update',
    collection: 'users',
    operation: 'update',
    payload: { uid: 'u2', name: 'User', email: 'a@example.com', isAdmin: false, role: 'admin', createdAt: 'EXISTING', updatedAt: 'REQUEST_TIME' },
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 4,
    name: 'Cross-User Credential Read',
    collection: 'users/otherUid/private',
    operation: 'get',
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 5,
    name: 'Blanket User Collection Listing',
    collection: 'users',
    operation: 'list',
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 6,
    name: 'Order Identity Spoofing',
    collection: 'orders',
    operation: 'create',
    payload: { id: 'ORD-1', uid: 'victim', customer: 'Bob', items: [{ name: 'Item', price: 10, quantity: 1 }], total: 10, status: 'Awaiting WhatsApp confirmation', createdAt: 'REQUEST_TIME', updatedAt: 'REQUEST_TIME' },
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 7,
    name: 'Order Status Shortcutting',
    collection: 'orders',
    operation: 'create',
    payload: { id: 'ORD-2', uid: 'u2', customer: 'Bob', items: [{ name: 'Item', price: 10, quantity: 1 }], total: 10, status: 'Delivered', createdAt: 'REQUEST_TIME', updatedAt: 'REQUEST_TIME' },
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 8,
    name: 'Page View Inflation on Create',
    collection: 'pageViews',
    operation: 'create',
    payload: { viewKey: 'product_1', type: 'product', targetId: '1', label: 'Phone', views: 50000, updatedAt: 'REQUEST_TIME' },
    auth: null,
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 9,
    name: 'Page View Jump on Update',
    collection: 'pageViews',
    operation: 'update',
    payload: { viewKey: 'product_1', type: 'product', targetId: '1', label: 'Phone', views: 999, updatedAt: 'REQUEST_TIME' },
    auth: null,
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 10,
    name: 'Unauthorized Analytics Scraping',
    collection: 'pageViews',
    operation: 'list',
    auth: { uid: 'u2', email: 'a@example.com', email_verified: true },
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 11,
    name: 'Oversized Document ID Poisoning',
    collection: 'messages',
    operation: 'create',
    docId: 'x'.repeat(200),
    payload: { id: 'x'.repeat(200), name: 'Spam', email: 's@example.com', subject: 'Hi', message: 'Body', read: false, createdAt: 'REQUEST_TIME' },
    auth: null,
    expected: 'PERMISSION_DENIED'
  },
  {
    id: 12,
    name: 'Client-Spoofed Timestamp',
    collection: 'pageViews',
    operation: 'create',
    payload: { viewKey: 'category_tech', type: 'category', targetId: 'Tech', label: 'Tech', views: 1, updatedAt: '2020-01-01T00:00:00Z' },
    auth: null,
    expected: 'PERMISSION_DENIED'
  }
];
