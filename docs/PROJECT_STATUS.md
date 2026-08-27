# WCAT Sales Support App — Project Status

**Last updated:** 2026-08-24  
**Repository:** `MaDeaw111/Sales-support-app`  
**Production:** Cloudflare Worker — `wcat-sales-support`  
**Database:** Cloudflare D1 — `wcat-sales-db`

---

## 1. Current Architecture

The project is being migrated from the original Google Apps Script / mock frontend flow to Cloudflare.

```text
Frontend
  ↓
Cloudflare Worker API
  ↓
Cloudflare D1
```

For modules already migrated to D1, Google Apps Script / mock state must not be used as the authoritative data source.

---

## 2. Completed Work

### Phase 3–4 — Authentication Migration

**Status:** COMPLETE / DEPLOYED

Completed:
- D1 `users` and `sessions`
- Login API
- Session handling
- PBKDF2 password hashing
- Change-password flow
- Initial Admin account
- D1 binding configured as `DB`

Compatibility fix:
- PBKDF2 iterations reduced from `210000` to `100000` for Cloudflare compatibility.

Production login is working.

---

### Phase 5A — Customer CRM D1 Migration

**Status:** COMPLETE / MERGED / DEPLOYED

Implemented:
- Customer tables in D1
- Customer contacts
- `GET /api/customers`
- Customer detail/create/update
- Customer ownership validation
- Role-based Customer access
- Frontend Customer loading from API
- Add/Edit Customer connected to D1
- Dashboard Customer metrics use D1-backed state

Migration applied to production:

```text
0002_customers.sql
```

Verified production D1 tables:

```text
customers
customer_contacts
```

PR #1 merge commit:

```text
c754c353fdce750a21f5ec82ef6b675ba6a21e89
```

---

### Phase 5A.1 — Customer Owner Directory

**Status:** COMPLETE / MERGED / DEPLOYED

Problem:
Customer Owner dropdown still used frontend mock `state.users`, while backend validated owners against real D1 users.

Error observed:

```text
Owner user does not exist.
```

Implemented:
- `GET /api/customer-owners`
- Owner list sourced from D1
- Frontend uses `state.customerOwners`
- Add/Edit Customer Owner dropdown no longer uses mock users
- Unassigned retained
- Legacy/unavailable owner IDs handled safely

PR #2 merge commit:

```text
ba1d3f76ad9d684ddebbee8c864cf7ef91dc9842
```

---

### Detailed Customer Edit — D1 Fix

**Status:** COMPLETE / MERGED / DEPLOYED

Implemented:
- Detailed Edit uses D1-backed `state.customerOwners`
- Legacy/unavailable owner displayed safely
- Save blocked when unavailable legacy owner remains selected
- User must choose valid Owner or Unassigned
- Status mapping:

```text
ACTIVE   → ACTIVE_CUSTOMER
INACTIVE → INACTIVE_CUSTOMER
```

- Save uses `saveCustomerToApi()`
- API-returned Customer becomes authoritative state
- Customer code/source preserved
- Contacts mapped to D1 DTO
- Unsupported fields disabled and marked `Prototype only`

Currently unsupported / not persisted:
- Address / Tax ID
- Payment Term
- Credit Limit
- Customer Tier
- POD
- Packaging

PR #3 merge commit:

```text
8a38d9ccb34cffa32258f70c0d6c29d32ae4c9ca
```

---

### Phase 5B — External Sales D1 Integration

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

Implemented backend:

```text
GET  /api/external-sales
GET  /api/external-sales/:id
POST /api/external-sales
PUT  /api/external-sales/:id
```

External Sales users use existing D1 `users` table.

Role:

```text
EXTERNAL_SALES
```

Supported statuses:

```text
ACTIVE
INACTIVE
SUSPENDED
```

Create External Sales:
- Generates unique User ID
- Generates secure temporary password
- PBKDF2 hash + salt
- Stores only hashed credentials
- `must_change_password = 1`
- Returns temporary password once
- Supports initial Customer assignment

Customer ownership source of truth:

```text
customers.owner_user_id
```

