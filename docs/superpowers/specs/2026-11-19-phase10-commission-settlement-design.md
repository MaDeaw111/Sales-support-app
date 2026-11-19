# Phase 10 — Commission Settlement Design

**Date:** 2026-11-19  
**Baseline:** `main` @ `b73455f` (368 tests passing; migrations `0001`–`0008` applied in production)  
**Scope:** Bounded D1-backed **Commission Settlement** workflow linking Phase 5F PO Revision Line commission rates (`po_revision_lines.commission_recipient_user_id`, `commission_rate_usd_mt`) with Phase 6 actual shipped net weight (`shipment_container_lines.qty_mt`) and Phase 6/9 `PAID` shipment payment status — persisted via immutable settlement snapshots in a new additive D1 migration (`0009_commission_settlement.sql`) with strict RBAC.

---

## 1. Purpose and Governing Principle

Replace the frontend-only mock Commission view (`state.commissionPaidSnapshots`, `state.commissionRateChangeRequests`, `getCommissionRows`, `renderCommissions`, `markCommissionPaid` in `public/index.html`) with an authoritative D1-backed **Commission Settlement** module.

**Governing principle:** *Server-computed eligibility, immutable payout snapshots, strict recipient isolation.*
- Commission eligibility and USD payout amounts are **always computed server-side** from Phase 5F `po_revision_lines` (`commission_recipient_user_id`, `commission_rate_usd_mt`) and Phase 6 non-cancelled `shipment_container_lines.qty_mt` + `phase6_shipments.payment_status`.
- A commission becomes `PAYABLE` **only** when the shipment is non-cancelled, has `actual_shipped_mt > 0`, has at least one `FINAL` invoice, and has `phase6_shipments.payment_status = 'PAID'`.
- When `ADMIN` or `MANAGER` settles a `PAYABLE` commission, the server atomically persists an **immutable snapshot** in `commission_settlements` (`actual_mt_snapshot`, `rate_snapshot_usd_mt`, `amount_usd_snapshot`, `line_breakdown_json`, `paid_date`, `payment_reference`, `note`) with database-level double-payout protection (`UNIQUE(shipment_id, recipient_user_id)`) and idempotency (`request_key`).
- Commission rate changes remain governed by Phase 5F **PO Revisions** (single source of truth; no parallel rate-change request table).

---

## 2. Database Schema & Additive D1 Migration (`migrations/0009_commission_settlement.sql`)

An additive migration `0009_commission_settlement.sql` is required to persist immutable payout snapshots and settlement audit history without altering `0001`–`0008`:

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commission_settlements (
  settlement_id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES phase6_shipments(shipment_id),
  di_id TEXT NOT NULL REFERENCES delivery_instructions(di_id),
  po_id TEXT NOT NULL REFERENCES po_headers(po_id),
  po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id),
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id),
  actual_mt_snapshot REAL NOT NULL CHECK(actual_mt_snapshot > 0),
  rate_snapshot_usd_mt REAL NOT NULL CHECK(rate_snapshot_usd_mt > 0),
  amount_usd_snapshot REAL NOT NULL CHECK(amount_usd_snapshot > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
  line_breakdown_json TEXT NOT NULL CHECK(trim(line_breakdown_json) <> ''),
  status TEXT NOT NULL DEFAULT 'PAID' CHECK(status IN ('PAID')),
  paid_date TEXT NOT NULL,
  payment_reference TEXT,
  note TEXT,
  request_key TEXT NOT NULL UNIQUE CHECK(trim(request_key) <> ''),
  settled_by TEXT NOT NULL REFERENCES users(user_id),
  settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shipment_id, recipient_user_id)
);

