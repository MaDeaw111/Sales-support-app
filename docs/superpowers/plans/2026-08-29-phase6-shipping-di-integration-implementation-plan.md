# Phase 6 — Shipping / DI Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved simple Export workflow from exact Phase 5F PO Revision Lines through DI, Booking/Shipment, Containers, Invoice, All Ship Docs, Customer Credit, Payment, and automatic completion.

**Architecture:** Add an additive rich Phase 6 model in Cloudflare D1 under a dedicated `shipping-di` module and the `/api/delivery-instructions` and `/api/shipments-v2` route namespaces. It links each DI line to immutable Phase 5F PO Header, Revision, and Revision Line IDs while retaining the Phase 5E `shipments` anchor table, its child tables, routes, and frontend adapters unchanged.

**Tech Stack:** JavaScript ES modules; Cloudflare Workers; Cloudflare D1; HTML with inline JavaScript in `public/index.html`; Node built-in test runner; Node `node:sqlite` test database; Wrangler 4.

**Spec:** `docs/superpowers/specs/2026-08-29-phase6-shipping-di-integration-design.md`

## Baseline and legacy compatibility decision

Planning baseline recorded on 2026-08-29:

```text
npm test: 170 passed, 0 failed, 0 skipped
```

Phase 5E's legacy `shipments` table is an execution-cost anchor, not the Phase 6 source of truth:

```text
shipments(shipment_id, po_id -> pos.po_id, freight_quote_id,
          is_one_container, status)
shipment_document_links(shipment_id -> shipments)
shipment_expenses(shipment_id -> shipments)
```

`src/shipments/repository.js` and `src/shipments/routes.js` provide `/api/shipments/:id`, `/ensure`, `/documents`, and `/expenses`; `public/index.html` calls them through the existing shipment adapter functions. Existing legacy data and these read paths remain available unchanged. Phase 6 adds `phase6_shipments`, never renames, drops, or overloads legacy `shipments`; new records use `/api/shipments-v2`. No backfill creates PO Revision Line links unless a future separately approved migration can prove the exact mapping from source data.

## Global constraints