Permissions:

```text
Read:        ADMIN, MANAGER, SALES_SUPPORT
Create/Edit: ADMIN, MANAGER
```

Frontend:
- Added `state.externalSales`
- Added `loadExternalSalesFromApi()`
- Removed mock `state.users` fallback from External Sales flow
- Removed Apps Script-only save behavior
- After create/update, reloads:
  - Customers
  - External Sales
  - Customer Owner Directory

Default Commission Rate:
- Still `Prototype only`
- Disabled
- Not stored in D1 yet

Latest verification before merge:

```text
73 tests passed
0 failed
```

No D1 migration required.

PR #4 head before merge:

```text
42c5708fd1374543a815105630c1481475e845c7
```

PR #4 merge commit:

```text
efceacd607e21b94d71425bbd247278464481270
```

Cloudflare production deployment observed:

```text
Version ID: 91735047
Merge pull request #4 — migrate External Sales management to D1
```

Production smoke test results:
- Sira TTPagro created successfully through External Sales production UI
- Sira persisted after refresh
- MEELUNIE B.V. remained assigned after refresh
- Customer Owner dropdown showed Sira
- Detailed Customer Edit saved successfully with Sira as Owner
- No "Owner user does not exist" error
- No Apps Script-only External Sales save error
- Sira authentication was tested successfully
- Temporary-password reset required a manual D1 recovery during the smoke test
- Final Sira user_id: USR-0002
- must_change_password flow remains enabled for temporary credentials

Important note:
The manual temporary-password recovery exposed a production administration gap: there is currently no Admin UI/API flow to reset another user's password safely. This is the reason Phase 5C is next.

---

### Phase 5C — User Administration & Password Reset D1

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

- Merged via PR #5
- Merge commit: `07478f989676777119320190f978f833b62136ca`
- 90 tests passed before merge
- Customer scope compatibility fix completed
- No migration required
- Deployed to production (Worker: `wcat-sales-support`, Version ID: `fba4f0a7-7dc8-488e-aa30-ef5e40283ed8`, D1 binding `DB -> wcat-sales-db`, no migration performed, no manual D1 mutation performed)
- Production smoke test verified successfully:
  - Users / Roles page loaded successfully from D1
  - Add User succeeded
  - Customer Scope mapping displayed correctly
  - Temporary password was generated and displayed once
  - Newly created user could log in
  - `must_change_password` flow forced password change
  - Edit User persisted successfully
  - Admin Reset Password succeeded
  - Old password no longer worked after reset
  - New temporary password worked
  - Forced password change triggered again after reset
  - Session invalidation behavior verified (all active sessions signed out on password reset)
  - No manual SQL password recovery was required

Implemented:
- D1-backed User list (`GET /api/users`) and User detail (`GET /api/users/:id`).
- Internal User Creation (`POST /api/users`) with secure temporary password generation.
- User Profile Editing (`PUT /api/users/:id`).
- Admin Password Reset endpoint (`POST /api/users/:id/reset-password`) with session invalidation.
- UI migrated away from mockup `state.users` to D1-backed `state.adminUsers`.
- Self-lockout protection checks implemented in the repository/routes.
- Security regression tests implemented.

### Phase 5D — Product / Spec D1 Migration

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

Implemented backend:
- D1 schema migration (`migrations/0003_product_specs.sql`) defining product category, product form, products, application maps, parameters, standard specs, standard items, customer specs, and customer overrides.
- Implemented robust repository CRUD methods in `src/products/repository.js` for categories, forms, products, spec parameters, standard specs, customer specs, and effective customer specification merging.
- Spec validation helper (`src/products/validation.js`) enforcing type constraints, operator rules, and RANGE bounds.
- Route controllers (`src/products/routes.js`) registering endpoints under `/api/products`, `/api/product-categories`, `/api/product-forms`, `/api/spec-parameters`, `/api/standard-specs`, and `/api/customer-specs` with RBAC authorization check.
- Wired routes in API Gateway router (`src/index.js`).

