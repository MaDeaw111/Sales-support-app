# WCAT Sales Support App — Project Status

**Last updated:** 2026-11-19  
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

### Phase 5F — PO Management

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

Implemented:
- D1 schema migrations (`0005_po_management.sql` and `0006_customer_ownership_type.sql`) defining PO headers, revisions, lines, documents, audit events, field diffs, and customer ownership types.
- Sequential PO number/ID generation and draft PO creation.
- Custom customer CRM ownership toggling rules: ASSIGNED_SALES requires active owner; HOUSE_ACCOUNT requires NULL owner.
- Revision cloning, line snapshotting, and pricing suggested overrides logic.
- Document link management with validation.
- Atomic revision activation checking and blocking rules: requires valid standard/customer spec (blocks draft or missing specs).
- Spec outdated resolution: Choice A (Keep Old) with Manager confirmation (audit logged), Choice B (Update Latest) with endpoint update.
- Review endpoint RBAC lockdown (ADMIN/MANAGER only).
- Omit sensitive commercial fields (prices, commissions, documents) dynamically based on role (EXTERNAL_SALES, EXPORT, PRODUCTION_WAREHOUSE).
- Full audit event and field diff logging on activation, cancellation, and note updates.

PR #8 merge commit:
```text
419e016012ec2331cce5d1c55e0aed8a58f4539b
```

Production migrations already applied:
```text
0005_po_management.sql — 2026-08-28 02:21:03 UTC
0006_customer_ownership_type.sql — 2026-08-28 02:21:04 UTC
```

D1 Database:
```text
wcat-sales-db
```

Production Worker hotfix deployment:
```text
main commit: edbf7f3d6aeb9d7f692c9498112aed2181556b65
active version: a74af359-a570-425b-beec-1df5a98b96a3
Workers URL: https://wcat-sales-support.deono111.workers.dev
```

Production Verification:
```text
SUCCESS (170 regression tests passed; production frontend inline script syntax and console verified clean; safe unauthenticated API smoke passed. Authenticated role smoke tests were not exercised.)
```

---

### Phase 6 — Shipping / DI Integration

**Status:** COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED

Implemented:
- D1 schema migration (`migrations/0007_shipping_di_integration.sql`) adding Delivery Instructions (`delivery_instructions`, `delivery_instruction_lines`), Shipments v2 (`shipments_v2`, `shipment_containers`, `shipment_invoices`, `shipment_payments`, `shipment_audit_events`), Service Partners master (`service_partners`), and Customer Credits (`customer_credits`).
- Delivery Instruction lifecycle (DRAFT → CONFIRMED → IN_PROGRESS → COMPLETED / CANCELLED) bound to exact Phase 5F PO Revision Lines, with atomic PO balance/availability reservation and persisted container plan validation.
- Shipment v2 workflow: Booking, Surveyor/Forwarder selection (with returning-Customer suggestions), Planned vs Actual Loading Dates (`ON_PLAN` / `OUT_OF_PLAN`), Actual Containers/Seals/Net Weight, Preliminary & Final Invoices, All Ship Docs Drive folder & Email/DHL delivery tracking, Customer Credits, Payments, and automatic Shipment completion.
- Strict server-side & UI RBAC projections for restricted roles (`EXTERNAL_SALES`, `PRODUCTION_WAREHOUSE`) and explicit Shipment-ID vs DI-ID read boundaries.

Production release:
```text
Original Phase 6 merge: 67d8be70d7a1ad61861d02a21997215de31c5597
Release hotfix:         e8ffb52dc6c36f6e4bca07f6116f830cdc9b27c4 (remove legacy GET_MASTER_DATA bootstrap 501)
Verification docs:      a95f6bfbfd6dad996dcd5261d999427b0317e7e5
Migration applied:      0007_shipping_di_integration.sql
Worker version:         859fe84f-9a7f-4232-a5e9-2ae92141976e
Cloudflare build:       a7483865-94e5-4b4f-8f6f-e5cdceec8cbe
```

Production Verification:
```text
SUCCESS (311 tests passed at release; human-authenticated browser smoke passed; legacy GET_MASTER_DATA 501 absent; Phase 5E/5F data preserved. Limitation: comprehensive authenticated multi-role RBAC production smoke was not exercised; Tailwind CDN production warning remains known non-blocking technical debt.)
```

---

### Post-Phase 6 Maintenance (`a95f6bf` → `e2e4d6d`)

**Status:** COMPLETE / PUSHED TO `main`

Commits on `main` after `a95f6bf`:
- `8d9fc02e2b012cb05560ff43713251c5f685aee5` — `fix: restore D1 PO detail renderer`
- `f8a74edbabb2e34481f2e8d846ab8c9209d52eb2` — `ui: remove legacy sheets prototype labels`
- `8c167513c4f20b0ddafba0b76a91c7171b299b7c` — `ui: remove remaining prototype title`
- `e2e4d6d2cec8baa8a442e21868e12898fa92ea9d` — `feat: expose spec parameter master UI`

Follow-up housekeeping (`ff5e41b`):
- Removed remaining dead `/api/gateway` (501) callers (`UPDATE_PO`, `SEED_ALL_MASTER_DATA`) from `public/index.html` and added a regression guard in `test/frontend-adapter.test.js`.
- Refreshed `docs/PROJECT_STATUS.md` checkpoint and backlog sections.

---

### Phase 7 — Operations Calendar

**Status:** COMPLETE / MERGED / RELEASED

