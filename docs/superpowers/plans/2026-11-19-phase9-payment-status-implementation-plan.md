# Phase 9 — Payment Status (Finance Dashboard) Implementation Plan

**Goal:** Migrate the Payment Status module from frontend mock `state.paymentRecords` to an authoritative D1-backed Finance dashboard consolidating Phase 6 Shipments, Invoices, Customer Credits, and Payment Statuses, with strict role-based projections and zero duplication of Phase 6 write invariants.

**Architecture:** Zero new D1 migrations (`0001`–`0008` untouched). Add a focused read/consolidation module `src/payments/` (`validation.js`, `repository.js`, `routes.js`) wired to `/api/payments` in `src/index.js`. Reuse Phase 6's existing atomic write endpoints (`PUT /api/shipments-v2/:id/payment`, `POST /api/customer-credits`, `POST /api/shipments-v2/:id/credit-usage`) untouched for all payment and credit mutations. Replace mock Payment Status UI in `public/index.html` with D1-backed loaders, currency-grouped KPIs, Shipment Payments & Customer Credits tabs, payment detail/audit modal, and action modals.

**Tech Stack:** JavaScript ES modules; Cloudflare Workers; Cloudflare D1 (`migrations/0001`–`0008` unchanged); HTML + inline JS in `public/index.html`; Node built-in test runner (`node --test`) + `node:sqlite` test database; Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-11-19-phase9-payment-status-design.md`

---

## Baseline & Constraints

- Baseline: `main` @ `df4b6f7` (`npm test`: 354 passed, 0 failed).
- Zero D1 migrations required: all data comes directly from existing Phase 5F/6 tables (`phase6_shipments`, `shipment_invoices`, `shipment_invoice_lines`, `customer_credits`, `customer_credit_usages`, `delivery_instructions`, `po_revisions`, `customers`, `shipment_audit_events`).
- Do not modify Phase 6 `/api/shipments-v2/*` or `/api/customer-credits` routes/validation or break any existing tests.
- All implementation occurs on `feature/phase9-payment-status` via strict TDD (red → green → full test suite), then PR → merge → production deploy & smoke test → `docs/PROJECT_STATUS.md` update.

---

## Planned File Structure

```text
src/payments/validation.js             query param validation for GET /api/payments (paymentStatus, invoiceReadiness, shipmentStatus, currency, customerId, search)
src/payments/repository.js             D1 consolidation queries (shipment payments ledger, multi-currency summary, customer credits overview, shipment payment detail + audit history)
src/payments/routes.js                 /api/payments and /api/payments/:shipmentId handlers + strict RBAC & EXTERNAL_SALES server-side projection
src/index.js                           dispatch /api/payments and /api/payments/* to createPaymentsHandlerFromEnv
public/index.html                      D1-backed Payment Status Finance dashboard, Customer Credits tab, detail/audit modal, and Phase 6 payment/credit action modals
test/payments.repository.test.js       repository tests covering multi-currency totals, PRELIMINARY vs FINAL invoices, cash + credit balance math, cancelled exclusions, and owner scoping
test/payments.routes.test.js           validation, auth (401), strict RBAC across all 6 roles (403/200), EXTERNAL_SALES projection & anti-inference tests, end-to-end integration with Phase 6 payment/credit writes, and Worker 503 check
test/frontend-adapter.test.js          regression tests verifying /api/payments usage, Phase 6 write calls, role-aware UI controls, and zero mock state.paymentRecords reads in Payment Status
```

---

## Task Breakdown

### Task 1 — Query Validation (`src/payments/validation.js`)
- [ ] Write failing validation unit tests in `test/payments.routes.test.js` covering:
  - Canonical enum allowlists (`PAYMENT_STATUSES`, `INVOICE_READINESS_VALUES`, `SHIPMENT_STATUSES`, `PAYMENT_CURRENCIES`).
  - `parsePaymentsQuery(searchParams)` normalizes `ALL`/blank to `undefined`, uppercases valid filters, and rejects invalid `paymentStatus`, `invoiceReadiness`, `shipmentStatus`, or `currency` with `400`.
- [ ] Implement `src/payments/validation.js`.
- [ ] Confirm validation tests pass (GREEN).

### Task 2 — D1 Consolidation Repository (`src/payments/repository.js`)
- [ ] Write failing repository tests in `test/payments.repository.test.js` on a migrated D1 fixture (`0001`–`0008`) covering:
  - Lists non-cancelled `phase6_shipments` (excluding `CANCELLED` shipments and `CANCELLED` DIs) with accurate `final_invoice_total`, `preliminary_invoice_total`, `cash_received_amount`, `allocated_credit_amount`, `payment_total`, `outstanding_balance`, `invoice_readiness`, `final_invoice_nos`, `latest_final_invoice_date`, and `last_payment_updated_at`.
  - Computes truthful multi-currency `summary.totals_by_currency` (separate `USD`, `EUR`, `THB` totals — never blended) and accurate status counts (`paid_count`, `partial_count`, `unpaid_count`, `final_invoiced_count`, `awaiting_final_invoice_count`).
  - Lists `customerCredits` with `customer_name`, `used_amount`, `remaining_amount`, and `usage_count`, plus `customer_credits_summary`.
  - Supports filters: `paymentStatus`, `invoiceReadiness`, `shipmentStatus`, `currency`, `customerId`, `search`, and `ownedByUserId` (strictly scoping to `customers.owner_user_id`).
  - `getShipmentPaymentDetail(shipmentId)` returns `{ shipment, invoices, creditUsages, availableCustomerCredits, paymentHistory }` and returns `null` for unknown or `CANCELLED` shipments.
- [ ] Implement `createPaymentsRepository(db)` in `src/payments/repository.js`.
- [ ] Confirm repository tests pass (GREEN).

### Task 3 — API Routes, Strict RBAC & Anti-Inference (`src/payments/routes.js` & `src/index.js`)
- [ ] Write failing route & RBAC tests in `test/payments.routes.test.js` covering:
  - Worker dispatch returns `503` without `DB` binding.
  - `401` for unauthenticated requests on `GET /api/payments` and `GET /api/payments/:shipmentId`.
  - `403` for `PRODUCTION_WAREHOUSE` on all `/api/payments` endpoints.
  - `EXTERNAL_SALES`:
    - `200` on `GET /api/payments` returning strictly owned-Customer rows with exact projected field allowlist (`commission_ready` included; `shipment_id`, `di_id`, `po_id`, `customer_id`, `payment_note`, `cash_received_amount`, `allocated_credit_amount`, `preliminary_invoice_total`, `booking_no`, `vessel` strictly absent), `customerCredits: []`, and `customer_credits_summary` omitted.
    - Anti-inference: passing another customer's `customerId` or searching by `payment_note` / `booking_no` cannot reveal hidden records or counts.
    - `403` on `GET /api/payments/:shipmentId`.
  - `SALES_SUPPORT`: `200` on `GET /api/payments` and `GET /api/payments/:shipmentId` with `can_edit_payment: false`.
  - `ADMIN`, `MANAGER`, `EXPORT`: `200` on list & detail with `can_edit_payment: true`, `404` on unknown/cancelled shipment ID, `400` on malformed path params or invalid query filters.
  - End-to-end integration test: updating cash via Phase 6 `PUT /api/shipments-v2/:id/payment` and applying credit via `POST /api/customer-credits` + `POST /api/shipments-v2/:id/credit-usage` immediately updates `GET /api/payments` and `GET /api/payments/:id` (including `PAID` status, `outstanding_balance: 0`, and `PAYMENT_UPDATED` / `CUSTOMER_CREDIT_USED` history).
- [ ] Implement `src/payments/routes.js` and wire `/api/payments` in `src/index.js`.
- [ ] Confirm all backend tests pass (GREEN).

### Task 4 — Frontend Payment Status Dashboard (`public/index.html`)
- [ ] Write failing frontend adapter tests in `test/frontend-adapter.test.js` asserting:
  - `loadPaymentsDashboardFromApi()` fetches `/api/payments` and populates `state.paymentsDashboard`.
  - `submitShipmentCashPaymentToApi()` calls Phase 6 `PUT /api/shipments-v2/:id/payment` and reloads dashboard.
  - `submitCustomerCreditToApi()` calls Phase 6 `POST /api/customer-credits` with a `requestKey` and reloads dashboard.
  - `submitApplyCustomerCreditToApi()` calls Phase 6 `POST /api/shipments-v2/:id/credit-usage` with a `requestKey` and reloads dashboard.
  - `renderPayments` and its modals never read or write mock `state.paymentRecords`.
  - Role-aware UI: hides write controls & Customer Credits tab for `EXTERNAL_SALES`; hides write controls for `SALES_SUPPORT`; shows Record Payment / Add Credit / Apply Credit for `ADMIN`, `MANAGER`, `EXPORT`.
- [ ] Implement the D1-backed Payment Status Finance dashboard, Customer Credits tab, Payment Detail modal, and Phase 6 action modals in `public/index.html`.
- [ ] Verify inline `<script>` syntax and frontend adapter tests pass (GREEN).

### Task 5 — Full Verification, Self-Review & Release Runbook
- [ ] Run full test suite (`npm test`) and confirm 0 failures and zero regressions across all Phase 5E/5F/6/7/8 suites.
- [ ] Self-review SQL aggregation math, multi-currency totals, RBAC projections, anti-inference guards, and HTML escaping.
- [ ] Commit & push `feature/phase9-payment-status` and open PR for review.
- [ ] After merge, verify production Worker deployment (no D1 migration needed), run production smoke checks, and update `docs/PROJECT_STATUS.md`.