Implemented frontend:
- Initialized empty arrays for products and specification master data in `public/index.html`.
- Implemented backend loaders for products, categories, forms, and spec parameters.
- Built Product Master UI (creation, editing, details display).
- Built Standard Spec UI (draft revisioning, active spec validation, items editor, copy-on-draft revisioning, activate/archive transitions).
- Built Customer Spec UI (integrated within Customer Detail view, links to active base standard spec, override items editor, effective merged spec list, activate/archive transitions).

All 115 unit, integration, route, and regression tests pass cleanly.

Deployed to production:
- PR #6
- Merge Commit: `4fab5d4b5516f2f3c428bd76478052545584ad15`
- Migration: `migrations/0003_product_specs.sql`
- Production D1: `wcat-sales-db`
- Worker: `wcat-sales-support`
- Worker Version ID: `d493722d-21bf-4a4d-a4ac-4ba633fe52a0`

Production smoke test results verified:
- Product Master API/UI verified (Category, Form, and Product creation and deactivation)
- Product create/edit validation verified
- Standard Spec DRAFT/ACTIVE/revision copy-on-draft verified
- One ACTIVE Standard Spec rule enforced
- Customer Spec override editor and merged effective spec verified
- Existing legacy modules (Auth, Customer, External Sales, User Admin) remain healthy and active.

### Phase 5E — Commercial & Shipment Control

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

Implemented backend:
- D1 schema migration (`migrations/0004_commercial_shipment_control.sql`) defining pos, shipments, freight quotes, expense categories, price notes, shipment document links, and shipment expenses.
- Implemented price notes and shipments repositories.
- Protected shipment routes with RBAC (ADMIN, MANAGER, SALES_SUPPORT, EXPORT).
- Enforced sales/customer CRM ownership on price note creation.
- Implemented date filter queries on price notes.

Implemented frontend:
- Tabbed panels inside Shipment details (Overview, Costs, Documents).
- Salesperson selection customer dropdown dynamic filtering.
- Date from and Date to inputs on Price Notes.

All 151 unit, integration, route, and regression tests pass cleanly.

PR #7 merge commit:
```text
98b51678a566882bcce62668987886958cbc7078
```

Migration:
```text
0004_commercial_shipment_control.sql
```

D1 Database:
```text
wcat-sales-db
```

Worker Version ID:
```text
6b9bd0ae-b952-47e8-8c62-3ecf7f9c1417
```

Production Verification:
```text
SUCCESS (All Phase 5E smoke tests passed cleanly, 151 regression tests passed)
```

---

# 3. CURRENT CHECKPOINT

## STOPPED HERE — 2026-08-27

Phase 5E is fully deployed and production-verified.
Next Action:
- Prepare Phase 5F PO/Shipping spec and plans.

---

# 4. NEXT STEP — Phase 5F — PO/Shipping Integration

Next Action:
- Prepare Phase 5F PO/Shipping spec and plans.

---

# 5. Smoke Test Checklist

- [x] Sira created through production UI (Phase 5B)
- [x] Temporary password captured (Phase 5B)
- [x] Sira remains after refresh (Phase 5B)
- [x] MEELUNIE remains assigned after refresh (Phase 5B)
- [x] Customer Owner dropdown shows Sira (Phase 5B)
- [x] Detailed Customer Edit saves with Sira (Phase 5B)
- [x] Refresh keeps Owner assignment (Phase 5B)
- [x] No Owner validation error (Phase 5B)
- [x] No Apps Script save error (Phase 5B)
- [x] Users / Roles page loads from D1 (Phase 5C)
- [x] Add User succeeds with temporary password generated (Phase 5C)
- [x] Customer Scope preview displays correctly (Phase 5C)
- [x] New user can login and change password (Phase 5C)
- [x] Edit User updates details and persists (Phase 5C)
- [x] Reset Password invalidates active sessions (Phase 5C)
- [x] Reset password generates new temporary password and forces password change on login (Phase 5C)
- [x] Products load successfully from production D1 (Phase 5D)
- [x] Add/Edit Product profiles (Phase 5D)
- [x] Create draft standard spec & edit items (Phase 5D)
- [x] Activate standard spec & verify copy-on-draft revisioning (Phase 5D)
- [x] Add customer spec draft referencing active standard spec (Phase 5D)
- [x] Modify customer overrides & verify effective specification resolution (Phase 5D)

