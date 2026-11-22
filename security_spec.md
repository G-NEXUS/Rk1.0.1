# Security Specification & Payload TDD (`security_spec.md`)

## 1. Data Invariants
1. **Default-Deny Baseline:** Every unmapped path under `/databases/{database}/documents` rejects all reads and writes.
2. **Admin Verification:** Admin mutations (`products`, `meta`, `didYouKnow`, `messages` read/delete, `orders` status updates, `pageViews` read/delete, `users` migration) require `request.auth != null`, `email_verified == true` for email-based bootstrap (`choolwechingobe2@gmail.com`) or membership in `/admins/{uid}`.
3. **PII & Credential Isolation:** User profiles (`/users/{userId}`) and migrated password hashes (`/users/{userId}/private/{credId}`) are readable only by the owning user or an admin; non-owners cannot `list` users or read any other user's orders or contact messages.
4. **Role Escalation Prevention:** Users creating their own `/users/{userId}` document must set `isAdmin == false` and `uid == request.auth.uid`, and cannot modify `isAdmin`, `uid`, `email`, or `createdAt` on update.
5. **Bounded Page View Counters:** Public visitors can only initialize a `pageViews/{viewKey}` document with `views == 1` or atomically increment an existing document by exactly `1` (`incoming().views == existing().views + 1`) with `updatedAt == request.time`. Only admins can read or delete traffic analytics.
6. **Strict Keys & ID Hardening:** Every single-document operation validates `isValidId(id)` (`^[a-zA-Z0-9_-]{1,128}$`) and enforces exact allowed keys and string/array length limits.

## 2. The "Dirty Dozen" Payloads
1. **Unverified Admin Email Spoof:** Unverified token claiming admin email attempts to create a product -> `PERMISSION_DENIED`.
2. **Self-Privilege Escalation:** Signed-in customer creates `/users/{uid}` with `isAdmin: true` -> `PERMISSION_DENIED`.
3. **Ghost Field Shadow Write:** Authenticated customer updates `/users/{uid}` adding `role: "admin"` -> `PERMISSION_DENIED`.
4. **Cross-User PII Read:** Authenticated customer tries `getDoc` on another user's `/users/{otherUid}` or `/users/{otherUid}/private/credentials` -> `PERMISSION_DENIED`.
5. **Blanket User Listing:** Non-admin attempts `getDocs(collection(db, 'users'))` -> `PERMISSION_DENIED`.
6. **Order Identity Spoofing:** Signed-in user creates `/orders/{id}` with `uid: "victim-uid"` -> `PERMISSION_DENIED`.
7. **Order Status Shortcutting:** Customer creates `/orders/{id}` with `status: "Delivered"` instead of `"Awaiting WhatsApp confirmation"` -> `PERMISSION_DENIED`.
8. **Page View Inflation:** Visitor creates `/pageViews/product_1` with `views: 50000` -> `PERMISSION_DENIED`.
9. **Page View Tampering:** Visitor updates `/pageViews/product_1` setting `views: 999` or changing `targetId` -> `PERMISSION_DENIED`.
10. **Unauthorized Analytics Scraping:** Non-admin attempts `getDocs(collection(db, 'pageViews'))` -> `PERMISSION_DENIED`.
11. **Oversized Document ID Poisoning:** Client attempts write with a 500-char or slash-containing document ID -> `PERMISSION_DENIED`.
12. **Client-Spoofed Timestamp:** Client creates a product, order, or page view with a backdated `updatedAt` != `request.time` -> `PERMISSION_DENIED`.
