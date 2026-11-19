# Phase 8 — Logistics Partners Design

**Date:** 2026-11-19  
**Baseline:** `main` @ `60088be` (334 tests passing; migrations `0001`–`0007` applied in production)  
**Scope:** Bounded D1-backed Logistics Partners directory, full partner profile management, reference rate history, and live Phase 6 usage history — extending Phase 6's `service_partners` table as the single source of truth.

---

## 1. Purpose and Governing Principle

Replace the frontend-only mock Logistics Partners view (`state.logisticsProviders`, `state.providerPrices`, `state.providerUsageRecords`, `state.truckBookings`, `state.forwarderAssignments`, `state.surveyAssignments` in `public/index.html`) with an authoritative D1-backed **Logistics Partners** module built directly on top of Phase 6's `service_partners` table.

**Governing principle:** *One unified partner master, simple operational truth.* A partner created or updated in **Logistics Partners** is immediately stored in `service_partners` and available in Phase 6 **Shipping / DI** partner dropdowns (and vice versa). Usage history is derived live from Phase 6 DIs and Shipments—never duplicated or mocked.

---

## 2. Database Schema & Additive D1 Migration

### Existing Table Reused (`migrations/0007_shipping_di_integration.sql`)

`service_partners` already defines the full partner profile schema:
- `partner_id` (`SP-001`, `SP-002`, ...)
- `partner_type` (`FORWARDER`, `SHIPPING_LINE`, `TRUCKING`, `SURVEYOR`) — **immutable after creation**
- `partner_name` (non-empty)
- `contact_name`, `contact_phone`, `contact_email`, `address`, `tax_id`, `note` (nullable profile fields already present in `0007`!)
- `status` (`ACTIVE`, `INACTIVE`)
- `created_by`, `created_at`, `updated_by`, `updated_at`

No alteration to `service_partners` is required.

### New Additive Migration (`migrations/0008_logistics_partners.sql`)

Adds a single table `service_partner_rates` for reference rate cards & history:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS service_partner_rates (
  rate_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES service_partners(partner_id) ON DELETE CASCADE,
  service_type TEXT NOT NULL CHECK(trim(service_type) <> ''),
  route_scope TEXT,
  container_size TEXT NOT NULL DEFAULT '-' CHECK(container_size IN ('20GP','40GP','40HC','BULK','OTHER','-')),
  unit TEXT NOT NULL CHECK(trim(unit) <> ''),
  price REAL NOT NULL CHECK(price > 0),
  currency TEXT NOT NULL CHECK(currency IN ('THB','USD','EUR')),
  effective_date TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(valid_until IS NULL OR valid_until >= effective_date)
);

