# Phase 7 — Operations Calendar Implementation Plan

**Goal:** Migrate Operations Calendar from frontend prototype mock arrays to a D1-backed read model sourcing Loading Dates, ETD, ETA, and PO milestones directly from Phase 5F POs and Phase 6 DIs/Shipments, with strict RBAC projections for `PRODUCTION_WAREHOUSE` and `EXTERNAL_SALES`.

**Architecture:** Add a focused read-only module under `src/calendar/` (`validation.js`, `repository.js`, `routes.js`) wired to `GET /api/operations-calendar` in `src/index.js`. Reuse existing Phase 6 `PUT /api/shipments-v2/:id/schedule` for rescheduling `BOOKED` Planned Loading Dates. Replace prototype calendar builders in `public/index.html` with an API-backed loader and role-aware Month/Week/Agenda UI.

**Tech Stack:** JavaScript ES modules; Cloudflare Workers; Cloudflare D1 (`migrations/0001`–`0007`, no new migration); HTML + inline JS in `public/index.html`; Node built-in test runner (`node --test`) + `node:sqlite` test database.

**Spec:** `docs/superpowers/specs/2026-11-19-phase7-operations-calendar-design.md`

---

## Baseline & Constraints

- Baseline: `main` @ `ff5e41b` (`npm test`: 318 passed, 0 failed).
- No D1 migrations added or altered (`0001`–`0007` remain unchanged).
- All implementation work will happen on a dedicated feature branch (e.g., `feature/phase7-operations-calendar`) via TDD (red test → minimal green implementation → full test suite), then PR → preview → merge → deploy → smoke test.
- Never leak prices, invoice amounts, payment statuses, customer credits, commissions, or Drive URLs in calendar responses.
- Never allow hidden filter query params to alter result counts for restricted roles (`PRODUCTION_WAREHOUSE`, `EXTERNAL_SALES`).

---

## Planned File Structure

```text
src/calendar/validation.js                date-range & query-param validation helpers
src/calendar/repository.js                D1 queries assembling PO & Shipping/DI calendar events + daily loading summary
src/calendar/routes.js                    GET /api/operations-calendar handler + strict role projections & anti-inference guards
src/index.js                              dispatch /api/operations-calendar to createCalendarHandlerFromEnv
public/index.html                         D1-backed Operations Calendar loader, filters, Month/Week/Agenda views, detail & reschedule modals
test/calendar.repository.test.js          repository tests on real migrated D1 fixture (date ranges, deduplication, cancelled exclusion, history)
test/calendar.routes.test.js              route validation, auth, filtering, and full operational role contract tests
test/calendar.rbac.test.js                strict RBAC allowlist & anti-inference tests for PRODUCTION_WAREHOUSE, EXTERNAL_SALES, EXPORT, SALES_SUPPORT
test/frontend-adapter.test.js             regression assertions that calendar uses /api/operations-calendar and zero mock arrays
```

---

## Task Breakdown

### Task 1 — Query & Date Range Validation (`src/calendar/validation.js`)
- [ ] Write failing unit tests in `test/calendar.routes.test.js` covering:
  - Missing `from`/`to` defaults cleanly or validates `YYYY-MM-DD` strictly (rejecting invalid calendar dates like `2026-02-30`).
  - Rejects `from > to` and ranges exceeding 366 days (`400`).
  - Rejects unknown `eventType` values (`400`).
- [ ] Implement `parseCalendarQuery(searchParams, now)` in `src/calendar/validation.js` exporting `CALENDAR_EVENT_TYPES`, `WAREHOUSE_EVENT_TYPES`, and validation helpers.
- [ ] Verify unit tests pass.

### Task 2 — D1 Calendar Read Repository (`src/calendar/repository.js`)
- [ ] Write failing repository tests in `test/calendar.repository.test.js` using a real migrated D1 fixture (`0001`–`0007`) covering:
  - Emits `LOADING_PLANNED`, `LOADING_ACTUAL`, `ETD`, `ETA` from non-cancelled `delivery_instructions` + `phase6_shipments`.
  - Same-day deduplication: when `actual_loading_date === planned_loading_date`, emits `LOADING_ACTUAL` only (no duplicate `LOADING_PLANNED` chip); when they differ, emits both so schedule slip is visible.
  - Emits `PO_DELIVERY_START` and `PO_DELIVERY_END` from `ACTIVE` `po_revisions` of non-cancelled `po_headers` only (ignores `DRAFT`, `SUPERSEDED`, and `CANCELLED` POs; intentionally excludes `valid_until`).
  - Excludes `CANCELLED` DIs and `CANCELLED` shipments.
  - Filters strictly by `[from, to]` inclusive date window.
  - Attaches real product/packing lines (`delivery_instruction_lines` / `po_revision_lines`), actual non-cancelled containers/lines (`shipment_containers` + `shipment_container_lines`), and real `loading_date_history` from `shipment_audit_events` (`PLANNED_LOADING_DATE_UPDATED`, `ACTUAL_LOADING_DATE_RECORDED`).
  - Computes `dailyLoadingSummary` accurately (`shipment_count`, `actual_container_count`, `planned_qty_mt`) without double-counting when a shipment has both planned and actual dates on different days.
  - Supports filtering by `eventType`, `customerId`, `salesOwnerId`, `productId`, `status`, plus optional `ownedByUserId` constraint for `EXTERNAL_SALES` and `loadingOnly` mode for `PRODUCTION_WAREHOUSE`.