- Simple operational truth first; do not add ERP, accounting, carrier-tracking, or logistics subsystems.
- One DI equals one Booking equals one rich Shipment. Normally a DI has one PO Revision Line; a combined/trial DI may have multiple exact PO Revision Lines.
- Every DI line stores `po_id`, `po_revision_id`, and `po_revision_line_id`. Legacy Phase 5E `pos` is never an authoritative source for Phase 6 records.
- `EXPORT` jointly manages the workflow; no Export Owner field exists.
- `shipping_period` is `FIRST_HALF` (days 1–15) or `SECOND_HALF` (day 16–end). Compare Actual Loading Date to this period for `ON_PLAN` or `OUT_OF_PLAN`; never use ETD.
- DI statuses are `DRAFT`, `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, and `CANCELLED`. Shipment statuses are `PLANNING`, `BOOKED`, `LOADED`, `DOCS_SENT`, `COMPLETED`, and `CANCELLED`. Do not introduce departed, transit, or arrival statuses.
- Available Qty is Max Allowed Qty minus actual Shipment quantity minus active planned DI quantity not already represented by actual quantity. A cancelled DI releases planned quantity; actual quantity never exceeds the exact PO Line Max Allowed Qty.
- Service Partner types are `FORWARDER`, `SHIPPING_LINE`, `TRUCKING`, and `SURVEYOR`. Customer-history suggestions are optional and changeable.
- Containers store only Container No., Seal No., and lines of PO Line/Product, bag count, and Net Weight. Do not store Gross Weight, VGM, Tare Weight, or pallet weight.
- Invoice numbers are manually entered. A Shipment may have many Invoices and an Invoice may have many lines. Invoice lines snapshot the referenced PO Line Unit Price. `PRELIMINARY` uses permitted Max Qty for tolerance shipments; `FINAL` uses actual Qty and cannot exceed the PO Line Max Allowed Qty. Fixed-weight shipments may go directly to `FINAL`.
- One Shipment stores one All Ship Docs Google Drive folder link. Digital docs are required; DHL date and tracking are additionally required only when `original_docs_required` is true. No Drive API, document-file engine, automatic email, or DHL API.
- Payment is manual at Shipment level: `UNPAID`, `PARTIAL`, or `PAID`. Customer Credit is Customer-bound, cannot overdraw its balance, and each creation/use is audited. No bank reconciliation, payment ledger, accounting integration, credit-note module, PDF invoice generation, or automatic invoice numbers.
- `DOCS_SENT` plus `PAID` automatically completes the Shipment and its DI. DI has event audit only, never a PO-style revision model.
- Server-side read projections protect commercial and internal data. Existing Phase 5F PO and Phase 5E shipment routes remain regression-protected.
- All Phase 6 implementation work occurs later in an isolated feature branch/worktree, uses local D1 only, raises a PR, and stops before merge, remote migration, or deployment.

## Planned file structure

```text
migrations/0007_shipping_di_integration.sql             additive Phase 6 D1 schema
src/shipping-di/validation.js                           payload, transition, qty, schedule helpers
src/shipping-di/repository.js                           D1 persistence and transactional business actions
src/shipping-di/routes.js                               focused Phase 6 API and RBAC projections
src/index.js                                            route dispatch for new namespaces only
public/index.html                                       compact D1-backed DI / Shipment UI and adapters
test/phase6-migration.test.js                           migration constraints and legacy preservation
test/service-partners.repository.test.js                master-data persistence
test/service-partners.routes.test.js                    master-data RBAC/API
test/delivery-instructions.repository.test.js           DI linkage, numbering, qty, lifecycle
test/delivery-instructions.routes.test.js               DI API/RBAC/search/filter
test/phase6-shipments.repository.test.js                booking, schedule, containers, invoices, docs, payment
test/phase6-shipments.routes.test.js                    focused business endpoint/RBAC tests
test/phase6-rbac.test.js                                projection and customer-scope security tests
test/frontend-shipping-di-adapter.test.js               frontend request adapters and state updates
test/frontend-inline-script-syntax.test.js              retained parser regression
```

## Task 1: Phase 6 D1 schema and legacy compatibility

**Files:**
- Create: `migrations/0007_shipping_di_integration.sql`
- Create: `test/phase6-migration.test.js`
- Modify: no existing migration or legacy table.

**Interfaces:**
- Consumes: `customers.customer_id`, `users.user_id`, `po_headers.po_id`, `po_revisions.revision_id`, `po_revision_lines.line_id`, and `products.product_id` created by migrations 0001–0006.
- Produces: Phase 6 tables consumed by `createShippingDiRepository(dbBinding)`; preserves `shipments`, `shipment_document_links`, and `shipment_expenses` unchanged.

- [ ] **Step 1: Write failing migration tests.**

```js
test('Phase 6 migration is additive and retains Phase 5E shipment anchors', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipments'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'phase6_shipments'").get());
  assert.throws(() => db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI1','C1','PO1','D1','2026-09','INVALID','DRAFT','U1')").run(), /constraint failed/);
});
```

- [ ] **Step 2: Run the migration test and verify the missing migration fails.**

Run: `node --test test/phase6-migration.test.js`

Expected: failure because migration 0007 and its tables do not exist.

- [ ] **Step 3: Add the forward-only schema.** Create tables `service_partners`, `delivery_instructions`, `delivery_instruction_lines`, `phase6_shipments`, `shipment_containers`, `shipment_container_lines`, `shipment_invoices`, `shipment_invoice_lines`, `customer_credits`, `customer_credit_usages`, and `shipment_audit_events`. Use text UUID-style IDs, `created_by`, `created_at`, `updated_by`, and `updated_at` where appropriate; retain only the approved fields. Define checks for all Phase 6 status/type enums and indexes for DI number, Customer/status, PO line balance lookup, shipment status, Booking No., Invoice No., Container No., and audit history.

```sql
CREATE TABLE phase6_shipments (
  shipment_id TEXT PRIMARY KEY,
  di_id TEXT NOT NULL UNIQUE REFERENCES delivery_instructions(di_id),
  status TEXT NOT NULL CHECK(status IN ('PLANNING','BOOKED','LOADED','DOCS_SENT','COMPLETED','CANCELLED')) DEFAULT 'PLANNING',
  booking_no TEXT, forwarder_partner_id TEXT REFERENCES service_partners(partner_id),
  shipping_line_partner_id TEXT REFERENCES service_partners(partner_id), trucking_partner_id TEXT REFERENCES service_partners(partner_id),
  vessel TEXT, etd TEXT, eta TEXT, planned_loading_date TEXT, actual_loading_date TEXT,
  schedule_result TEXT CHECK(schedule_result IN ('ON_PLAN','OUT_OF_PLAN')),
  schedule_note TEXT, all_ship_docs_drive_url TEXT,
  digital_docs_sent_date TEXT, original_docs_required INTEGER NOT NULL DEFAULT 0 CHECK(original_docs_required IN (0,1)),
  dhl_sent_date TEXT, dhl_tracking_no TEXT, docs_note TEXT,
  cash_received_amount REAL NOT NULL DEFAULT 0 CHECK(cash_received_amount >= 0),
  payment_status TEXT NOT NULL CHECK(payment_status IN ('UNPAID','PARTIAL','PAID')) DEFAULT 'UNPAID',
  payment_note TEXT, cancellation_note TEXT, created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

`delivery_instruction_lines` stores all three exact PO identifiers plus `planned_qty_mt` and `packing_snapshot`; repository validation verifies that the line belongs to the recorded revision and PO. `shipment_invoice_lines` holds `po_revision_line_id`, `qty_mt`, `unit_price_snapshot`, `currency`, and calculated `line_amount`. `customer_credit_usages` has a required `shipment_id`, optional `invoice_id`, `credit_id`, `amount`, actor, and timestamp; the repository validates same-Customer and invoice-to-shipment membership.

- [ ] **Step 4: Run focused migration tests.**

Run: `node --test test/phase6-migration.test.js test/commercial-migration.test.js test/po-migration.test.js`

Expected: all migration constraints and legacy anchor checks pass.

- [ ] **Step 5: Commit the independently reviewable schema task.**

```bash
git add migrations/0007_shipping_di_integration.sql test/phase6-migration.test.js
git commit -m "feat: add Phase 6 shipping DI schema"
```

## Task 2: Service Partners master

**Files:**
- Create: `src/shipping-di/validation.js`
- Create: `src/shipping-di/repository.js`
- Create: `src/shipping-di/routes.js`
- Create: `test/service-partners.repository.test.js`
- Create: `test/service-partners.routes.test.js`
- Modify: `src/index.js`.

**Interfaces:**
- Consumes: `service_partners` from Task 1 and authenticated `{ user_id, role }` from `resolveAuthenticatedUser`.
- Produces: `validateServicePartner(dto)`, `createShippingDiRepository(dbBinding).listServicePartners(filters)`, `.createServicePartner(dto, actorId)`, `.updateServicePartner(partnerId, dto, actorId)`, and `createShippingDiHandler({ repo, resolveUser, db })`.

- [ ] **Step 1: Write failing repository and route tests.**

```js
test('EXPORT can create and deactivate a SURVEYOR service partner', async () => {
  const partner = await repo.createServicePartner({ companyName: 'SGS', partnerType: 'SURVEYOR' }, 'U_EXPORT');
  const inactive = await repo.updateServicePartner(partner.partner_id, { status: 'INACTIVE' }, 'U_EXPORT');
  assert.equal(inactive.status, 'INACTIVE');
});
```

- [ ] **Step 2: Run focused tests and verify export failure.**

Run: `node --test test/service-partners.repository.test.js test/service-partners.routes.test.js`

Expected: failure because the Phase 6 module and route do not exist.

- [ ] **Step 3: Implement the small master and focused endpoints.** Validate nonblank Company Name, the four approved Partner Types, and `ACTIVE`/`INACTIVE`; reject rates, contracts, contacts, and other unapproved payload properties. Route `GET /api/service-partners` for operational readers and `POST`/`PATCH /api/service-partners/:id` for `EXPORT`, `ADMIN`, and `MANAGER` only.

```js
export function validateServicePartner({ companyName, partnerType, status = 'ACTIVE' }) {
  if (!String(companyName || '').trim()) throw codedError('SERVICE_PARTNER_NAME_REQUIRED');
  if (!['FORWARDER','SHIPPING_LINE','TRUCKING','SURVEYOR'].includes(partnerType)) throw codedError('SERVICE_PARTNER_TYPE_INVALID');
  if (!['ACTIVE','INACTIVE'].includes(status)) throw codedError('SERVICE_PARTNER_STATUS_INVALID');
}
```

- [ ] **Step 4: Run focused and related RBAC tests.**

Run: `node --test test/service-partners.repository.test.js test/service-partners.routes.test.js test/worker.test.js`

Expected: active/inactive behavior, allowed roles, and unauthenticated denial pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di src/index.js test/service-partners.repository.test.js test/service-partners.routes.test.js
git commit -m "feat: add Phase 6 service partners"
```

## Task 3: DI creation, numbering, and exact PO-line linkage

**Files:**
- Modify: `src/shipping-di/validation.js`, `src/shipping-di/repository.js`, `src/shipping-di/routes.js`, `src/index.js`
- Create: `test/delivery-instructions.repository.test.js`, `test/delivery-instructions.routes.test.js`

**Interfaces:**
- Consumes: Task 2 handler and `po_headers`, `po_revisions`, `po_revision_lines` from Phase 5F.
- Produces: `createDeliveryInstruction(dto, actorId)`, `getDeliveryInstruction(diId)`, `listDeliveryInstructions(filters)`, `suggestPartnersForCustomer(customerId)`, and `POST/GET /api/delivery-instructions`.

- [ ] **Step 1: Write failing tests for Customer and internal DI numbers.**

```js
test('internal DI number increments only within its PO and every line is an exact Phase 5F line', async () => {
  const first = await repo.createDeliveryInstruction(diPayload({ diNo: null, poId: 'PO-2026-015', lines: [exactLine('REV-1', 'LINE-10')] }), 'U_EXPORT');
  const second = await repo.createDeliveryInstruction(diPayload({ diNo: null, poId: 'PO-2026-015', lines: [exactLine('REV-1', 'LINE-20')] }), 'U_EXPORT');
  assert.equal(first.di_no, 'PO-2026-015_001');
  assert.equal(second.di_no, 'PO-2026-015_002');
});
```

- [ ] **Step 2: Run the DI tests and verify the missing functions fail.**

Run: `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js`

Expected: failure because DI persistence and routes are absent.

- [ ] **Step 3: Implement DRAFT creation.** Require one Customer, one PO Header, one or more exact line references, planned quantity per line, packing snapshot, `shipping_month` in `YYYY-MM`, `FIRST_HALF`/`SECOND_HALF`, valid optional Google Drive URL, and optional Forwarder. Validate all lines belong to the DI's Customer PO and selected PO Revision. Use supplied Customer DI No. exactly; otherwise query the PO-specific `_NNN` suffix and generate the next one. Save Surveyor/Forwarder suggestions from the latest non-cancelled historical DI for the Customer but never make either mandatory.

```js
async function nextInternalDiNo(db, poId) {
  const row = await db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(di_no, LENGTH(?) + 2) AS INTEGER)), 0) AS n FROM delivery_instructions WHERE po_id = ? AND di_no GLOB ?")
    .bind(poId, poId, `${poId}_[0-9]*`).first();
  return `${poId}_${String(Number(row?.n || 0) + 1).padStart(3, '0')}`;
}
```

- [ ] **Step 4: Run DI and PO linkage regressions.**

Run: `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js test/po-routes.test.js test/po-lines.test.js`

Expected: normal and combined DI creation, invalid foreign lineage rejection, URL validation, and existing PO tests pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js src/index.js
git commit -m "feat: add Phase 6 delivery instructions"
```

