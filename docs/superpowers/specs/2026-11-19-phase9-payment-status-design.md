# Phase 9 — Payment Status (Finance Dashboard) Design

**Date:** 2026-11-19  
**Baseline:** `main` @ `df4b6f7` (354 tests passing; migrations `0001`–`0008` applied in production)  
**Scope:** Bounded D1-backed **Payment Status** Finance dashboard consolidating Phase 6 Shipments, Preliminary/Final Invoices, Customer Credits, and Payment Statuses — with strict role-based projections and zero duplication of Phase 6 payment/credit write invariants.

---

## 1. Purpose and Governing Principle

Replace the frontend-only mock Payment Status view (`state.paymentRecords`, `getScopedPaymentRecords`, `openPaymentModal`, `savePaymentRecord`, `deletePaymentRecord` in `public/index.html`) with an authoritative D1-backed **Payment Status** Finance module sourcing 100% live truth from Phase 6 tables (`phase6_shipments`, `shipment_invoices`, `shipment_invoice_lines`, `customer_credits`, `customer_credit_usages`, `delivery_instructions`, `po_revisions`, `customers`, `shipment_audit_events`).

**Governing principle:** *One authoritative financial ledger, zero duplicate payment math.*
- Phase 6 (`src/shipping-di/`) remains the single authority for **recording cash payments**, **creating customer credits**, **allocating credits to shipments**, **calculating `payment_status`**, and **auto-completing `DOCS_SENT` → `COMPLETED` shipments**.
- Phase 9 (`src/payments/`) provides the consolidated **Finance read/query API** (`GET /api/payments`, `GET /api/payments/:shipmentId`) with server-side KPI aggregation (grouped by currency), aging/readiness signals, filterable shipment ledger, customer credit overview, and strict role-based projections.
- All payment & credit mutations initiated from the Payment Status UI invoke the existing, battle-tested Phase 6 endpoints (`PUT /api/shipments-v2/:id/payment`, `POST /api/customer-credits`, `POST /api/shipments-v2/:id/credit-usage`) untouched — guaranteeing 100% consistency between **Shipping / DI** and **Payment Status** (the exact pattern proven in Phase 7 Operations Calendar).

---

## 2. D1 Migration Decision

**No new D1 migration is required (`0001`–`0008` remain completely untouched).**

All required columns and tables already exist in production D1 (`migrations/0007_shipping_di_integration.sql`):
- `phase6_shipments`: `shipment_id`, `di_id`, `status`, `booking_no`, `vessel`, `etd`, `eta`, `actual_loading_date`, `cash_received_amount`, `payment_status` (`UNPAID` | `PARTIAL` | `PAID`), `payment_note`, `updated_at`
- `shipment_invoices` & `shipment_invoice_lines`: `invoice_id`, `invoice_no`, `invoice_date`, `currency` (`USD` | `THB` | `EUR`), `version` (`PRELIMINARY` | `FINAL`), `line_amount`
- `customer_credits` & `customer_credit_usages`: `credit_id`, `customer_id`, `amount`, `remaining_amount`, `reason`, `credit_usage_id`, `shipment_id`, `invoice_id`, `created_at`
- `delivery_instructions`, `po_headers`, `po_revisions`, `customers`: `di_no`, `customer_name`, `customer_code`, `owner_user_id`, `po_id`, `customer_po_no`, `currency`, `payment_term_snapshot`
- `shipment_audit_events`: `PAYMENT_UPDATED`, `CUSTOMER_CREDIT_CREATED`, `CUSTOMER_CREDIT_USED`, `INVOICE_RECORDED`, `INVOICE_FINALIZED`, `SHIPMENT_COMPLETED`

> **Note on prototype fields (`bankReference`, `paymentDate`, `deletePaymentRecord`):**
> - Phase 6 stores cumulative `cash_received_amount`, `payment_note` (where TT/bank reference and receipt details can be recorded), and timestamped `PAYMENT_UPDATED` audit events.
> - Hard-deleting payment records is intentionally **removed** (immutable financial audit trail; corrections are recorded via `PUT /api/shipments-v2/:id/payment` with full audit history).
> - If Finance later requires itemized multi-installment TT receipts with dedicated `payment_date` + `bank_reference` columns per receipt, that can be introduced cleanly as an additive `0009` migration without changing Phase 9's architecture.

---

## 3. Financial Computation Rules (Single Source of Truth)

