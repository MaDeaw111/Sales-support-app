# Phase 10 — Commission Settlement Implementation Plan

**Goal:** Migrate the Commission Settlement module from frontend prototype arrays to Cloudflare D1 by linking Phase 5F `po_revision_lines` commission rates with Phase 6 actual shipped MT (`shipment_container_lines.qty_mt`) and `PAID` payment status, backed by immutable payout snapshots (`commission_settlements`) and strict RBAC.

**Architecture:** Add `migrations/0009_commission_settlement.sql` (`commission_settlements` + `commission_audit_events` + indexes) and a focused `src/commissions/` module (`validation.js`, `repository.js`, `routes.js`) wired to `/api/commissions` in `src/index.js`. Replace mock Commission UI in `public/index.html` with D1-backed loaders, KPI cards, recipient summary strip, filterable table, Settle Payout modal, and Settlement Detail / Receipt modal.

**Tech Stack:** JavaScript ES modules; Cloudflare Workers; Cloudflare D1 (`migrations/0001`–`0009`); HTML + inline JS in `public/index.html`; Node built-in test runner (`node --test`) + `node:sqlite` test database; Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-11-19-phase10-commission-settlement-design.md`

---

## Baseline & Constraints

- Baseline: `main` @ `b73455f` (`npm test`: 368 passed, 0 failed).
- Additive migration only: `migrations/0009_commission_settlement.sql` creates `commission_settlements`, `commission_audit_events`, and indexes without altering `0001`–`0008`.
- Do not modify Phase 5F PO routes, Phase 6 Shipping/DI routes, or Phase 9 Payment routes.
- All payout eligibility and USD amounts are computed strictly server-side from D1; settled snapshots are immutable (no hard deletes).
- All implementation occurs on `feature/phase10-commission-settlement` via strict TDD (red → green → full test suite), then merge → remote D1 migration (`0009_commission_settlement.sql`) → production verification → `docs/PROJECT_STATUS.md` update.

---

## Planned File Structure

```text
migrations/0009_commission_settlement.sql          additive commission_settlements & commission_audit_events tables + indexes
src/commissions/validation.js                      query param, settle payload, and note update payload validation
src/commissions/repository.js                      D1 commission calculation, settlement snapshot persistence, idempotency, and audit trail
src/commissions/routes.js                          /api/commissions REST handlers + strict RBAC & EXTERNAL_SALES recipient isolation
src/index.js                                       dispatch /api/commissions and /api/commissions/* to createCommissionsHandlerFromEnv
public/index.html                                  D1-backed Commission Settlement dashboard, Settle modal, and Settlement Detail modal
test/commissions.migration.test.js                 0009 migration constraint tests (FKs, UNIQUE(shipment_id, recipient_user_id), request_key UNIQUE, positive amount/MT/rate)
test/commissions.repository.test.js                line-level MT × rate math, PENDING/PAYABLE/PAID lifecycle, snapshot immutability, double-payout & idempotency guards
test/commissions.routes.test.js                    validation, auth (401), strict RBAC across all 6 roles (403/200), EXTERNAL_SALES isolation & anti-inference, and Worker 503 check
test/frontend-adapter.test.js                      regression tests verifying /api/commissions usage, role-aware UI, and zero mock commissionPaidSnapshots reads
```

---

## Task Breakdown

### Task 1 — Additive D1 Migration (`migrations/0009_commission_settlement.sql`)
- [ ] Write failing migration tests in `test/commissions.migration.test.js` covering:
  - Applying `0001`–`0009` in order succeeds cleanly and preserves existing tables/rows.
  - `commission_settlements` enforces FKs (`shipment_id`, `di_id`, `po_id`, `po_revision_id`, `customer_id`, `recipient_user_id`, `settled_by`), `actual_mt_snapshot > 0`, `rate_snapshot_usd_mt > 0`, `amount_usd_snapshot > 0`, `currency = 'USD'`, `status = 'PAID'`, `UNIQUE(shipment_id, recipient_user_id)`, and `UNIQUE(request_key)`.
  - `commission_audit_events` enforces FK to `commission_settlements` and `event_type IN ('COMMISSION_SETTLED', 'COMMISSION_NOTE_UPDATED')`.
- [ ] Create `migrations/0009_commission_settlement.sql`.
- [ ] Confirm migration tests pass (GREEN).

### Task 2 — Validation Helpers (`src/commissions/validation.js`)
- [ ] Write failing validation unit tests in `test/commissions.routes.test.js` covering:
  - `parseCommissionsQuery`: normalizes `status`, `recipientUserId`, `customerId`, `paidDateFrom`/`paidDateTo`, `search`; rejects invalid status, invalid ISO dates, or inverted date ranges.
  - `validateSettlePayload`: strict allowlist (`shipmentId`, `recipientUserId`, `paidDate`, `paymentReference`, `note`, `requestKey`); rejects unknown properties, missing IDs/requestKey, or invalid `paidDate`.
  - `validateSettlementNoteUpdate`: strict allowlist (`paymentReference`, `note`); rejects empty payload or immutable field modification (`amountUsd`, `paidDate`, `status`, etc.).
- [ ] Implement `src/commissions/validation.js`.
- [ ] Confirm validation tests pass (GREEN).

### Task 3 — D1 Repository (`src/commissions/repository.js`)
- [ ] Write failing repository tests in `test/commissions.repository.test.js` on a migrated D1 fixture (`0001`–`0009`) covering:
  - Multi-line PO commission calculation (`SUM(actual_mt * rate_usd_mt)`), excluding `CANCELLED` shipments/DIs/containers and zero-rate lines.
  - Lifecycle transitions: `PENDING` (unloaded or unpaid/partial) → `PAYABLE` (loaded + FINAL invoice + `payment_status = 'PAID'`) → `PAID` (settled via `settleCommission`).
  - `settleCommission`: generates `CS-XXXX` ID, persists immutable snapshot (`line_breakdown_json`), writes `COMMISSION_SETTLED` audit event, rejects non-`PAYABLE` shipments (`COMMISSION_NOT_PAYABLE`), rejects duplicate payout (`COMMISSION_ALREADY_SETTLED`), and handles `requestKey` idempotency (returns existing on replay; throws `COMMISSION_REQUEST_KEY_CONFLICT` on mismatched replay).
  - Snapshot immutability: subsequent PO revision / line changes do not alter already-settled `PAID` snapshot amounts.
  - `updateSettlementMetadata`: updates `payment_reference` / `note` and logs `COMMISSION_NOTE_UPDATED`.
  - Recipient scoping (`recipientUserId` + `restrictedSearch`) and summary KPI totals.
- [ ] Implement `createCommissionsRepository(db)` in `src/commissions/repository.js`.
- [ ] Confirm repository tests pass (GREEN).

### Task 4 — API Routes, Strict RBAC & Recipient Isolation (`src/commissions/routes.js` & `src/index.js`)
- [ ] Write failing route & RBAC tests in `test/commissions.routes.test.js` covering:
  - Worker dispatch returns `503` without `DB` binding.
  - `401` for unauthenticated requests on all `/api/commissions` endpoints.
  - `403` for `SALES_SUPPORT`, `EXPORT`, and `PRODUCTION_WAREHOUSE` on ALL endpoints.
  - `EXTERNAL_SALES`:
    - `200` on `GET /api/commissions` returning strictly own rows (`recipient_user_id = caller.user_id`), exact projected allowlist, `recipients: []`, and anti-inference (`recipientUserId`/`customerId` params ignored).
    - `200` on `GET /api/commissions/:settlementId` for own settlement (projected); `404` for another recipient's settlement.
    - `403` on `POST /api/commissions/settle` and `PATCH /api/commissions/:settlementId`.
  - `ADMIN` and `MANAGER`: full read, settle (`200`, `400`, `409`), detail (`200`, `404`), and metadata patch (`200`, `400`, `404`) lifecycle.
- [ ] Implement `src/commissions/routes.js` and wire `/api/commissions` in `src/index.js`.
- [ ] Confirm all backend tests pass (GREEN).

### Task 5 — Frontend Commission Settlement UI (`public/index.html`)
- [ ] Write failing frontend adapter tests in `test/frontend-adapter.test.js` asserting:
  - `loadCommissionsDashboardFromApi()` fetches `/api/commissions` (omitting `recipientUserId`/`customerId` for `EXTERNAL_SALES`) and updates `state.commissionsDashboard`.
  - `submitCommissionSettlementToApi()` calls `POST /api/commissions/settle` with `requestKey` and reloads dashboard.
  - `updateCommissionNoteToApi()` calls `PATCH /api/commissions/:settlementId` and reloads dashboard.
  - `renderCommissions` never reads mock `state.commissionPaidSnapshots` or `state.commissionRateChangeRequests`.
  - Role-aware UI: hides Settle controls & recipient breakdown for `EXTERNAL_SALES`; shows them for `ADMIN` and `MANAGER`.
- [ ] Implement the D1-backed Commission Settlement view, Settle Payout modal, and Settlement Detail / Receipt modal in `public/index.html`.
- [ ] Verify inline `<script>` syntax and frontend adapter tests pass (GREEN).

### Task 6 — Full Verification, Remote Migration & Final Release
- [ ] Run full test suite (`npm test`) and confirm 0 failures and zero regressions across all Phase 5E/5F/6/7/8/9 suites.
- [ ] Self-review SQL constraints, idempotency, RBAC recipient isolation, and HTML escaping.
- [ ] Merge `feature/phase10-commission-settlement` into `main`, apply remote D1 migration (`migrations/0009_commission_settlement.sql`) to `wcat-sales-db`, verify tables & production deployment, and update `docs/PROJECT_STATUS.md`.