## Task 4: State-aware DI quantity availability

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/validation.js`, `src/shipping-di/routes.js`
- Modify: `test/delivery-instructions.repository.test.js`, `test/delivery-instructions.routes.test.js`

**Interfaces:**
- Consumes: exact PO line `max_qty_mt`, DI lines, and container-line actuals from Task 1.
- Produces: `getPoLineBalances(poId)`, `assertDeliveryInstructionAvailability(lines, excludedDiId)`, and `GET /api/delivery-instructions/po-balance/:poId`.

- [ ] **Step 1: Write a double-counting regression test.**

```js
test('PO line balance subtracts planned only until that DI has actual container quantity', async () => {
  await seedConfirmedDiWithPlan('LINE-10', 10);
  await seedActualContainerLineForDi('LINE-10', 8);
  const [balance] = await repo.getPoLineBalances('PO1');
  assert.equal(balance.available_qty_mt, 92); // 100 max - 8 actual; not 100 - 10 - 8
});
```

- [ ] **Step 2: Run the test and verify the missing balance method fails.**

Run: `node --test test/delivery-instructions.repository.test.js`

Expected: failure because the balance read model is not implemented.

- [ ] **Step 3: Implement a single state-aware balance query.** For each PO Revision Line, calculate actual Net Weight from non-cancelled Phase 6 Shipment container lines; calculate planned only from non-cancelled DI lines whose DI has no actual Container Line quantity; subtract both from `max_qty_mt`. Validate a new or edited DRAFT line against the resulting available quantity plus its own pre-existing allocation. Reject all writes that make actual quantity exceed `max_qty_mt`.

```js
const availableQty = line.max_qty_mt - line.actual_qty_mt - line.unrepresented_planned_qty_mt;
if (requestedQty > availableQty + priorAllocation + 0.000001) throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
```

- [ ] **Step 4: Run quantity and lifecycle regression tests.**

Run: `node --test test/delivery-instructions.repository.test.js test/phase6-shipments.repository.test.js test/po-lines.test.js`

Expected: tolerance Max Qty, cancellation release, combined lines, and no-double-counting cases pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js
git commit -m "feat: add Phase 6 DI quantity balances"
```