For every non-cancelled `phase6_shipments` row (joined to non-cancelled `delivery_instructions`):
- `final_invoice_count`: count of `shipment_invoices` where `version = 'FINAL'`
- `preliminary_invoice_count`: count of `shipment_invoices` where `version = 'PRELIMINARY'`
- `final_invoice_total`: `ROUND(COALESCE(SUM(line_amount) for FINAL invoices, 0), 2)`
- `preliminary_invoice_total`: `ROUND(COALESCE(SUM(line_amount) for PRELIMINARY invoices, 0), 2)`
- `currency`: currency of the latest `FINAL` invoice, falling back to latest `PRELIMINARY` invoice, falling back to `po_revisions.currency`
- `cash_received_amount`: `ROUND(phase6_shipments.cash_received_amount, 2)`
- `allocated_credit_amount`: `ROUND(COALESCE(SUM(customer_credit_usages.amount), 0), 2)`
- `payment_total`: `ROUND(cash_received_amount + allocated_credit_amount, 2)`
- `outstanding_balance`: `final_invoice_count > 0 ? ROUND(MAX(0, final_invoice_total - payment_total), 2) : 0`
- `payment_status`: authoritative `phase6_shipments.payment_status` (`UNPAID` | `PARTIAL` | `PAID`)
- `invoice_readiness`:
  - `'FINALIZED'` when `final_invoice_count > 0`
  - `'PRELIMINARY_ONLY'` when `final_invoice_count = 0 AND preliminary_invoice_count > 0`
  - `'NO_INVOICE'` when no invoice exists yet
- `last_payment_updated_at`: latest `shipment_audit_events.created_at` where `entity_type = 'SHIPMENT' AND event_type = 'PAYMENT_UPDATED'` (nullable)

**Multi-currency summary:**
- Never sum `USD`, `EUR`, and `THB` into a single blended total.
- `summary` returns:
  - Counts: `total_shipments`, `paid_count`, `partial_count`, `unpaid_count`, `final_invoiced_count`, `awaiting_final_invoice_count`
  - `totals_by_currency`: array of `{ currency, final_invoice_total, cash_received_total, allocated_credit_total, payment_total, outstanding_total }` (only for currencies present in the scoped result set)
  - `customer_credits_summary` (internal roles only): `{ total_credits, active_credits_count, total_remaining_amount }`

---

## 4. API Contract (`/api/payments`)

Keep Phase 6's `/api/shipments-v2/*` and `/api/customer-credits` endpoints **100% untouched**. Add a dedicated Phase 9 read module `src/payments/` mounted at `/api/payments`:

### Endpoints

1. **`GET /api/payments`**
   - Optional query params (strictly validated; invalid enum/date returns `400`):
     - `paymentStatus`: `UNPAID` | `PARTIAL` | `PAID` | `ALL`
     - `invoiceReadiness`: `FINALIZED` | `PRELIMINARY_ONLY` | `NO_INVOICE` | `ALL`
     - `shipmentStatus`: `PLANNING` | `BOOKED` | `LOADED` | `DOCS_SENT` | `COMPLETED` | `ALL`
     - `customerId`: filter by customer (ignored for `EXTERNAL_SALES` anti-inference unless it matches an owned customer — better: **ignored completely** for `EXTERNAL_SALES` just like Phase 7!)
     - `currency`: `USD` | `THB` | `EUR` | `ALL`
     - `search`: case-insensitive substring on `di_no`, `customer_name`, `customer_po_no`, `booking_no`, `invoice_nos` (for `EXTERNAL_SALES`, scoped strictly to owned rows and searched only against fields present in the External Sales projection)
   - Returns `{ status: 'SUCCESS', data: { summary, items, customerCredits } }`:
     - `items`: consolidated payment rows ordered by `CASE payment_status WHEN 'PARTIAL' THEN 1 WHEN 'UNPAID' THEN 2 ELSE 3 END`, `COALESCE(latest_final_invoice_date, etd, substr(created_at, 1, 10)) DESC`, `di_no DESC`
     - `summary`: KPI counts + `totals_by_currency` + `customer_credits_summary`
     - `customerCredits`: active & historical `customer_credits` enriched with `customer_name`, `used_amount`, and usage count (omitted / `[]` for `EXTERNAL_SALES`)

2. **`GET /api/payments/:shipmentId`**
   - Allowed for internal operational roles (`ADMIN`, `MANAGER`, `EXPORT`, `SALES_SUPPORT`); **`403` for `EXTERNAL_SALES` and `PRODUCTION_WAREHOUSE`** (External Sales gets its full approved projection directly in `GET /api/payments` without exposing internal `shipment_id`, `payment_note`, `customer_credits`, or `shipment_audit_events`).
   - Returns `{ status: 'SUCCESS', data: { shipment, invoices, creditUsages, availableCustomerCredits, paymentHistory } }`:
     - `shipment`: full financial summary row for the shipment
     - `invoices`: all `shipment_invoices` (PRELIMINARY & FINAL) with line totals
     - `creditUsages`: all `customer_credit_usages` applied to this shipment (joined to `customer_credits.reason` and `shipment_invoices.invoice_no`)
     - `availableCustomerCredits`: customer's credits with `remaining_amount > 0` (ready for immediate Apply Credit modal)
     - `paymentHistory`: `shipment_audit_events` for this shipment filtered to payment/invoice/credit/completion events (`PAYMENT_UPDATED`, `INVOICE_RECORDED`, `INVOICE_FINALIZED`, `CUSTOMER_CREDIT_USED`, `SHIPMENT_COMPLETED`)
   - Returns `404` if shipment does not exist or is `CANCELLED`.