CREATE INDEX IF NOT EXISTS idx_service_partner_rates_partner_status
  ON service_partner_rates(partner_id, status, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_partners_type_status
  ON service_partners(partner_type, status, partner_name);
```

- **Additive only:** No existing table is dropped, renamed, or altered.
- **No hard deletes:** Both partners and reference rates use `status = 'INACTIVE'` for retirement so historical references remain intact.

---

## 3. Live Usage History (Zero New Tables)

Usage History for a partner is queried directly (read-only) from authoritative Phase 6 tables where the partner is referenced on non-cancelled DIs/Shipments:

- `delivery_instructions.surveyor_partner_id` → role used: `SURVEYOR`
- `delivery_instructions.forwarder_partner_id` or `phase6_shipments.forwarder_partner_id` → role used: `FORWARDER`
- `phase6_shipments.shipping_line_partner_id` → role used: `SHIPPING_LINE`
- `phase6_shipments.trucking_partner_id` → role used: `TRUCKING`

Each usage row returns:
- `di_id`, `shipment_id` (nullable if DI is not yet confirmed into a shipment)
- `di_no`, `customer_name`, `booking_no`, `vessel`, `container_plan`
- `usage_date` (`COALESCE(s.actual_loading_date, s.planned_loading_date, s.etd, substr(di.created_at, 1, 10))`)
- `partner_role` (`SURVEYOR` | `FORWARDER` | `SHIPPING_LINE` | `TRUCKING`)
- `di_status`, `shipment_status`
- `actual_container_count` (count of non-cancelled `shipment_containers` rows)

Ordered by `usage_date DESC, di_no DESC`. Excludes `CANCELLED` DIs and `CANCELLED` shipments.

---

## 4. API Contract (`/api/logistics-partners`)

Keep Phase 6's `/api/service-partners` routes and validation **100% untouched** so existing Phase 6 tests and contracts remain unchanged. Add a dedicated Phase 8 module `src/logistics-partners/` mounted at `/api/logistics-partners`:

### Endpoints

1. **`GET /api/logistics-partners`**
   - Optional query params: `partnerType` (`FORWARDER` | `SHIPPING_LINE` | `TRUCKING` | `SURVEYOR`), `status` (`ACTIVE` | `INACTIVE`), `search` (case-insensitive substring on `partner_name`, `partner_id`, `contact_name`).
   - Returns `{ status: 'SUCCESS', data: { partners: [...] } }` where each partner includes full profile fields plus summary counts: `active_rate_count` and `usage_count`.

2. **`GET /api/logistics-partners/:id`**
   - Returns `{ status: 'SUCCESS', data: { partner, rates, usage } }`:
     - `partner`: full `service_partners` record
     - `rates`: all `service_partner_rates` rows for this partner ordered by `effective_date DESC, created_at DESC`
     - `usage`: live Phase 6 usage rows derived from `delivery_instructions` + `phase6_shipments`
   - Returns `404` if partner does not exist.

3. **`POST /api/logistics-partners`**
   - Creates a new partner in `service_partners` using the exact same `SP-XXX` sequential ID generator as Phase 6.
   - Allowed payload properties (strict allowlist; unknown properties rejected with `400`):
     `partnerName` (required, trimmed non-empty), `partnerType` (required, one of `FORWARDER`, `SHIPPING_LINE`, `TRUCKING`, `SURVEYOR`), `status` (optional, default `ACTIVE`), `contactName`, `contactPhone`, `contactEmail` (optional email format check if non-empty), `address`, `taxId`, `note`.
   - Returns `201` (or `200` matching repo convention — let's use `200` with `{ status: 'SUCCESS', data: { partner } }` to match Phase 6 `/api/service-partners` and Phase 5F).

4. **`PUT /api/logistics-partners/:id`**
   - Updates profile fields (`partnerName`, `status`, `contactName`, `contactPhone`, `contactEmail`, `address`, `taxId`, `note`).
   - **Rejects `partnerType` changes** (`400`, `SERVICE_PARTNER_TYPE_IMMUTABLE`) if `partnerType` is supplied and differs from the stored type (matching Phase 6).
   - Returns `404` if partner does not exist.

5. **`POST /api/logistics-partners/:id/rates`**
   - Adds a reference rate row to `service_partner_rates` (`SPR-0001`, `SPR-0002`, ...).
   - Validations:
     - Partner must exist (`404` otherwise).
     - `serviceType`: required non-empty string.
     - `routeScope`: optional trimmed string.
     - `containerSize`: optional, default `'-'`, must be in `['20GP','40GP','40HC','BULK','OTHER','-']`.
     - `unit`: required non-empty string (e.g. `THB / Container`, `USD / Container`, `THB / Job`).
     - `price`: required finite number `> 0` (up to 2 decimal places).
     - `currency`: required, in `['THB','USD','EUR']`.
     - `effectiveDate`: required strict ISO `YYYY-MM-DD`.
     - `validUntil`: optional strict ISO `YYYY-MM-DD`, must be `>= effectiveDate` when provided.
     - `status`: optional, default `'ACTIVE'`, in `['ACTIVE','INACTIVE']`.
     - `note`: optional trimmed string.
   - Rejects unknown payload properties with `400`.

6. **`PATCH /api/logistics-partners/:id/rates/:rateId`**
   - Updates an existing rate's mutable fields (`serviceType`, `routeScope`, `containerSize`, `unit`, `price`, `currency`, `effectiveDate`, `validUntil`, `status`, `note`) with full re-validation (including `validUntil >= effectiveDate` against merged values).
   - Verifies `rate_id` belongs to `partner_id` (`404` otherwise).

---

## 5. Strict RBAC Matrix

Aligned directly with `navConfig` (`logistics_partners`) and Phase 6 `src/shipping-di/routes.js`:

| Role | `GET /api/logistics-partners` & `/:id` | `POST` / `PUT` Partner & `POST` / `PATCH` Rates |
| :--- | :---: | :---: |
| `ADMIN` | Allow | Allow |
| `MANAGER` | Allow | Allow |
| `EXPORT` | Allow | Allow |
| `SALES_SUPPORT` | Allow (read-only) | **403 Denied** |
| `EXTERNAL_SALES` | **403 Denied** | **403 Denied** |
| `PRODUCTION_WAREHOUSE` | **403 Denied** | **403 Denied** |
| Unauthenticated | **401 Unauthorized** | **401 Unauthorized** |

- **UI enforcement:** `+ Add Partner`, `Edit Profile`, `+ Add Rate`, and rate `Edit` / `Deactivate` controls render only for `['ADMIN', 'MANAGER', 'EXPORT']`. `SALES_SUPPORT` sees a clean read-only view.

---

## 6. Frontend UX Design (`public/index.html`)

- **State & loaders:**
  - Add `state.logisticsPartners = { items: [], detail: null, loading: false, error: null, loaded: false }`.
  - Add `loadLogisticsPartnersFromApi()` (`GET /api/logistics-partners`) and `loadLogisticsPartnerDetailFromApi(partnerId)` (`GET /api/logistics-partners/:id`).
  - Remove all Logistics Partners directory/detail reads & writes from mock `state.logisticsProviders`, `state.providerPrices`, and `state.providerUsageRecords`.
- **Directory view (`renderLogisticsPartners`):**
  - Filter pills for `All`, `Forwarder`, `Shipping Line`, `Trucking`, `Surveyor` + optional status/search filter.
  - Cards show `partner_id`, `partner_type`, `partner_name`, `contact_name`, `contact_phone`, `status`, live `active_rate_count`, and live `usage_count`.
- **Detail view (`renderLogisticsPartnerDetail`):**
  - **Profile tab:** Displays all `service_partners` fields (`partner_name`, `partner_type`, `contact_name`, `contact_phone`, `contact_email`, `tax_id`, `address`, `status`, `note`) with Edit modal calling `PUT /api/logistics-partners/:id` (`partner_type` shown read-only on edit).
  - **Rate History tab:** Displays `service_partner_rates` rows with `+ Add Rate` modal (`POST /api/logistics-partners/:id/rates`) and `Edit` / `Activate` / `Deactivate` actions (`PATCH /api/logistics-partners/:id/rates/:rateId`). Clearly flags expired rates (`valid_until < today`).
  - **Usage History tab:** Displays live Phase 6 usage rows (`usage_date`, `di_no`, `customer_name`, `partner_role`, `booking_no`, `vessel`, `container_plan`, `actual_container_count`, `shipment_status`) with a button to jump directly to the Phase 6 Shipment detail (`openPhase6ShipmentFromCalendar` / shared helper).
- **Cross-module sync:** After creating/updating a partner in Logistics Partners, also refresh Phase 6's cached `state.phase6ServicePartners` (if loaded) so Shipping/DI dropdowns immediately reflect the new/updated partner.

---

## 7. Explicitly Out of Scope

Phase 8 does **not** include:
- Multi-trucking split allocation tables per loading event (`truckBookings`) or standalone `forwarderAssignments` / `surveyAssignments` workflows (Phase 6 `delivery_instructions` and `phase6_shipments` remain the authoritative operational assignment model);
- Automated cost/invoice calculation from reference rates into Phase 5E `shipment_expenses` or Phase 6 `shipment_invoices`;
- Vendor AP/payment tracking, bank details, or vendor KPI/performance scoring;
- Document/contract file uploads to Google Drive or R2;
- Modifying Phase 6's `/api/service-partners` API contract or tests;
- Payment Status or Commission Settlement (later phases).

---

## 8. Success Criteria

Phase 8 succeeds when:
1. `migrations/0008_logistics_partners.sql` applies cleanly on top of `0001`–`0007` with zero changes to existing tables.
2. `ADMIN`, `MANAGER`, and `EXPORT` can create/edit Logistics Partners (all 4 types + full profile) and add/edit/deactivate reference rates, persisted in D1.
3. Partners created in Logistics Partners immediately appear in Phase 6 Shipping/DI partner dropdowns, and partners assigned on Phase 6 DIs/Shipments immediately appear in the partner's live Usage History tab.
4. `SALES_SUPPORT` has read-only access (`403` on writes); `EXTERNAL_SALES` and `PRODUCTION_WAREHOUSE` receive `403` on all `/api/logistics-partners` endpoints.
5. Zero reads/writes to mock `state.logisticsProviders`, `state.providerPrices`, or `state.providerUsageRecords` remain in the Logistics Partners view.
6. All existing 334 tests plus new Phase 8 migration, repository, route, RBAC, and frontend adapter tests pass cleanly.
