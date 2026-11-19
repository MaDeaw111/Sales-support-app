# Phase 7 — Operations Calendar Design

**Date:** 2026-11-19  
**Baseline:** `main` @ `ff5e41b` (318 tests passing; migrations `0001`–`0007` applied in production)  
**Scope:** Bounded D1-backed Operations Calendar read model + frontend migration (no new D1 migration)

---

## 1. Purpose and Governing Principle

Replace the frontend-only mock Operations Calendar (`state.loadingEvents`, `state.diRecords`, `state.truckBookings`, `state.surveyAssignments`, `state.paymentRecords`, and mock `state.pos` in `public/index.html`) with an authoritative, D1-backed **Operations Calendar** sourced directly from:

- **Phase 5F PO Management** (`po_headers`, `po_revisions`, `po_revision_lines`, `customers`, `products`)
- **Phase 6 Shipping / DI Integration** (`delivery_instructions`, `delivery_instruction_lines`, `phase6_shipments`, `shipment_containers`, `shipment_container_lines`, `shipment_audit_events`)

**Governing principle:** *Simple operational truth first.* Only milestones that exist as authoritative D1 records in Phase 5F and Phase 6 appear on the calendar. Do not fabricate or fall back to prototype arrays, and do not widen RBAC exposure beyond the Phase 5F and Phase 6 contracts.

---

## 2. Database & Migration Boundary

- **Zero new D1 migrations required.** Migrations remain strictly `0001` through `0007`.
- Every calendar milestone is derived read-only from existing authoritative columns:
  - **Loading dates:** `phase6_shipments.planned_loading_date`, `phase6_shipments.actual_loading_date` (plus `delivery_instructions.container_plan`, `delivery_instruction_lines`, `shipment_containers`, and `shipment_audit_events` for loading-date change history).
  - **Vessel schedule:** `phase6_shipments.etd`, `phase6_shipments.eta` (plus `booking_no`, `vessel`).
  - **PO milestones:** `po_revisions.delivery_start` and `po_revisions.delivery_end` where `po_revisions.status = 'ACTIVE'` and `po_headers.header_status <> 'CANCELLED'` (`valid_until` is intentionally excluded from calendar events to avoid visual clutter).
- **Legacy Phase 5E tables untouched:** Legacy `pos` and `shipments` tables are never read by Phase 7.

---

## 3. Canonical Calendar Event Types

All cancelled records (`po_headers.header_status = 'CANCELLED'`, `delivery_instructions.status = 'CANCELLED'`, `phase6_shipments.status = 'CANCELLED'`) are excluded from the calendar.

| Event Type | Source Column(s) | Inclusion Rule |
| :--- | :--- | :--- |
| `LOADING_PLANNED` | `phase6_shipments.planned_loading_date` | Non-cancelled DI & Shipment with non-empty `planned_loading_date`. Suppressed only if `actual_loading_date` is already recorded on the **exact same date** (avoids duplicate same-day chips; kept when actual differs from planned so schedule slips remain visible). |
| `LOADING_ACTUAL` | `phase6_shipments.actual_loading_date` | Non-cancelled DI & Shipment with non-empty `actual_loading_date`. |
| `ETD` | `phase6_shipments.etd` | Non-cancelled DI & Shipment with non-empty `etd`. |
| `ETA` | `phase6_shipments.eta` | Non-cancelled DI & Shipment with non-empty `eta`. |
| `PO_DELIVERY_START` | `po_revisions.delivery_start` | Non-cancelled PO Header with an `ACTIVE` revision and non-empty `delivery_start`. |
| `PO_DELIVERY_END` | `po_revisions.delivery_end` | Non-cancelled PO Header with an `ACTIVE` revision and non-empty `delivery_end`. |