### Reused Phase 6 Write Endpoints (Untouched)
- **Record / Update Cash Payment:** `PUT /api/shipments-v2/:shipmentId/payment` (`{ cashReceivedAmount, paymentNote }`)
- **Create Customer Credit:** `POST /api/customer-credits` (`{ customerId, amount, reason, requestKey }`)
- **Apply Customer Credit to Shipment:** `POST /api/shipments-v2/:shipmentId/credit-usage` (`{ creditId, amount, invoiceId, requestKey }`)

---

## 5. Strict RBAC Matrix & Anti-Inference Rules

Aligned directly with `navConfig` (`payments`), Phase 5F (`src/pos/routes.js`), Phase 6 (`src/shipping-di/routes.js`), and Phase 7 (`src/calendar/routes.js`):

| Role | `GET /api/payments` | `GET /api/payments/:shipmentId` | Phase 6 Payment & Credit Writes (`PUT /payment`, `POST /customer-credits`, `POST /credit-usage`) |
| :--- | :---: | :---: | :---: |
| `ADMIN` | Full (all shipments + credits) | Full detail + audit history | **Allow** |
| `MANAGER` | Full (all shipments + credits) | Full detail + audit history | **Allow** |
| `EXPORT` | Full (all shipments + credits) | Full detail + audit history | **Allow** |
| `SALES_SUPPORT` | Full (all shipments + credits, read-only) | Full detail + audit history (read-only) | **403 Denied** |
| `EXTERNAL_SALES` | **Owned-Customers ONLY**, projected allowlist, `customerCredits: []` | **403 Denied** | **403 Denied** |
| `PRODUCTION_WAREHOUSE` | **403 Denied** | **403 Denied** | **403 Denied** |
| Unauthenticated | **401 Unauthorized** | **401 Unauthorized** | **401 Unauthorized** |

### Exact `EXTERNAL_SALES` Server-Side Projection (`GET /api/payments`)
- Scoped strictly by `customers.owner_user_id = caller.user_id`.
- **Allowed item fields:**
  `di_no`, `customer_name`, `customer_po_no`, `currency`, `shipment_status`, `etd`, `actual_loading_date`, `invoice_readiness`, `final_invoice_nos`, `latest_final_invoice_date`, `final_invoice_total`, `payment_total`, `outstanding_balance`, `payment_status`, `commission_ready` (`shipment_status !== 'CANCELLED' && payment_status === 'PAID'`).
- **Explicitly omitted fields (must never leak):**
  `shipment_id`, `di_id`, `po_id`, `customer_id`, `payment_note`, `cash_received_amount`, `allocated_credit_amount`, `preliminary_invoice_total`, `booking_no`, `vessel`, `customerCredits`, `customer_credits_summary`, `paymentHistory`, `can_edit_payment`.
- **Anti-inference hardening:**
  `customerId` query parameter is ignored before querying for `EXTERNAL_SALES`; `search` only matches projected fields (`di_no`, `customer_name`, `customer_po_no`, `final_invoice_nos`) on already owner-scoped rows.

---

## 6. Frontend UX Design (`public/index.html`)

- **State & loaders:**
  - Add `state.paymentsDashboard = { summary: null, items: [], customerCredits: [], detail: null, loading: false, detailLoading: false, error: null, loaded: false, activeTab: 'SHIPMENTS', filters: { paymentStatus: 'ALL', invoiceReadiness: 'ALL', shipmentStatus: 'ALL', currency: 'ALL', customerId: 'ALL', search: '' } }`.
  - Add `loadPaymentsDashboardFromApi(options)` (`GET /api/payments`) and `loadPaymentDetailFromApi(shipmentId)` (`GET /api/payments/:shipmentId`).
  - Remove all reads/writes to mock `state.paymentRecords` in the Payment Status view (`renderPayments`, `openPaymentModal`, `savePaymentRecord`, `deletePaymentRecord`).
  - Reset `state.paymentsDashboard` on `signOut()`.