---

# 6. Important Rules Going Forward

For migrated modules:

```text
Auth
Customer CRM
Customer Owner Directory
Detailed Customer Edit
External Sales
Users / Roles Management
Product & Spec Master Data
```

Production truth must come from:

```text
Worker API + D1
```

Do not hide persistence bugs with manual D1 seed SQL.

Fields marked:

```text
Prototype only
```

must not appear to save unless persistence is actually implemented.

---

# 7. Recommended Next Development Order

After Phase 5D production smoke test passes:

```text
1. Pricing D1 Integration
2. PO Management
3. Shipping / DI
4. Operations Calendar
5. Logistics Partners
6. Payment Status
7. Commission
```

Continue using:

```text
bounded scope
→ feature branch
→ TDD
→ full tests
→ code review
→ PR
→ Cloudflare preview
→ merge
→ production deploy
→ smoke test
```

PR #4 merge commit:

```text
efceacd607e21b94d71425bbd247278464481270
```

Cloudflare production deployment observed:

```text
Version ID: 91735047
Merge pull request #4 — migrate External Sales management to D1
```

Production smoke test results:
- Sira TTPagro created successfully through External Sales production UI
- Sira persisted after refresh
- MEELUNIE B.V. remained assigned after refresh
- Customer Owner dropdown showed Sira
- Detailed Customer Edit saved successfully with Sira as Owner
- No "Owner user does not exist" error
- No Apps Script-only External Sales save error
- Sira authentication was tested successfully
- Temporary-password reset required a manual D1 recovery during the smoke test
- Final Sira user_id: USR-0002
- must_change_password flow remains enabled for temporary credentials

Important note:
The manual temporary-password recovery exposed a production administration gap: there is currently no Admin UI/API flow to reset another user's password safely. This is the reason Phase 5C is next.

---

### Phase 5C — User Administration & Password Reset D1

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

- Merged via PR #5
- Merge commit: `07478f989676777119320190f978f833b62136ca`
- 90 tests passed before merge
- Customer scope compatibility fix completed
- No migration required
- Deployed to production (Worker: `wcat-sales-support`, Version ID: `fba4f0a7-7dc8-488e-aa30-ef5e40283ed8`, D1 binding `DB -> wcat-sales-db`, no migration performed, no manual D1 mutation performed)
- Production smoke test verified successfully:
  - Users / Roles page loaded successfully from D1
  - Add User succeeded
  - Customer Scope mapping displayed correctly
  - Temporary password was generated and displayed once
  - Newly created user could log in
  - `must_change_password` flow forced password change
  - Edit User persisted successfully
  - Admin Reset Password succeeded
  - Old password no longer worked after reset
  - New temporary password worked
  - Forced password change triggered again after reset
  - Session invalidation behavior verified (all active sessions signed out on password reset)
  - No manual SQL password recovery was required

Implemented:
- D1-backed User list (`GET /api/users`) and User detail (`GET /api/users/:id`).
- Internal User Creation (`POST /api/users`) with secure temporary password generation.
- User Profile Editing (`PUT /api/users/:id`).
- Admin Password Reset endpoint (`POST /api/users/:id/reset-password`) with session invalidation.
- UI migrated away from mockup `state.users` to D1-backed `state.adminUsers`.
- Self-lockout protection checks implemented in the repository/routes.
- Security regression tests implemented.

### Phase 5D — Product / Spec D1 Migration

**Status:** COMPLETE / MERGED PENDING (Feature branch: `feature/product-spec-d1`)