## Task 5: DI lifecycle and audit

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/routes.js`, `src/shipping-di/validation.js`
- Modify: `test/delivery-instructions.repository.test.js`, `test/delivery-instructions.routes.test.js`

**Interfaces:**
- Consumes: Tasks 3–4 DI records and `logShipmentAuditEvent(entityType, entityId, eventType, actorId, metadata)`.
- Produces: `confirmDeliveryInstruction`, `updateDraftDeliveryInstruction`, `cancelDeliveryInstruction`, `deleteDraftDeliveryInstruction`, `getShippingDiHistory`, and focused DI transition routes.

- [ ] **Step 1: Write lifecycle tests.**

```js
test('only never-confirmed DRAFT DI can be deleted and confirmed cancellation requires a note', async () => {
  await assert.rejects(() => repo.cancelDeliveryInstruction('DI1', '', 'U_EXPORT'), /CANCEL_NOTE_REQUIRED/);
  await repo.confirmDeliveryInstruction('DI1', 'U_EXPORT');
  await assert.rejects(() => repo.deleteDraftDeliveryInstruction('DI1'), /DI_HARD_DELETE_FORBIDDEN/);
});
```

- [ ] **Step 2: Run lifecycle tests and verify failure.**

Run: `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js`

Expected: failure because transitions and audit are absent.

- [ ] **Step 3: Implement explicit business transitions.** Expose `POST /api/delivery-instructions/:id/confirm`, `POST /:id/cancel`, and `DELETE /:id` only for never-confirmed DRAFT records. Keep DRAFT editing focused at `PATCH /:id`; confirmation is allowed for all `EXPORT` users. Insert `DI_CREATED`, `DI_UPDATED`, `DI_CONFIRMED`, and `DI_CANCELLED` events with actor, timestamp, entity, type, and useful old/new metadata.

```js
if (di.status !== 'DRAFT') throw codedError('DI_NOT_DRAFT');
await db.batch([
  db.prepare("UPDATE delivery_instructions SET status = 'CONFIRMED', updated_by = ?, updated_at = ? WHERE di_id = ?").bind(actorId, now, diId),
  auditStatement('DI', diId, 'DI_CONFIRMED', actorId, {})
]);
```

- [ ] **Step 4: Run focused tests and audit checks.**

Run: `node --test test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js test/phase6-migration.test.js`

Expected: transition guards, hard-delete rule, cancellation release, and audit fields pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/delivery-instructions.repository.test.js test/delivery-instructions.routes.test.js
git commit -m "feat: add Phase 6 DI lifecycle"
```

