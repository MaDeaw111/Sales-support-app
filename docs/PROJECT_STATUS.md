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

**Status:** COMPLETE / MERGED / DEPLOYMENT PENDING

- Merged via PR #5
- Merge commit: `07478f989676777119320190f978f833b62136ca`
- 90 tests passed before merge
- Customer scope compatibility fix completed
- No migration required
- Production deployment still pending confirmation

Implemented:
- D1-backed User list (`GET /api/users`) and User detail (`GET /api/users/:id`).
- Internal User Creation (`POST /api/users`) with secure temporary password generation.
- User Profile Editing (`PUT /api/users/:id`).
- Admin Password Reset endpoint (`POST /api/users/:id/reset-password`) with session invalidation.
- UI migrated away from mockup `state.users` to D1-backed `state.adminUsers`.
- Self-lockout protection checks implemented in the repository/routes.
- Security regression tests implemented.

---

# 3. CURRENT CHECKPOINT

## STOPPED HERE — 2026-08-25

Phase 5C has been merged to main.

Current State:
- PR #5 is merged.
- main merge commit is `07478f989676777119320190f978f833b62136ca`.
- Phase 5C code is merged.
- Production deployment is still pending confirmation.

---

# 4. NEXT STEP — Phase 5C Production Deployment & Smoke Test

Next Action:
- Deploy the latest main branch containing Phase 5C to the production Cloudflare Worker: `wcat-sales-support`.
- Verify production D1 database binding `DB -> wcat-sales-db`.
- Perform the Phase 5C Production Smoke Test:
  - Test Users & Role Management page access.
  - Test Add User: create internal user, verify temporary password and copy login info dialog.
  - Test Edit User: update profile properties, verify status and scope changes persist.
  - Test Reset Password: trigger Admin password reset, verify old password fails, verify new temporary password works and must change password flow is triggered.
  - Verify that password reset invalidates all existing sessions of the target user.
  - Update `PROJECT_STATUS.md` after smoke test is verified.

---

# 5. Smoke Test Checklist

- [x] Sira created through production UI
- [x] Temporary password captured
- [x] Sira remains after refresh
- [x] MEELUNIE remains assigned after refresh
- [x] Customer Owner dropdown shows Sira
- [x] Detailed Customer Edit saves with Sira
- [x] Refresh keeps Owner assignment
- [x] No Owner validation error
- [x] No Apps Script save error

---

# 6. Important Rules Going Forward

For migrated modules:

```text
Auth
Customer CRM
Customer Owner Directory
Detailed Customer Edit
External Sales
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

After Phase 5B smoke test passes:

```text
1. Confirm / clean Customer + External Sales production data
2. Decide whether to migrate full Users / Roles management
3. Product / Spec D1 migration
4. Pricing
5. PO Management
6. Shipping / DI
7. Operations Calendar
8. Logistics Partners
9. Payment Status
10. Commission
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

> Phase 5C is merged via PR #5.
> Next action: deploy main to production and perform Phase 5C smoke test (Users & Role Management, Add/Edit, Admin Reset Password).