Implemented backend:
- Dedicated read-only calendar module (`src/calendar/validation.js`, `src/calendar/repository.js`, `src/calendar/routes.js`) dispatched at `GET /api/operations-calendar` in `src/index.js`.
- Zero new D1 migrations required (`0001`–`0007` untouched); sources live milestones directly from Phase 5F (`po_headers`, `po_revisions`, `po_revision_lines`) and Phase 6 (`delivery_instructions`, `delivery_instruction_lines`, `phase6_shipments`, `shipment_containers`, `shipment_container_lines`, `shipment_audit_events`).
- 6 canonical event types: `LOADING_PLANNED` (deduplicated when `actual_loading_date` matches the same day), `LOADING_ACTUAL`, `ETD`, `ETA`, `PO_DELIVERY_START`, and `PO_DELIVERY_END` (`PO_VALID_UNTIL` intentionally excluded; all `CANCELLED`/non-`ACTIVE` records excluded).
- Strict server-side RBAC projections and anti-inference filter hardening:
  - `PRODUCTION_WAREHOUSE`: loading events only (`LOADING_PLANNED`, `LOADING_ACTUAL`), opaque SHA-256 `event_id`, exact Phase 6 Warehouse field allowlist, ignores `customerId`/`salesOwnerId`/`status` filters.
  - `EXTERNAL_SALES`: owned-Customer events only, opaque SHA-256 `event_id`, exact Phase 5F/6 allowlists, `dailyLoadingSummary: []`, ignores `customerId`/`salesOwnerId`/`productId` filters.
  - `ADMIN`, `MANAGER`, `SALES_SUPPORT`, `EXPORT`: full operational calendar fields + real `loading_date_history` from `shipment_audit_events`; `can_reschedule` granted only to `ADMIN`, `MANAGER`, and `EXPORT` on `BOOKED` `LOADING_PLANNED` events.
- Planned Loading Date rescheduling reuses Phase 6 `PUT /api/shipments-v2/:id/schedule` untouched.

Implemented frontend:
- Replaced mock prototype calendar arrays in `public/index.html` with `loadOperationsCalendarFromApi()` backed by `/api/operations-calendar`.
- Preserved Month, Week, and Agenda views with Today/Prev/Next/Refresh controls, truthful daily loading summary badges (`shipment_count`, `planned_qty_mt`, `actual_container_count`), and role-aware filters/detail modals.

Release details:
```text
PR #10 merge commit: 3309ba4e79ccd91d556e54bc0a15c85eb53d76ad
Feature commit:      29190fa (branch: feature/phase7-operations-calendar)
Migrations required: None (0001–0007 unchanged)
Automated tests:     334 passed, 0 failed
Design spec:         docs/superpowers/specs/2026-11-19-phase7-operations-calendar-design.md
Implementation plan: docs/superpowers/plans/2026-11-19-phase7-operations-calendar-implementation-plan.md
```

---

# 3. CURRENT CHECKPOINT

## STOPPED HERE — 2026-11-19

Phase 7 (Operations Calendar) is merged via PR #10 (`3309ba4`) and released to `main`.
Next Action:
- Select and scope Phase 8 from the remaining backlog (Logistics Partners, Payment Status, or Commission Settlement).
- Draft bounded design spec and implementation plan before coding.

---

# 4. NEXT STEP — Phase 8 (Next Backlog Module)

Next Action:
- Confirm priority order between **Logistics Partners**, **Payment Status**, and **Commission Settlement**, then draft the bounded Phase 8 design spec and implementation plan.

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
- [x] Customer CRM reads ownership_type (Phase 5F)
- [x] Existing customers load successfully (Phase 5F)
- [x] PO API route is reachable (Phase 5F)
- [x] Role-based PO access behaves correctly (Phase 5F)
- [x] Restricted commercial fields do not leak (Phase 5F)
- [x] PO frontend loads without JS errors (Phase 5F)
- [x] Phase 6 Shipping / DI Integration — COMPLETE / MERGED / DEPLOYED / PRODUCTION VERIFIED
  - Original Phase 6 merge: `67d8be70d7a1ad61861d02a21997215de31c5597`
  - Release hotfix: `e8ffb52dc6c36f6e4bca07f6116f830cdc9b27c4`
  - Migration `0007_shipping_di_integration.sql` applied and verified in production.
  - Worker version `859fe84f-9a7f-4232-a5e9-2ae92141976e`; Cloudflare build `a7483865-94e5-4b4f-8f6f-e5cdceec8cbe`.
  - Human-authenticated browser smoke passed; the legacy `GET_MASTER_DATA` bootstrap 501 is absent.
  - Final automated verification: 311 passed, 0 failed; legacy Phase 5E and Phase 5F data/schema preserved; no production test/commercial records created.
  - Limitation: comprehensive authenticated multi-role RBAC production smoke was not exercised. Tailwind CDN production warning remains known non-blocking technical debt.
- [x] Phase 7 Operations Calendar — COMPLETE / MERGED / RELEASED
  - PR #10 merge commit: `3309ba4e79ccd91d556e54bc0a15c85eb53d76ad`
  - No D1 migration required (`0001`–`0007` preserved); automated verification: 334 passed, 0 failed.

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
Commercial & Shipment Control (Price Notes / Freight Quotes)
PO Management
Shipping / DI Integration
Operations Calendar
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

After Phase 7 (Operations Calendar) release:

```text
1. Logistics Partners
2. Payment Status
3. Commission Settlement
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