## Task 6: Booking and rich Shipment core

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/routes.js`, `src/shipping-di/validation.js`, `src/index.js`
- Create: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: a confirmed DI, Service Partners, and Task 5 audit helper.
- Produces: `createShipmentForDeliveryInstruction`, `recordShipmentBooking`, `getPhase6Shipment`, `GET /api/delivery-instructions/:id/shipment`, and `PUT /api/shipments-v2/:id/booking`.

- [ ] **Step 1: Write failing one-DI/one-Shipment and booking tests.**

```js
test('recording a Booking creates exactly one Shipment and changes DI to IN_PROGRESS', async () => {
  const shipment = await repo.createShipmentForDeliveryInstruction('DI1', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', vessel: 'MV A' }, 'U_EXPORT');
  assert.equal((await repo.getDeliveryInstruction('DI1')).status, 'IN_PROGRESS');
  await assert.rejects(() => repo.createShipmentForDeliveryInstruction('DI1', 'U_EXPORT'), /SHIPMENT_ALREADY_EXISTS/);
});
```

- [ ] **Step 2: Run Shipment-core tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js`

Expected: failure because rich Shipment operations do not exist.

- [ ] **Step 3: Implement separate rich Shipment creation and Booking update.** A confirmed DI gets one `phase6_shipments` record in `PLANNING`; Booking No. moves it to `BOOKED` and its DI to `IN_PROGRESS`. Accept only Booking No., partner IDs for Forwarder/Shipping Line/Trucking, Vessel, ETD, ETA, and Planned Loading Date. Validate partner type where selected; ETD/ETA are informational and never feed Schedule Result. Audit `BOOKING_RECORDED`.

- [ ] **Step 4: Run focused tests plus legacy Shipment route tests.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/shipment-ensure-anchor.test.js test/shipment-documents.routes.test.js test/shipment-expenses.routes.test.js`

Expected: rich business routes pass while legacy `/api/shipments` remains unchanged.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di src/index.js test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: add Phase 6 booking shipments"
```

## Task 7: Loading dates and Schedule Result

**Files:**
- Modify: `src/shipping-di/validation.js`, `src/shipping-di/repository.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: Shipment's DI `shipping_month` and `shipping_period`.
- Produces: `calculateScheduleResult(shippingMonth, shippingPeriod, actualLoadingDate)`, `updateShipmentSchedule`, and `PUT /api/shipments-v2/:id/schedule`.

- [ ] **Step 1: Write boundary-date tests.**

```js
test('schedule result uses Actual Loading Date and not ETD', () => {
  assert.equal(calculateScheduleResult('2026-09', 'FIRST_HALF', '2026-09-15'), 'ON_PLAN');
  assert.equal(calculateScheduleResult('2026-09', 'FIRST_HALF', '2026-09-16'), 'OUT_OF_PLAN');
});
```

- [ ] **Step 2: Run focused tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js`

Expected: failure because schedule calculation is not exported.

- [ ] **Step 3: Implement latest planned date and actual date handling.** Recalculate Schedule Result only when Actual Loading Date exists. Persist only the latest Planned Loading Date in `phase6_shipments`, emit `PLANNED_LOADING_DATE_UPDATED` with old/new values, emit `ACTUAL_LOADING_DATE_RECORDED`, and set Shipment to `LOADED` only when actual loading data is recorded. Do not add delay scores.

- [ ] **Step 4: Run focused route and repository tests.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js`

Expected: half-month boundaries, date update audit, and ETD independence pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: add Phase 6 shipment scheduling"
```

## Task 8: Containers and actual quantity

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/validation.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`, `test/delivery-instructions.repository.test.js`

**Interfaces:**
- Consumes: `updateShipmentSchedule`, DI exact PO Line references, and Task 4 `getPoLineBalances`.
- Produces: `replaceShipmentContainers(shipmentId, containers, actorId)`, `getShipmentActualQty(shipmentId)`, and `PUT /api/shipments-v2/:id/containers`.

- [ ] **Step 1: Write mixed-product and Max Qty tests.**

```js
test('mixed Container Lines sum Net Weight and reject quantity above exact PO line Max', async () => {
  const result = await repo.replaceShipmentContainers('S1', [{ containerNo: 'EGSU2548896', sealNo: 'SEAL1', lines: [{ poRevisionLineId: 'L1', numberOfBags: 10, netWeightMt: 9.5 }, { poRevisionLineId: 'L2', numberOfBags: 10, netWeightMt: 9.5 }] }], 'U_EXPORT');
  assert.equal(result.actual_qty_mt, 19);
});
```

- [ ] **Step 2: Run focused tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js test/delivery-instructions.repository.test.js`

Expected: failure because Container persistence is absent.

- [ ] **Step 3: Implement replacement as one validated transaction.** Accept Container No., optional Seal No., and non-empty lines containing a DI-referenced PO Revision Line, positive bag count, and positive Net Weight. Reject Gross, VGM, Tare, and pallet fields. Validate all replacement lines before deleting/reinserting so an invalid replacement leaves the existing shipment intact; then write `CONTAINER_ADDED` or `CONTAINER_UPDATED` audit events and recalculate actual quantity/balances.

- [ ] **Step 4: Run focused plus balance regression tests.**

Run: `node --test test/phase6-shipments.repository.test.js test/delivery-instructions.repository.test.js test/phase6-shipments.routes.test.js`

Expected: multiple Containers, mixed products, exact-line restriction, and no-double-counting balance pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/delivery-instructions.repository.test.js
git commit -m "feat: add Phase 6 shipment containers"
```

## Task 9: Commercial Invoices

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/validation.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: exact PO Line `unit_price`/`currency`, actual container quantities, and Shipment aggregate data.
- Produces: `createShipmentInvoice`, `updateShipmentInvoice`, `finalizeShipmentInvoice`, `getShipmentInvoices`, and `/api/shipments-v2/:id/invoices` endpoints.

- [ ] **Step 1: Write Invoice version tests.**

```js
test('tolerance Invoice reuses its manual number and FINAL uses Actual Qty', async () => {
  const preliminary = await repo.createShipmentInvoice('S1', { invoiceNo: 'WCAT001/2026', version: 'PRELIMINARY', lines: [{ poRevisionLineId: 'L1', qtyMt: 105 }] }, 'U_EXPORT');
  const final = await repo.finalizeShipmentInvoice(preliminary.invoice_id, [{ poRevisionLineId: 'L1', qtyMt: 101 }], 'U_EXPORT');
  assert.equal(final.invoice_no, 'WCAT001/2026');
  assert.equal(final.version, 'FINAL');
});
```

- [ ] **Step 2: Run Invoice tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js`

Expected: failure because Invoice methods are absent.

- [ ] **Step 3: Implement manual-number Invoice actions.** Support multiple Invoices per Shipment and multiple lines per Invoice. Snapshot `unit_price` and currency from the referenced PO Revision Line inside the repository; calculate `line_amount = qty_mt * unit_price_snapshot` and Invoice Total from lines. Permit fixed shipments to create `FINAL`; for tolerance shipments allow `PRELIMINARY` then replace its lines with `FINAL` using the same Invoice No. On finalization verify each final Qty does not exceed line Max Allowed Qty and actual Container Qty supports the final quantity. Audit `INVOICE_RECORDED` and `INVOICE_FINALIZED`.

- [ ] **Step 4: Run focused and PO commercial regressions.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/po-lines.test.js`

Expected: multi-Invoice, multi-line, price snapshot, total, preliminary/final, and Max Qty cases pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: add Phase 6 shipment invoices"
```

## Task 10: All Ship Docs and document delivery

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/validation.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: `phase6_shipments` document-delivery columns.
- Produces: `updateShipmentDocuments`, `isDocumentRequirementSatisfied`, and `PUT /api/shipments-v2/:id/documents`. Task 12 adds the completion recomputation call after this document action is available.

- [ ] **Step 1: Write digital-only and DHL-required tests.**

```js
test('DHL-required Shipment cannot become DOCS_SENT without date and tracking number', async () => {
  await assert.rejects(() => repo.updateShipmentDocuments('S1', { allShipDocsDriveUrl: 'https://drive.google.com/folder/1', digitalDocsSentDate: '2026-09-01', originalDocsRequired: true }, 'U_EXPORT'), /DHL_DETAILS_REQUIRED/);
});
```

- [ ] **Step 2: Run focused tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js`

Expected: failure because the document action is absent.

- [ ] **Step 3: Implement one-folder document delivery.** Validate only the folder URL and delivery fields in the approved spec. A digital sent date is mandatory before document completion; when `original_docs_required` is true, require both DHL sent date and tracking. Set `DOCS_SENT` when the requirement is satisfied unless later Task 12 immediately completes it; audit `DOCS_EMAIL_SENT` and `DOCS_DHL_SENT`. Do not create per-file records or modify legacy `shipment_document_links`.

- [ ] **Step 4: Run focused and legacy document regressions.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/shipment-documents.repository.test.js test/shipment-documents.routes.test.js`

Expected: rich one-folder rules and legacy document links both pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: add Phase 6 document delivery"
```

## Task 11: Customer Credit and Payment

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/validation.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: FINAL Invoice totals and Shipment Customer resolved through its DI.
- Produces: `createCustomerCredit`, `useCustomerCredit`, `updateShipmentPayment`, `recalculateShipmentPayment`, `POST/GET /api/customer-credits`, and `PUT /api/shipments-v2/:id/payment`.

- [ ] **Step 1: Write cross-customer and partial-payment tests.**

```js
test('credit cannot cross Customers or exceed remaining balance', async () => {
  const credit = await repo.createCustomerCredit({ customerId: 'C1', amount: 100, reason: 'Commercial adjustment' }, 'U_EXPORT');
  await assert.rejects(() => repo.useCustomerCredit('S_FOR_C2', { creditId: credit.credit_id, amount: 1 }, 'U_EXPORT'), /CREDIT_CUSTOMER_MISMATCH/);
  await assert.rejects(() => repo.useCustomerCredit('S_FOR_C1', { creditId: credit.credit_id, amount: 101 }, 'U_EXPORT'), /CREDIT_BALANCE_EXCEEDED/);
});
```

- [ ] **Step 2: Run Payment tests and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js`

Expected: failure because credit/payment actions are absent.

- [ ] **Step 3: Implement lightweight Customer-bound credit.** Create Credit with amount, reason, remaining balance, creator, and timestamp. Usage must attach to the Shipment and optional Invoice only after verifying the same Customer and same Shipment. Recalculate Shipment obligation as the sum of FINAL Invoice totals; calculate `cash_received_amount + allocated_credit_amount`; set `UNPAID`, `PARTIAL`, or `PAID` exactly from that comparison. Audit `CUSTOMER_CREDIT_CREATED`, `CUSTOMER_CREDIT_USED`, and `PAYMENT_UPDATED`; do not add bank references, transactions, or reconciliation.

- [ ] **Step 4: Run Payment and completion-precondition tests.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js`

Expected: Customer isolation, remaining balance, multi-Shipment use, final-only collection, and statuses pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: add Phase 6 payment credit"
```

## Task 12: Automatic Shipment and DI completion

**Files:**
- Modify: `src/shipping-di/repository.js`, `src/shipping-di/routes.js`
- Modify: `test/phase6-shipments.repository.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: `isDocumentRequirementSatisfied` from Task 10 and `recalculateShipmentPayment` from Task 11.
- Produces: `recomputeShipmentCompletion(shipmentId, actorId)`, automatically invoked after documents and payment mutations.

- [ ] **Step 1: Write automatic completion tests.**

```js
test('Shipment and DI complete only after both docs and payment are satisfied', async () => {
  await repo.updateShipmentDocuments('S1', digitalOnlyDocs(), 'U_EXPORT');
  assert.equal((await repo.getPhase6Shipment('S1')).status, 'DOCS_SENT');
  await repo.updateShipmentPayment('S1', { cashReceivedAmount: 500 }, 'U_EXPORT');
  assert.equal((await repo.getPhase6Shipment('S1')).status, 'COMPLETED');
  assert.equal((await repo.getDeliveryInstruction('DI1')).status, 'COMPLETED');
});
```

- [ ] **Step 2: Run completion test and verify failure.**

Run: `node --test test/phase6-shipments.repository.test.js`

Expected: failure because recomputation is absent.

- [ ] **Step 3: Implement one atomic recomputation path.** After each relevant document/payment write, read document satisfaction and Payment Status, then use `db.batch` to set Shipment `COMPLETED`, DI `COMPLETED`, and `SHIPMENT_COMPLETED` audit event together. When only documents are satisfied retain `DOCS_SENT`; never provide a manual completion endpoint.

- [ ] **Step 4: Run focused regression tests.**

Run: `node --test test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/delivery-instructions.repository.test.js`

Expected: both prerequisite orderings, DHL-required docs, partial payment, and transaction outcomes pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di test/phase6-shipments.repository.test.js test/phase6-shipments.routes.test.js test/delivery-instructions.repository.test.js
git commit -m "feat: complete Phase 6 shipments automatically"
```

## Task 13: Phase 6 RBAC and read models

**Files:**
- Modify: `src/shipping-di/routes.js`
- Create: `test/phase6-rbac.test.js`
- Modify: `test/delivery-instructions.routes.test.js`, `test/phase6-shipments.routes.test.js`

**Interfaces:**
- Consumes: full repository DTOs and Customer ownership from `customers.owner_user_id`.
- Produces: `projectShippingDiForRole(record, caller)` and `canAccessShippingDiCustomer(caller, customerId)` applied before every response.

- [ ] **Step 1: Write projection tests.**

```js
test('PRODUCTION_WAREHOUSE receives loading fields but no invoice, credit, payment, or audit data', async () => {
  const response = await fetchAs('PRODUCTION_WAREHOUSE', '/api/shipments-v2/S1');
  const shipment = (await response.json()).data.shipment;
  assert.equal(shipment.actual_loading_date, '2026-09-10');
  assert.equal('payment_status' in shipment, false);
  assert.equal('invoices' in shipment, false);
});
```

- [ ] **Step 2: Run RBAC tests and verify failure.**

Run: `node --test test/phase6-rbac.test.js`

Expected: failure because Phase 6 projection logic is absent.

- [ ] **Step 3: Implement server-side role projections.** `EXPORT` can fully write operational Phase 6 data. `ADMIN`/`MANAGER` manage for oversight. `SALES_SUPPORT` has operational read only. `EXTERNAL_SALES`, when route access is enabled, is read-only and scoped to `customers.owner_user_id`; omit audit/internal detail. `PRODUCTION_WAREHOUSE` receives only Product, Qty, Packing, Container Plan, planned/actual dates, and required loading data; omit prices, invoices, payment, credit, and audit. Do not rely on frontend hiding.

- [ ] **Step 4: Run RBAC, PO, and legacy security regressions.**

Run: `node --test test/phase6-rbac.test.js test/delivery-instructions.routes.test.js test/phase6-shipments.routes.test.js test/po-routes.test.js test/shipment-ensure-anchor.test.js`

Expected: all roles receive only approved fields and existing route permissions remain intact.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di/routes.js test/phase6-rbac.test.js test/delivery-instructions.routes.test.js test/phase6-shipments.routes.test.js
git commit -m "feat: secure Phase 6 shipment views"
```

## Task 14: Focused API integration

**Files:**
- Modify: `src/shipping-di/routes.js`, `src/index.js`
- Modify: `test/delivery-instructions.routes.test.js`, `test/phase6-shipments.routes.test.js`, `test/worker.test.js`

**Interfaces:**
- Consumes: all Task 2–13 repository methods and role projector.
- Produces: stable business endpoints with `{ status: 'SUCCESS', data }` responses consistent with existing routes.

- [ ] **Step 1: Write route/method-guard tests.**

```js
test('Phase 6 rejects generic Shipment PATCH and exposes focused business actions', async () => {
  assert.equal((await request('PATCH', '/api/shipments-v2/S1', {})).status, 404);
  assert.equal((await request('PUT', '/api/shipments-v2/S1/booking', { bookingNo: 'BK1' })).status, 200);
});
```

- [ ] **Step 2: Run route tests and verify failure.**

Run: `node --test test/delivery-instructions.routes.test.js test/phase6-shipments.routes.test.js test/worker.test.js`

Expected: failure until route dispatch and method guards are complete.

- [ ] **Step 3: Register and guard exact routes.** Add `/api/service-partners`, `/api/customer-credits`, `/api/delivery-instructions`, `/:id`, `/:id/confirm`, `/:id/cancel`, `/:id/shipment`, and `/api/delivery-instructions/po-balance/:poId`; add `/api/shipments-v2/:id`, `/booking`, `/schedule`, `/containers`, `/invoices`, `/invoices/:invoiceId/finalize`, `/documents`, `/payment`, and `/history`. Use `POST`, `PUT`, and `PATCH` only where this plan assigns a single purpose. Leave `/api/shipments` dispatched to `createShipmentHandlerFromEnv` without semantic change.

- [ ] **Step 4: Run API and worker routing tests.**

Run: `node --test test/delivery-instructions.routes.test.js test/phase6-shipments.routes.test.js test/phase6-rbac.test.js test/worker.test.js`

Expected: endpoint success, method guard, authentication, and route namespace behavior pass.

- [ ] **Step 5: Commit.**

```bash
git add src/shipping-di/routes.js src/index.js test/delivery-instructions.routes.test.js test/phase6-shipments.routes.test.js test/worker.test.js
git commit -m "feat: add Phase 6 shipping APIs"
```

## Task 15: D1-backed simple frontend

**Files:**
- Modify: `public/index.html`
- Create: `test/frontend-shipping-di-adapter.test.js`
- Modify: `test/frontend-inline-script-syntax.test.js`, `test/frontend-pricing-shipment-adapter.test.js`

**Interfaces:**
- Consumes: Task 14 endpoints and their response DTOs.
- Produces: `state.deliveryInstructions`, `state.phase6ShipmentDetail`, `loadDeliveryInstructionsFromApi`, `loadDeliveryInstructionDetailFromApi`, `saveDeliveryInstructionToApi`, `updatePhase6ShipmentSectionToApi`, and `renderShippingDiWorkspace`.

- [ ] **Step 1: Write adapter and parser regression tests before editing inline JS.**

```js
test('loadDeliveryInstructionsFromApi replaces only Phase 6 state', async () => {
  globalThis.fetch = async url => ({ ok: true, json: async () => ({ status: 'SUCCESS', data: { deliveryInstructions: [{ di_id: 'DI1' }] } }) });
  await extractFunction('loadDeliveryInstructionsFromApi()')();
  assert.equal(globalThis.state.deliveryInstructions[0].di_id, 'DI1');
});
```

- [ ] **Step 2: Run frontend tests and verify adapter failure while the parser remains green.**

Run: `node --test test/frontend-shipping-di-adapter.test.js test/frontend-inline-script-syntax.test.js`

Expected: adapter test fails before implementation; inline-script parser remains a mandatory regression.

- [ ] **Step 3: Add a compact DI / Shipment List and detail sections.** Add one primary list with DI No., Customer, PO, Product summary, Planned Qty, Container Plan, Shipping Plan, planned/actual loading dates, Schedule Result, Booking No., Shipment Status, and Payment Status. Add progressive-entry detail sections: DI, Booking, Containers, Invoice, Documents, Payment, and History. Add basic search and approved filters; fetch partner suggestions and PO balance rather than duplicating calculations. Preserve existing Phase 5E shipment cost/document UI and other modules; do not perform a broad rewrite or add a wizard.

```js
async function updatePhase6ShipmentSectionToApi(shipmentId, section, payload) {
  const res = await fetch(`/api/shipments-v2/${shipmentId}/${section}`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload)
  });
  const body = await res.json();
  if (!res.ok || body.status !== 'SUCCESS') throw new Error(body.message || 'Phase 6 update failed.');
  return body.data;
}
```

- [ ] **Step 4: Run all frontend adapters and parser regression.**

Run: `node --test test/frontend-adapter.test.js test/frontend-pricing-shipment-adapter.test.js test/frontend-shipping-di-adapter.test.js test/frontend-inline-script-syntax.test.js`

Expected: new adapters work and every inline script parses; legacy adapters remain unchanged.

- [ ] **Step 5: Commit.**

```bash
git add public/index.html test/frontend-shipping-di-adapter.test.js test/frontend-inline-script-syntax.test.js test/frontend-pricing-shipment-adapter.test.js
git commit -m "feat: add Phase 6 shipping DI workspace"
```

## Task 16: Regression, legacy verification, and release readiness

**Files:**
- Modify: `test/phase6-migration.test.js`, `test/shipment-ensure-anchor.test.js`, `test/shipment-documents.routes.test.js`, `test/shipment-expenses.routes.test.js`, `test/po-routes.test.js`, and `test/frontend-inline-script-syntax.test.js` only when the final regression review identifies a concrete assertion that must be extended.
- Modify: `docs/PROJECT_STATUS.md` only in a later release workflow after deployment; do not modify it in implementation work.

**Interfaces:**
- Consumes: all Phase 6 modules and existing test suite.
- Produces: verified local implementation readiness; no remote migration or production action.

- [ ] **Step 1: Add explicit legacy preservation tests if they are missing.**

```js
test('legacy and Phase 6 Shipment namespaces remain independent', async () => {
  assert.equal((await request('GET', '/api/shipments/SH_LEGACY')).status, 200);
  assert.equal((await request('GET', '/api/shipments-v2/SH_PHASE6')).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE shipment_id = 'SH_LEGACY'").get().n, 1);
});
```

- [ ] **Step 2: Run the complete local test suite.**

Run: `npm test`

Expected: all existing and new tests pass with no weakened Phase 5E/5F coverage.

- [ ] **Step 3: Validate local migration and Worker/frontend syntax.**

Run: `node --test test/phase6-migration.test.js test/commercial-migration.test.js test/po-migration.test.js && node --check src/index.js && node --check src/shipping-di/repository.js && node --check src/shipping-di/routes.js && node --test test/frontend-inline-script-syntax.test.js`

Expected: clean local migration chain, Worker module syntax, and inline frontend JavaScript.

- [ ] **Step 4: Review final change scope before PR.** Verify `git diff --check`, inspect all migration SQL and route projections, confirm no legacy table rewrite, no remote D1 command, no deployment command, and no out-of-scope subsystem.

- [ ] **Step 5: Commit release-readiness tests only if this task added files.**

```bash
git add test
git commit -m "test: verify Phase 6 legacy compatibility"
```

## Spec coverage review

| Approved design area | Plan tasks |
| --- | --- |
| Core DI/Shipment architecture, joint Export ownership, exact PO lineage | 1, 3, 5, 6, 13, 14 |
| DI source/link, numbering, data, planning periods | 3, 7, 15 |
| Quantity control and cancellation release | 4, 5, 8 |
| Service Partners and optional suggestions | 2, 3, 6, 15 |
| Booking, loading, schedule result | 6, 7, 15 |
| Containers and actual Qty | 1, 4, 8, 15 |
| Invoice, preliminary/final, prices/totals | 1, 9, 15 |
| All Ship Docs and delivery | 1, 10, 12, 15 |
| Payment, Customer Credit, automatic completion | 1, 11, 12, 15 |
| Audit and history | 1, 5–12, 14, 15 |
| Search/filter and role-safe simple UI | 13, 15 |
| Legacy Phase 5E compatibility and release safety | 1, 6, 10, 14, 16 |

## Plan self-review

- Spec coverage: every approved section is mapped above; no DI revision model, legacy conversion, or unsupported PO-line backfill is planned.
- Interface consistency: the dedicated `createShippingDiRepository`, `createShippingDiHandler`, `delivery_instructions`, and `phase6_shipments` names are used consistently across tasks.
- Scope: excludes carrier tracking, arrival status, KPI/delay scoring, Gross/VGM/Tare, accounting/banking/payment ledger, automatic invoice/PDF/Drive/email/DHL functions, document-file engine, credit notes, and partner rate features.
- Simplicity: one additive migration, one focused server module, focused business endpoints, one list/detail frontend workspace, direct Google Drive links, and a single simple audit table.
- Execution guard: implementation starts only in a future isolated feature branch/worktree and stops at PR readiness; it does not merge, deploy, or mutate production.