- **Main view (`renderPayments`):**
  - Header with role indicator (`OWN CUSTOMERS ONLY` badge for `EXTERNAL_SALES`, `VIEW ONLY` badge for `SALES_SUPPORT`), Refresh button, and `+ Add Customer Credit` button (rendered only for `ADMIN`, `MANAGER`, `EXPORT`).
  - **KPI Strip:**
    - Status cards: Total Shipments, Paid, Partial, Unpaid, Awaiting Final Invoice.
    - Currency-grouped Outstanding & Received strip (one clean card/pill per active currency `USD` / `EUR` / `THB` — never blending currencies).
  - **Tabs (internal roles):**
    1. **Shipment Payments** (default): Filter bar (Payment Status, Invoice Readiness, Currency, Customer, Search) + responsive table showing DI No., PO / Customer, Final Invoice No(s) & Date, Invoice Total, Cash + Credit Received (split shown to internal roles; single `Received` column for `EXTERNAL_SALES`), Outstanding Balance, Shipment Status, Payment Status badge, and Actions (`Details`, `Record Payment`, `Apply Credit`, `Open Shipment`).
    2. **Customer Credits** (internal roles only; hidden for `EXTERNAL_SALES`): Table of all D1 `customer_credits` (`credit_id`, `customer_name`, `amount`, `used_amount`, `remaining_amount`, `reason`, `created_at`) with `+ Add Customer Credit` modal (`POST /api/customer-credits` with generated `requestKey`).
- **Detail & Action Modals (internal roles):**
  - **Payment Detail Drawer/Modal (`openPaymentDetailModal(shipmentId)`):** Displays shipment invoices (`PRELIMINARY` / `FINAL`), cash received, allocated credit usages, payment note, and audit history (`PAYMENT_UPDATED`, `INVOICE_FINALIZED`, `CUSTOMER_CREDIT_USED`, `SHIPMENT_COMPLETED`) + quick action buttons (`Record Payment`, `Apply Credit`, `Open Shipment`).
  - **Record Cash Payment Modal (`openRecordPaymentModal(shipmentId)`):** Only for `ADMIN`, `MANAGER`, `EXPORT`; calls `PUT /api/shipments-v2/:shipmentId/payment` and reloads `loadPaymentsDashboardFromApi({ force: true })` (plus detail if open).
  - **Apply Customer Credit Modal (`openApplyCreditModal(shipmentId)`):** Only for `ADMIN`, `MANAGER`, `EXPORT`; lists customer's available credits (`remaining_amount > 0`), optional FINAL invoice selector, amount input (bounded by `min(credit.remaining_amount, shipment.outstanding_balance)`), auto-generates idempotent `requestKey`, calls `POST /api/shipments-v2/:shipmentId/credit-usage`, and reloads dashboard.
  - **Create Customer Credit Modal (`openCreateCustomerCreditModal()`):** Only for `ADMIN`, `MANAGER`, `EXPORT`; selects customer from D1 `state.customers`, enters amount & reason, auto-generates `requestKey`, calls `POST /api/customer-credits`, and reloads dashboard.

---

## 7. Explicitly Out of Scope

Phase 9 does **not** include:
- Commission calculation, approval, or settlement (`Commission` tab — deferred to Phase 10);
- Multi-installment bank receipt sub-ledger / bank reconciliation / FX conversion rates;
- Editing or creating Shipment Invoices directly inside Payment Status (invoice creation & finalization remain in Phase 6 **Shipping / DI** via the **Open Shipment** jump);
- Deleting or hard-reversing customer credits or historical payment audit records;
- Modifying Phase 6 `/api/shipments-v2/*` or `/api/customer-credits` routes, validation, or tests;
- Migrating `renderDashboard` legacy summary widgets that are outside the Payment Status module (those remain unchanged unless trivially wired).

---

## 8. Success Criteria

Phase 9 succeeds when:
1. Zero new D1 migrations are needed (`0001`–`0008` preserved) and all Phase 6 tables serve as the single source of truth.
2. `ADMIN`, `MANAGER`, and `EXPORT` can view consolidated shipment payment statuses, multi-currency totals, customer credit balances, and audit history — and can record cash payments, create customer credits, and apply credits to shipments via Phase 6's atomic endpoints with immediate UI refresh and `DOCS_SENT` → `COMPLETED` auto-promotion when fully paid.
3. `SALES_SUPPORT` has full read-only visibility (`403` on writes; write UI controls hidden).
4. `EXTERNAL_SALES` sees strictly owned-Customer payment statuses with the server-enforced allowlist (`customerCredits: []`, zero internal IDs/notes/credits/history leaked, `403` on detail & writes, anti-inference filters enforced).
5. `PRODUCTION_WAREHOUSE` receives `403` on all `/api/payments` endpoints; unauthenticated requests receive `401`.
6. Zero reads/writes to mock `state.paymentRecords` remain in the Payment Status view.
7. All existing 354 tests plus new Phase 9 validation, repository, route/RBAC, and frontend adapter tests pass with 0 failures.