CREATE TABLE IF NOT EXISTS commission_audit_events (
  event_id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES commission_settlements(settlement_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('COMMISSION_SETTLED', 'COMMISSION_NOTE_UPDATED')),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commission_settlements_recipient_status
  ON commission_settlements(recipient_user_id, status, paid_date DESC);

CREATE INDEX IF NOT EXISTS idx_commission_settlements_shipment
  ON commission_settlements(shipment_id);

CREATE INDEX IF NOT EXISTS idx_commission_audit_events_settlement
  ON commission_audit_events(settlement_id, created_at DESC);
```

- **Additive only:** No existing table in `0001`–`0008` is altered, dropped, or renamed.
- **No hard deletes:** Settled payouts are permanent financial records (`UNIQUE(shipment_id, recipient_user_id)` prevents duplicate payouts; `request_key` guarantees retry idempotency).

---

## 3. Commission Calculation & Payout Lifecycle

### Line-Accurate Calculation (Aggregated per `shipment_id` + `recipient_user_id`)
For every non-cancelled `phase6_shipments` row (joined to non-cancelled `delivery_instructions`):
1. Join `delivery_instruction_lines` → `po_revision_lines` where `prl.commission_recipient_user_id IS NOT NULL AND prl.commission_rate_usd_mt > 0`.
2. For each eligible `delivery_instruction_lines` row, compute actual loaded weight:
   - `actual_mt_line = SUM(scl.qty_mt)` across `shipment_container_lines` belonging to non-cancelled `shipment_containers` (`sc.status <> 'CANCELLED'`) for that shipment and `di_line_id`.
   - `line_amount_usd = ROUND(actual_mt_line * prl.commission_rate_usd_mt, 2)`
3. Group eligible lines by `(shipment_id, recipient_user_id)`:
   - If a `commission_settlements` row exists for `(shipment_id, recipient_user_id)`:
     - **`status = 'PAID'`**
     - Authoritative `actual_shipped_mt`, `rate_usd_mt`, `commission_amount_usd`, and `line_breakdown` come directly from the frozen settlement snapshot (`actual_mt_snapshot`, `rate_snapshot_usd_mt`, `amount_usd_snapshot`, `line_breakdown_json`).
   - Otherwise (not yet settled):
     - `actual_shipped_mt = ROUND(SUM(actual_mt_line), 3)`
     - `commission_amount_usd = ROUND(SUM(actual_mt_line * prl.commission_rate_usd_mt), 2)`
     - `rate_usd_mt = actual_shipped_mt > 0 ? ROUND(commission_amount_usd / actual_shipped_mt, 4) : ROUND(weighted planned rate, 4)` (exact line rate whenever all lines share one rate; exact per-line breakdown always returned in `line_breakdown`)
     - **`status = 'PAYABLE'`** when `actual_shipped_mt > 0 AND commission_amount_usd > 0 AND final_invoice_count > 0 AND phase6_shipments.payment_status = 'PAID'`
     - **`status = 'PENDING'`** otherwise (e.g., cargo not yet loaded, final invoice not finalized, or customer payment is still `UNPAID`/`PARTIAL`).

### Payout Status Lifecycle
```text
PENDING  ──(actual_mt > 0 + FINAL invoice + shipment payment_status = PAID)──▶  PAYABLE
PAYABLE  ──(ADMIN/MANAGER settles via POST /api/commissions/settle)──────────▶  PAID (immutable snapshot)
```
- **No reversion / hard delete:** Once `PAID`, `actual_mt_snapshot`, `rate_snapshot_usd_mt`, and `amount_usd_snapshot` are immutable. `ADMIN`/`MANAGER` may only update `payment_reference` and `note` via `PATCH /api/commissions/:settlementId` (fully audited via `COMMISSION_NOTE_UPDATED`).

---

## 4. API Contract (`/api/commissions`)

Add a dedicated module `src/commissions/` (`validation.js`, `repository.js`, `routes.js`) mounted at `/api/commissions` in `src/index.js`:

### Endpoints

1. **`GET /api/commissions`**
   - Optional query params (strictly validated; invalid enums/dates return `400`):
     - `status`: `PENDING` | `PAYABLE` | `PAID` | `ALL`
     - `recipientUserId`: filter by external salesperson (ignored for `EXTERNAL_SALES` anti-inference)
     - `customerId`: filter by customer (ignored for `EXTERNAL_SALES` anti-inference)
     - `paidDateFrom`, `paidDateTo`: strict ISO `YYYY-MM-DD` range filtering `paid_date` (`paidDateFrom <= paidDateTo`)
     - `search`: case-insensitive substring on projected fields (`di_no`, `customer_name`, `customer_po_no`, `final_invoice_nos`, `settlement_id`, `payment_reference`; plus `recipient_name` for internal roles)
   - Returns `{ status: 'SUCCESS', data: { summary, items, recipients } }`:
     - `summary`: `{ total_count, pending_count, payable_count, paid_count, pending_usd, payable_usd, paid_usd, total_usd }`
     - `items`: ordered by `CASE status WHEN 'PAYABLE' THEN 1 WHEN 'PENDING' THEN 2 ELSE 3 END`, `COALESCE(paid_date, actual_loading_date, etd, substr(created_at, 1, 10)) DESC`, `di_no DESC`
     - `recipients`: list of `{ user_id, full_name, pending_usd, payable_usd, paid_usd, payable_count }` for `ADMIN`/`MANAGER` filter & recipient breakdown (`[]` for `EXTERNAL_SALES`)

2. **`GET /api/commissions/:settlementId`**
   - Returns `{ status: 'SUCCESS', data: { settlement, auditHistory } }` for a persisted `PAID` settlement (`line_breakdown` parsed, plus `commission_audit_events`).
   - For `EXTERNAL_SALES`: enforces `settlement.recipient_user_id === caller.user_id` (returns `404` if not owned or not found, preventing cross-recipient enumeration), and omits internal IDs/audit actor IDs.

3. **`POST /api/commissions/settle`** (`ADMIN` and `MANAGER` only)
   - Strict payload allowlist (unknown properties rejected with `400`):
     - `shipmentId` (required string)
     - `recipientUserId` (required string)
     - `paidDate` (required strict ISO `YYYY-MM-DD`)
     - `paymentReference` (optional trimmed string, e.g. bank/TT reference)
     - `note` (optional trimmed string)
     - `requestKey` (required non-empty string for idempotency)
   - Server-side checks:
     - Idempotency: if `requestKey` already exists with matching `(shipmentId, recipientUserId, paidDate)`, returns existing settlement (`200`); if mismatched payload, rejects with `409` (`COMMISSION_REQUEST_KEY_CONFLICT`).
     - Rejects if `(shipmentId, recipientUserId)` already settled (`409`, `COMMISSION_ALREADY_SETTLED`).
     - Re-computes eligibility live from D1; rejects with `400` (`COMMISSION_NOT_PAYABLE`) if shipment is missing/cancelled, `actual_shipped_mt <= 0`, no FINAL invoice, `payment_status !== 'PAID'`, or no eligible commission lines for `recipientUserId`.
     - Atomically inserts `commission_settlements` (`CS-XXXX` sequential ID or UUID — let's use sequential `CS-0001`, `CS-0002`, ...) + `COMMISSION_SETTLED` audit event in a single `db.batch(...)`.
   - Returns `{ status: 'SUCCESS', data: { settlement } }`.

4. **`PATCH /api/commissions/:settlementId`** (`ADMIN` and `MANAGER` only)
   - Strict payload allowlist: `paymentReference`, `note` (at least one required; rejects attempts to change `amount`, `rate`, `actualMt`, `paidDate`, `recipientUserId`, `status` with `400`).
   - Updates metadata and writes `COMMISSION_NOTE_UPDATED` audit event atomically.
   - Returns `404` if settlement does not exist.

---

## 5. Strict RBAC Matrix & Recipient Isolation

Aligned directly with `navConfig` (`commissions: ['ADMIN', 'MANAGER', 'EXTERNAL_SALES']`):

| Role | `GET /api/commissions` | `GET /api/commissions/:settlementId` | `POST /api/commissions/settle` & `PATCH /:settlementId` |
| :--- | :---: | :---: | :---: |
| `ADMIN` | Full (all recipients + recipient summary) | Full detail + audit history | **Allow** |
| `MANAGER` | Full (all recipients + recipient summary) | Full detail + audit history | **Allow** |
| `EXTERNAL_SALES` | **Own commissions ONLY** (`recipient_user_id = caller.user_id`), projected allowlist, `recipients: []` | **Own settlements ONLY** (projected; `404` otherwise) | **403 Denied** |
| `SALES_SUPPORT` | **403 Denied** | **403 Denied** | **403 Denied** |
| `EXPORT` | **403 Denied** | **403 Denied** | **403 Denied** |
| `PRODUCTION_WAREHOUSE` | **403 Denied** | **403 Denied** | **403 Denied** |
| Unauthenticated | **401 Unauthorized** | **401 Unauthorized** | **401 Unauthorized** |

### Exact `EXTERNAL_SALES` Server-Side Projection (`GET /api/commissions`)
- Scoped strictly by `recipient_user_id = caller.user_id`.
- **Allowed item fields:**
  `settlement_id` (null until `PAID`), `di_no`, `customer_name`, `customer_po_no`, `final_invoice_nos`, `actual_shipped_mt`, `planned_qty_mt`, `rate_usd_mt`, `commission_amount_usd`, `currency`, `payment_status`, `shipment_status`, `status` (`PENDING` | `PAYABLE` | `PAID`), `paid_date`, `payment_reference`, `note`, `line_breakdown` (sanitized: `product_code`, `product_name`, `actual_mt`, `rate_usd_mt`, `amount_usd`).
- **Explicitly omitted fields:**
  `shipment_id`, `di_id`, `po_id`, `po_revision_id`, `customer_id`, `recipient_user_id`, `settled_by`, `can_settle`.
- **Anti-inference hardening:**
  `recipientUserId` and `customerId` query params are ignored before querying for `EXTERNAL_SALES`; `search` only matches projected fields on already recipient-scoped rows.

---

## 6. Frontend UX Design (`public/index.html`)

- **State & loaders:**
  - Add `state.commissionsDashboard = { summary: null, items: [], recipients: [], detail: null, loading: false, error: null, loaded: false, filters: { status: 'ALL', recipientUserId: 'ALL', customerId: 'ALL', paidDateFrom: '', paidDateTo: '', search: '' } }`.
  - Add `loadCommissionsDashboardFromApi(options)` (`GET /api/commissions`), `loadCommissionDetailFromApi(settlementId)` (`GET /api/commissions/:settlementId`), `submitCommissionSettlementToApi(shipmentId, recipientUserId)` (`POST /api/commissions/settle`), and `updateCommissionNoteToApi(settlementId)` (`PATCH /api/commissions/:settlementId`).
  - Remove all reads/writes to mock `state.commissionPaidSnapshots` and `state.commissionRateChangeRequests` in the Commission view (`renderCommissions`, `markCommissionPaid`, `requestCommissionRateChange`, `reviewCommissionRateChange`).
  - Reset `state.commissionsDashboard` on `signOut()`.
- **Main view (`renderCommissions`):**
  - Header with `MY COMMISSIONS ONLY` badge for `EXTERNAL_SALES`, Refresh button, and concise subtitle explaining server-verified `Actual Shipped MT × Approved PO Line Rate` eligibility (`PAYABLE` only after Shipment Payment is `PAID`).
  - **KPI Strip:** Pending USD (count), Payable USD (count), Paid USD (count), and Total Commission USD.
  - **Recipient Summary Strip** (`ADMIN` / `MANAGER` only; hidden for `EXTERNAL_SALES`): per-salesperson Payable / Paid cards allowing one-click filter by recipient.
  - **Filter Bar:** Status (`ALL`, `PAYABLE`, `PENDING`, `PAID`), Salesperson (`ADMIN`/`MANAGER` only), Paid Date range, Search, Reset.
  - **Commissions Table:** Salesperson (internal roles), Customer / PO, DI / Final Invoice, Actual Shipped MT (with planned MT hint if not yet loaded), Rate (`$/MT`), Customer Payment badge, Commission USD, Status badge (`PENDING` / `PAYABLE` / `PAID`), Paid Date / Reference, and Actions:
    - `PAYABLE` row (`ADMIN`/`MANAGER` only): **Settle / Mark Paid** button opening a clean modal (`paidDate` defaulting to today, `paymentReference`, `note`, exact server-computed preview, auto-generated `requestKey`) — replacing the legacy `prompt()`!
    - `PAID` row: **Receipt / Details** button opening Settlement Detail modal (frozen line breakdown, paid date, payment reference, note, and audit trail for internal roles; `ADMIN`/`MANAGER` can edit `paymentReference`/`note`).
    - Internal roles only: **Open Shipment** jump (`openPhase6ShipmentFromCalendar(r.di_id)`).

---

## 7. Explicitly Out of Scope

Phase 10 does **not** include:
- Parallel commission rate change request workflow (`commissionRateChangeRequests` — rate changes belong in Phase 5F PO Revisions so PO contract terms remain the single source of truth);
- Multi-currency commission payouts (Phase 5F defines `commission_rate_usd_mt` strictly in `USD`);
- Batch payout grouping / accounting ERP export / tax withholding calculations;
- Reversing or hard-deleting settled commissions;
- Modifying Phase 5F PO routes, Phase 6 Shipping/DI routes, or Phase 9 Payment routes.

---

## 8. Success Criteria

Phase 10 succeeds when:
1. `migrations/0009_commission_settlement.sql` applies cleanly on top of `0001`–`0008` with zero changes to existing tables.
2. Commission rows accurately calculate `SUM(actual_mt * po_revision_lines.commission_rate_usd_mt)` per `(shipment_id, recipient_user_id)` and transition `PENDING → PAYABLE` strictly when `actual_shipped_mt > 0`, a `FINAL` invoice exists, and `phase6_shipments.payment_status = 'PAID'`.
3. `ADMIN` and `MANAGER` can settle `PAYABLE` commissions into immutable `PAID` snapshots with double-payout prevention (`UNIQUE(shipment_id, recipient_user_id)`), retry idempotency (`request_key`), and audit logging (`COMMISSION_SETTLED`, `COMMISSION_NOTE_UPDATED`).
4. `EXTERNAL_SALES` sees strictly their own commissions (`recipient_user_id = caller.user_id`) with projected allowlist and anti-inference guards, and receives `403` on settle/patch mutations.
5. `SALES_SUPPORT`, `EXPORT`, and `PRODUCTION_WAREHOUSE` receive `403` on all `/api/commissions` endpoints; unauthenticated requests receive `401`.
6. Zero reads/writes to mock `state.commissionPaidSnapshots` or `state.commissionRateChangeRequests` remain in the Commission view.
7. All existing 368 tests plus new Phase 10 migration, repository, route/RBAC, and frontend adapter tests pass cleanly.