- [ ] Implement `createCalendarRepository(db)` in `src/calendar/repository.js`.
- [ ] Verify repository tests pass.

### Task 3 — API Route & Strict RBAC Projections (`src/calendar/routes.js` & `src/index.js`)
- [ ] Write failing RBAC and route tests in `test/calendar.rbac.test.js` and `test/calendar.routes.test.js` covering:
  - `401` when unauthenticated.
  - `ADMIN`, `MANAGER`, `SALES_SUPPORT`, `EXPORT`: receive all 6 event types, full operational fields, zero prices/payments/invoices/credits/commissions/URLs, and `can_reschedule: true` ONLY for `ADMIN`/`MANAGER`/`EXPORT` on `BOOKED` `LOADING_PLANNED` events (`false` for `SALES_SUPPORT` and non-`BOOKED` shipments).
  - `PRODUCTION_WAREHOUSE`:
    - Receives ONLY `LOADING_PLANNED` and `LOADING_ACTUAL`; requesting `eventType=ETD` or `PO_DELIVERY_END` returns `events: []`.
    - Exact key-set assertion: ONLY approved Warehouse fields (`event_id` opaque hash, `event_type`, `event_date`, `planned_loading_date`, `actual_loading_date`, `container_plan`, `planned_qty_mt`, `actual_container_count`, `products`, `containers`).
    - Zero forbidden fields (`status`, `di_status`, `shipment_status`, `schedule_result`, `shipment_id`, `di_id`, `di_no`, `po_id`, `customer_po_no`, `customer_id`, `customer_name`, `sales_owner_user_id`, `booking_no`, `vessel`, `etd`, `eta`, `loading_date_history`, commercial/audit data).
    - Anti-inference test: passing `customerId`, `salesOwnerId`, or `status` query params does NOT change returned event counts or results.
  - `EXTERNAL_SALES`:
    - Receives ONLY events for Customers currently owned by `caller.user_id` (and for PO milestones, `ASSIGNED_SALES` owned by `caller.user_id`). Reassigning customer ownership immediately updates visibility.
    - Exact key-set assertion on Shipment/DI events (matches Phase 6 allowlist; opaque `event_id`; zero internal IDs, `customer_id`, `customer_name`, `shipping_month`, `container_plan`, `products`, `containers`, `loading_date_history`).
    - Exact key-set assertion on PO milestone events (opaque `event_id`; zero internal `po_id`, `customer_id`, prices, commissions, notes).
    - `dailyLoadingSummary` is empty `[]`.
    - Anti-inference test: passing `customerId`, `salesOwnerId`, or `productId` query params does NOT alter returned results.
- [ ] Implement `createCalendarHandler` / `createCalendarHandlerFromEnv` in `src/calendar/routes.js` and wire `/api/operations-calendar` in `src/index.js`.
- [ ] Verify all calendar backend tests pass.

### Task 4 — Frontend Operations Calendar Migration (`public/index.html`)
- [ ] Write failing frontend adapter/regression tests in `test/frontend-adapter.test.js` asserting:
  - `loadOperationsCalendarFromApi()` fetches `/api/operations-calendar` with `from`/`to` and active role-allowed filters.
  - Calendar rendering reads from `state.operationsCalendar` and NEVER references mock `state.loadingEvents`, `state.diRecords`, `state.truckBookings`, `state.surveyAssignments`, `state.paymentRecords`, or hardcoded `CALENDAR_DAILY_MAX_CONTAINERS = 15`.
  - Role-aware UI: `PRODUCTION_WAREHOUSE` hides Customer/Sales Owner/Status filters and omits PO/Shipment navigation and reschedule controls; `EXTERNAL_SALES` hides Customer/Sales Owner/Product filters and reschedule controls.
  - Reschedule modal submits to `PUT /api/shipments-v2/:id/schedule` and reloads the calendar from D1.
- [ ] Implement the D1-backed Operations Calendar loader, state management, filter bar, Month/Week/Agenda renderers, detail modal, and `BOOKED` Planned Loading Date reschedule modal in `public/index.html`.
- [ ] Verify inline `<script>` syntax and frontend adapter tests pass.

### Task 5 — Verification, Review & Release Preparation
- [ ] Run full test suite (`npm test`) and confirm 0 failures and zero regressions in Phase 5E/5F/6 suites.
- [ ] Perform self-review of RBAC allowlists, SQL queries, date boundary handling (month/week UTC date math), and UI role gating.
- [ ] Open PR from `feature/phase7-operations-calendar` → `main` for review before merge and production deploy.
- [ ] After deploy, execute production smoke test checklist (Admin/Export full view + reschedule, `EXTERNAL_SALES` owned-only view, `PRODUCTION_WAREHOUSE` loading-only view) and update `docs/PROJECT_STATUS.md`.