### Deterministic Ordering & Event IDs
- Events are sorted deterministically by `event_date ASC`, then `event_type ASC`, then canonical reference (`di_no` / `customer_po_no` / `event_id`).
- For full operational roles, `event_id` is deterministic (e.g., `LOADING_PLANNED:<shipment_id>`, `ETD:<shipment_id>`, `PO_DELIVERY_END:<po_id>`).
- For restricted roles (`EXTERNAL_SALES`, `PRODUCTION_WAREHOUSE`), `event_id` is a SHA-256 opaque reference salted with `phase7-calendar:<user_id>:<role>:<kind>:<entity_id>` (mirroring Phase 6's `scopedWorkspaceDetailReference`) so internal `shipment_id`, `di_id`, and `po_id` values are never leaked.

---

## 4. API Contract

### New Read-Only Endpoint

`GET /api/operations-calendar`

**Query Parameters:**
- `from` (required or defaulted to current month start, `YYYY-MM-DD`) — inclusive start date.
- `to` (required or defaulted to current month end, `YYYY-MM-DD`) — inclusive end date (`from <= to`, max window 366 days to keep queries bounded).
- `eventType` (optional) — one of the 6 canonical event types above.
- `customerId` (optional) — filter by Customer ID (full operational roles only).
- `salesOwnerId` (optional) — filter by Customer / PO Sales Owner User ID (full operational roles only).
- `productId` (optional) — filter to events whose PO lines or DI lines include `productId`.
- `status` (optional) — filter by Shipment status (`PLANNING`, `BOOKED`, `LOADED`, `DOCS_SENT`, `COMPLETED`) or PO header status (`OPEN`, `PARTIALLY_SHIPPED`, `COMPLETED`) (ignored for `PRODUCTION_WAREHOUSE`).

**Validation:**
- Reject invalid `from`/`to` date strings, `from > to`, or ranges > 366 days with `400`.
- Reject unknown `eventType` values with `400`.
- Require authenticated session cookie (`401` if unauthenticated).

**Response Shape (`200 OK`):**
```json
{
  "status": "SUCCESS",
  "data": {
    "range": { "from": "2026-11-01", "to": "2026-11-30" },
    "events": [ ... ],
    "dailyLoadingSummary": [
      { "date": "2026-11-20", "shipment_count": 2, "actual_container_count": 5, "planned_qty_mt": 108.0 }
    ]
  }
}
```

### Rescheduling Planned Loading Date (Reuse Existing Phase 6 Write Path)

- Phase 7 does **not** add a duplicate write endpoint and leaves Phase 6's `PUT /api/shipments-v2/:id/schedule` untouched (no `scheduleNote` change on planned loading date updates).
- Authorized roles (`ADMIN`, `MANAGER`, `EXPORT` — matching `SHIPMENT_SCHEDULE_WRITE_ROLES` in `src/shipping-di/routes.js`) can reschedule a `BOOKED` shipment's `planned_loading_date` from the calendar detail modal by calling the existing `PUT /api/shipments-v2/:id/schedule` endpoint with `{ plannedLoadingDate }`.
- This preserves Phase 6's optimistic concurrency guard (`SHIPMENT_SCHEDULE_STALE`), `BOOKED`-only lifecycle gate, and `PLANNED_LOADING_DATE_UPDATED` audit logging automatically.
- After a successful update, the calendar reloads from `GET /api/operations-calendar` so D1 remains the single source of truth.
- `SALES_SUPPORT`, `EXTERNAL_SALES`, and `PRODUCTION_WAREHOUSE` have **read-only** calendar access (no reschedule controls, no drag-and-drop).

---

## 5. Strict RBAC Matrix & Server-Side Projections

Calendar events **never** expose commercial prices, unit prices, invoice amounts, payment amounts/statuses, customer credits, commissions, or Drive document URLs to **any** role.

### A. Full Operational Readers (`ADMIN`, `MANAGER`, `SALES_SUPPORT`, `EXPORT`)

- **Allowed event types:** All 6 (`LOADING_PLANNED`, `LOADING_ACTUAL`, `ETD`, `ETA`, `PO_DELIVERY_START`, `PO_DELIVERY_END`).
- **Allowed filters:** `from`, `to`, `eventType`, `customerId`, `salesOwnerId`, `productId`, `status`.
- **Event payload fields:**
  - Shipment/DI events (`LOADING_PLANNED`, `LOADING_ACTUAL`, `ETD`, `ETA`):
    `event_id`, `event_type`, `event_date`, `shipment_id`, `di_id`, `di_no`, `po_id`, `customer_po_no`, `customer_id`, `customer_name`, `sales_owner_user_id`, `di_status`, `shipment_status`, `booking_no`, `vessel`, `etd`, `eta`, `planned_loading_date`, `actual_loading_date`, `schedule_result`, `container_plan`, `planned_qty_mt`, `actual_container_count`, `products` (`product_id`, `product_code`, `product_name`, `planned_qty_mt`, `packing_snapshot`), `loading_date_history` (from `shipment_audit_events` for `PLANNED_LOADING_DATE_UPDATED` & `ACTUAL_LOADING_DATE_RECORDED`), `can_reschedule` (boolean: true only when `shipment_status === 'BOOKED'` and caller role is in `['ADMIN', 'MANAGER', 'EXPORT']`).
  - PO milestone events (`PO_DELIVERY_START`, `PO_DELIVERY_END`):
    `event_id`, `event_type`, `event_date`, `po_id`, `customer_po_no`, `customer_id`, `customer_name`, `sales_owner_user_id`, `po_status`, `incoterm`, `destination`, `delivery_start`, `delivery_end`, `total_contract_qty_mt`, `products` (`product_id`, `product_code`, `product_name`, `contract_qty_mt`, `packaging`).
- **Daily loading summary:** Computed across the caller's visible loading events (`date`, `shipment_count`, `actual_container_count`, `planned_qty_mt`).

### B. `EXTERNAL_SALES` (Strict Owned-Customer Projection)

Aligned strictly with Phase 5F (`src/pos/routes.js`) and Phase 6 (`src/shipping-di/routes.js`, `docs/2026-08-30-task13-rbac-review-fixes.md`):

- **Row scoping:**
  - Shipment/DI events: ONLY where `customers.owner_user_id = caller.user_id`.
  - PO milestone events: ONLY where `po_revisions.status = 'ACTIVE'`, `ownership_type_snapshot = 'ASSIGNED_SALES'`, `sales_owner_user_id_snapshot = caller.user_id`, AND `customers.owner_user_id = caller.user_id`.
- **Allowed event types:** All 6.
- **Query filter anti-inference hardening:**
  - Ignore `customerId`, `salesOwnerId`, and `productId` on Shipment/DI queries (and ignore `salesOwnerId` on PO queries; if `customerId` is passed on PO queries, it is still constrained by ownership so non-owned customers return 0 rows identically). In fact, ignoring `customerId`, `salesOwnerId`, and `productId` altogether for `EXTERNAL_SALES` on `GET /api/operations-calendar` guarantees zero filter-based inference across hidden fields. Allowed filters: `from`, `to`, `eventType`, `status`.
- **Strict field allowlist:**
  - Shipment/DI events (`LOADING_PLANNED`, `LOADING_ACTUAL`, `ETD`, `ETA`) — exact Phase 6 allowlist:
    `event_id` (opaque hash), `event_type`, `event_date`, `di_no`, `di_status`, `shipment_status`, `booking_no`, `vessel`, `etd`, `eta`, `planned_loading_date`, `actual_loading_date`, `schedule_result`.
    **Strictly omitted:** `shipment_id`, `di_id`, `po_id`, `customer_id`, `customer_name`, `sales_owner_user_id`, `shipping_month`, `shipping_period`, `container_plan`, `planned_qty_mt`, `actual_container_count`, `products`, `containers`, `loading_date_history`, payment/invoice/credit/document/audit/partner fields.
  - PO milestone events (`PO_DELIVERY_START`, `PO_DELIVERY_END`):
    `event_id` (opaque hash), `event_type`, `event_date`, `customer_po_no`, `po_status`, `incoterm`, `destination`, `delivery_start`, `delivery_end`, `total_contract_qty_mt`.
    **Strictly omitted:** internal `po_id`, `customer_id`, `sales_owner_user_id`, unit prices, commissions, commercial/operational notes, audit logs.
- **Daily loading summary:** Omitted (`[]`) or count-only (`date`, `shipment_count`) over owned visible loading events (no `planned_qty_mt` or `actual_container_count`, keeping aligned with Phase 6). **Ruling:** Return `dailyLoadingSummary: []` for `EXTERNAL_SALES` so no unapproved loading-quantity/container aggregates leak.

### C. `PRODUCTION_WAREHOUSE` (Strict Loading-Only Projection)

Aligned strictly with Phase 6 (`src/shipping-di/routes.js`, `docs/2026-08-30-task13-rbac-review-fixes.md`):

- **Allowed event types:** **ONLY** `LOADING_PLANNED` and `LOADING_ACTUAL`.
  - `ETD`, `ETA`, `PO_DELIVERY_START`, and `PO_DELIVERY_END` are **never** queried or returned. If `eventType` requests a disallowed type, return `events: []` (`200 OK`, no error revealing existence).
- **Query filter anti-inference hardening:**
  - Ignore `customerId`, `salesOwnerId`, and `status` before querying so hidden fields cannot alter result counts.
  - Allowed filters: `from`, `to`, `eventType` (restricted to `LOADING_PLANNED` / `LOADING_ACTUAL`), `productId`.
- **Strict field allowlist (exact Phase 6 Warehouse contract):**
  - `event_id` (opaque hash), `event_type` (`LOADING_PLANNED` | `LOADING_ACTUAL`), `event_date`, `planned_loading_date`, `actual_loading_date`, `container_plan`, `planned_qty_mt`, `actual_container_count`, `products` (`product_code`, `product_name`, `planned_qty_mt`, `packing_snapshot`), and `containers` (`container_no`, `seal_no`, `lines: [{ product_code, product_name, number_of_bags, qty_mt }]`).
  - **Strictly omitted:** `di_status`, `shipment_status`, `schedule_result`, `status`, internal IDs (`shipment_id`, `di_id`, `po_id`, `customer_id`), `di_no`, `customer_po_no`, `customer_name`, `sales_owner_user_id`, `booking_no`, `vessel`, `etd`, `eta`, `loading_date_history`, payment/invoice/credit/document/audit/partner/commercial data.
- **Daily loading summary:** Included (`date`, `shipment_count`, `actual_container_count`, `planned_qty_mt`) — all fields are within the Warehouse-approved loading/product/container scope.

---

## 6. Frontend UX Design (`public/index.html`)

- **Data loading:**
  - Add `loadOperationsCalendarFromApi()` fetching `GET /api/operations-calendar?from=...&to=...` whenever the Operations Calendar view opens, period shifts (Month/Week/Agenda), or filters change.
  - Store response in `state.operationsCalendar = { range, events, dailyLoadingSummary, loading, error }`.
  - Remove all calendar reads from mock `state.loadingEvents`, `state.diRecords`, `state.truckBookings`, `state.surveyAssignments`, `state.paymentRecords`, and mock `state.pos`.
- **Views preserved:**
  - **Month**, **Week**, and **Agenda** views with Prev / Next / Today navigation.
  - **Daily loading summary badge** on days with loading events (shows real shipment count + planned MT / actual containers — **removes** the hardcoded fake `15 containers / OVER CAPACITY` mock bar since Phase 6 `container_plan` is free-text and no factory daily container cap exists in D1).
- **Role-aware UI (mirroring server allowlists):**
  - `PRODUCTION_WAREHOUSE`: Heading `"Loading Calendar"` + View Only banner; hide Customer, Sales Owner, and Status filter dropdowns; Event Type filter offers only `All Loading`, `Planned Loading`, `Actual Loading`; detail modal renders only loading dates, container plan, product/packing list, and actual containers/seals/bags/MT; no `"Open PO"`, `"Open Shipment"`, or `"Change Loading Date"` buttons.
  - `EXTERNAL_SALES`: Hide Customer, Sales Owner, and Product filter dropdowns (matching server anti-inference rules); detail modal renders only approved DI/booking/ETD/ETA/loading or owned PO milestone fields; read-only (no reschedule action).
  - `ADMIN`, `MANAGER`, `SALES_SUPPORT`, `EXPORT`: Full filter bar (Customer, Sales Owner from D1 `state.customerOwners`, Product from D1 `state.products`, Event Type, Status); detail modal links to real D1 PO Detail (`goToPODetail`) / Phase 6 Shipping Workspace (`openPhase6ShipmentFromCalendar`) and shows real `loading_date_history` from `shipment_audit_events`.
  - `ADMIN`, `MANAGER`, `EXPORT`: On `LOADING_PLANNED` events where `can_reschedule === true` (`shipment_status === 'BOOKED'`), show a `"Change Planned Loading Date"` action calling `PUT /api/shipments-v2/:id/schedule` and reloading the calendar.

---

## 7. Explicitly Out of Scope

Phase 7 does **not** include:
- Any new D1 migration or schema change;
- Factory daily container-capacity limits or parsing free-text `container_plan` into synthetic container capacity bars;
- Truck bookings, surveyor schedules, standalone production stages (`WAITING_PLAN`/`PACKING`), document-due synthetic dates, or payment calendar milestones (deferred to Logistics Partners & Payment Status phases);
- Drag-and-drop rescheduling of ETD, ETA, Actual Loading Date, or PO delivery windows (only `BOOKED` Planned Loading Date can be edited via Phase 6's schedule endpoint);
- Calendar export (`.ics` / Google Calendar sync) or email notifications;
- Migrating `Logistics Partners`, `Payment Status`, `Commission`, or removing Tailwind CDN.

---

## 8. Success Criteria

Phase 7 succeeds when:
1. Operations Calendar renders live D1 milestones (`LOADING_PLANNED`, `LOADING_ACTUAL`, `ETD`, `ETA`, `PO_DELIVERY_START`, `PO_DELIVERY_END`) across Month, Week, and Agenda views with zero reads from mock prototype arrays.
2. `PRODUCTION_WAREHOUSE` receives strictly loading events with only the Phase 6 Warehouse-approved allowlist, cannot see PO/ETD/ETA/status/customer/booking fields, and cannot infer hidden fields via query params.
3. `EXTERNAL_SALES` receives strictly owned-Customer events with only Phase 5F/6-approved fields, cannot see other owners' records or internal IDs/audit/commercial data, and cannot infer hidden fields via query params.
4. `ADMIN`, `MANAGER`, and `EXPORT` can reschedule a `BOOKED` shipment's Planned Loading Date directly from the calendar via `PUT /api/shipments-v2/:id/schedule`, persisting to D1 and recording `PLANNED_LOADING_DATE_UPDATED` in `shipment_audit_events`.
5. All existing 318 tests plus new Phase 7 unit, route, RBAC, and frontend adapter tests pass cleanly.