Implemented backend:
- D1 schema migration (`migrations/0003_product_specs.sql`) defining product category, product form, products, application maps, parameters, standard specs, standard items, customer specs, and customer overrides.
- Implemented robust repository CRUD methods in `src/products/repository.js` for categories, forms, products, spec parameters, standard specs, customer specs, and effective customer specification merging.
- Spec validation helper (`src/products/validation.js`) enforcing type constraints, operator rules, and RANGE bounds.
- Route controllers (`src/products/routes.js`) registering endpoints under `/api/products`, `/api/product-categories`, `/api/product-forms`, `/api/spec-parameters`, `/api/standard-specs`, and `/api/customer-specs` with RBAC authorization check.
- Wired routes in API Gateway router (`src/index.js`).

Implemented frontend:
- Initialized empty arrays for products and specification master data in `public/index.html`.
- Implemented backend loaders for products, categories, forms, and spec parameters.
- Built Product Master UI (creation, editing, details display).
- Built Standard Spec UI (draft revisioning, active spec validation, items editor, copy-on-draft revisioning, activate/archive transitions).
- Built Customer Spec UI (integrated within Customer Detail view, links to active base standard spec, override items editor, effective merged spec list, activate/archive transitions).

All 111 unit, integration, route, and regression tests pass cleanly.

---

# 3. CURRENT CHECKPOINT

## STOPPED HERE — 2026-08-26

Phase 5D implementation is fully complete on the feature branch.
Next Action:
- Create PR to merge `feature/product-spec-d1` to `main`.
- Deploy D1 migration to production database `wcat-sales-db`.
- Deploy Worker code to production `wcat-sales-support`.
- Perform production smoke test verification.

---

# 4. NEXT STEP — Phase 5E — Pricing

Next Action:
- Prepare Phase 5E pricing spec and implementation plans.

---

# 5. Smoke Test Checklist

- [x] Sira created through production UI (Phase 5B)
- [x] Temporary password captured (Phase 5B)
- [x] Sira remains after refresh (Phase 5B)
- [x] MEELUNIE remains assigned after refresh (Phase 5B)
- [x] Customer Owner dropdown shows Sira (Phase 5B)
- [x] Detailed Customer Edit saves with Sira (Phase 5B)
- [x] Refresh keeps Owner assignment (Phase 5B)
- [x] No Owner validation error (Phase 5B)
- [x] No Apps Script save error (Phase 5B)
- [x] Users / Roles page loads from D1 (Phase 5C)
- [x] Add User succeeds with temporary password generated (Phase 5C)
- [x] Customer Scope preview displays correctly (Phase 5C)
- [x] New user can login and change password (Phase 5C)
- [x] Edit User updates details and persists (Phase 5C)
- [x] Reset Password invalidates active sessions (Phase 5C)
- [x] Reset password generates new temporary password and forces password change on login (Phase 5C)
- [ ] Products load successfully from production D1 (Phase 5D)
- [ ] Add/Edit Product profiles (Phase 5D)
- [ ] Create draft standard spec & edit items (Phase 5D)
- [ ] Activate standard spec & verify copy-on-draft revisioning (Phase 5D)
- [ ] Add customer spec draft referencing active standard spec (Phase 5D)
- [ ] Modify customer overrides & verify effective specification resolution (Phase 5D)

---

# 6. Important Rules Going Forward

For migrated modules:

```text
Auth
Customer CRM
Customer Owner Directory
Detailed Customer Edit
External Sales
Users / Roles Management
Product & Spec Master Data
```

Production truth must come from:

```text
Worker API + D1
```

Do not hide persistence bugs with manual D1 seed SQL.

Fields marked:

```text
Prototype only
```

must not appear to save unless persistence is actually implemented.

---

# 7. Recommended Next Development Order

After Phase 5D production smoke test passes:

```text
1. Pricing D1 Integration
2. PO Management
3. Shipping / DI
4. Operations Calendar
5. Logistics Partners
6. Payment Status
7. Commission
```

Continue using:

```text
bounded scope
→ feature branch
→ TDD
→ full tests
→ code review
→ PR
→ Cloudflare preview
→ merge
→ production deploy
→ smoke test
→ update PROJECT_STATUS.md
```

---

# 8. Quick Resume Note

> Phase 5D is fully complete on the feature branch `feature/product-spec-d1` and ready for PR.
> Next Action: PR review, merge, deploy migrations to production, and smoke test.
