import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import {
  CALENDAR_EVENT_TYPES,
  WAREHOUSE_EVENT_TYPES,
  isValidIsoDate,
  parseCalendarQuery
} from '../src/calendar/validation.js';
import { createCalendarHandler } from '../src/calendar/routes.js';
import { createCalendarRepository } from '../src/calendar/repository.js';

async function setupRouteFixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql', '0002_customers.sql', '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql', '0005_po_management.sql',
    '0006_customer_ownership_type.sql', '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  for (const [userId, role] of [
    ['U_ADMIN', 'ADMIN'],
    ['U_MANAGER', 'MANAGER'],
    ['U_EXPORT', 'EXPORT'],
    ['U_SUPPORT', 'SALES_SUPPORT']
  ]) {
    db.prepare(
      "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, 'hash', 'salt', ?, 'ACTIVE', ?)"
    ).run(userId, `${userId}@example.com`, role, userId);
  }

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'MEEL', 'MEELUNIE', 'U_SUPPORT')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO1', 'C1', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'PO-01', 'ASSIGNED_SALES', 'U_SUPPORT', 'USD', 'FOB', 'Rotterdam', '2026-11-05', '2026-11-25', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 1, 'P1', 'STANDARD', 'SPEC1', 40, 0, 40, 40, 350, 'Jumbo Bag', '20GP', '20 bags')").run();
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI1', 'C1', 'PO1', 'REV1', 'DI-01', '2026-11', 'FIRST_HALF', '2 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL1', 'DI1', 'PO1', 'REV1', 'LINE1', 'P1', 34, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, created_by, updated_by) VALUES ('S1', 'DI1', 'BOOKED', 'BK-01', 'MSC ARIES', '2026-11-15', '2026-11-30', '2026-11-12', NULL, 'U_EXPORT', 'U_EXPORT')").run();

  const wrappedDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() { return statement.all(...this.params)[0] || null; },
        async all() { return { results: statement.all(...this.params), success: true }; },
        async run() { return { success: true, meta: statement.run(...this.params) }; }
      };
    }
  };
  return { wrappedDb, repo: createCalendarRepository(wrappedDb) };
}

test('calendar validation exposes the 6 canonical event types and warehouse subset', () => {
  assert.deepEqual(CALENDAR_EVENT_TYPES, [
    'LOADING_PLANNED',
    'LOADING_ACTUAL',
    'ETD',
    'ETA',
    'PO_DELIVERY_START',
    'PO_DELIVERY_END'
  ]);
  assert.deepEqual(WAREHOUSE_EVENT_TYPES, ['LOADING_PLANNED', 'LOADING_ACTUAL']);
});

test('isValidIsoDate validates strict YYYY-MM-DD calendar dates', () => {
  assert.equal(isValidIsoDate('2026-11-19'), true);
  assert.equal(isValidIsoDate('2028-02-29'), true);
  assert.equal(isValidIsoDate('2026-02-29'), false);
  assert.equal(isValidIsoDate('2026-02-30'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-11-9'), false);
  assert.equal(isValidIsoDate(''), false);
});

test('parseCalendarQuery defaults to current UTC month when from and to are omitted', () => {
  const parsed = parseCalendarQuery(new URLSearchParams(), new Date('2026-11-19T09:00:00Z'));
  assert.equal(parsed.from, '2026-11-01');
  assert.equal(parsed.to, '2026-11-30');
  assert.equal(parsed.eventType, undefined);
  assert.equal(parsed.customerId, undefined);
  assert.equal(parsed.salesOwnerId, undefined);
  assert.equal(parsed.productId, undefined);
  assert.equal(parsed.status, undefined);
});

test('parseCalendarQuery rejects partial range, invalid date, inverted range, >366 day range, and unknown eventType', () => {
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ from: '2026-11-01' })), /from and to/i);
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ to: '2026-11-30' })), /from and to/i);
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ from: '2026-02-30', to: '2026-03-05' })), /invalid from date/i);
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ from: '2026-11-15', to: '2026-11-10' })), /on or before/i);
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ from: '2026-01-01', to: '2027-01-05' })), /366 days/i);
  assert.throws(() => parseCalendarQuery(new URLSearchParams({ from: '2026-11-01', to: '2026-11-30', eventType: 'PO_VALID_UNTIL' })), /eventType/i);
});

test('parseCalendarQuery normalizes valid filters and treats ALL as undefined', () => {
  const parsed = parseCalendarQuery(new URLSearchParams({
    from: '2026-09-01',
    to: '2026-09-30',
    eventType: 'ETD',
    customerId: ' C1 ',
    salesOwnerId: 'ALL',
    productId: 'P1',
    status: 'booked'
  }));
  assert.deepEqual(parsed, {
    from: '2026-09-01',
    to: '2026-09-30',
    eventType: 'ETD',
    customerId: 'C1',
    salesOwnerId: undefined,
    productId: 'P1',
    status: 'BOOKED'
  });
});

test('GET /api/operations-calendar returns 401 when unauthenticated and 400 on invalid params', async () => {
  const { repo, wrappedDb } = await setupRouteFixture();
  const unauthHandler = createCalendarHandler({ repo, db: wrappedDb, resolveUser: async () => null });
  const unauthRes = await unauthHandler(new Request('https://example.com/api/operations-calendar'));
  assert.equal(unauthRes.status, 401);

  const adminHandler = createCalendarHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_ADMIN', role: 'ADMIN' })
  });
  const badRes = await adminHandler(new Request('https://example.com/api/operations-calendar?from=2026-11-20&to=2026-11-10'));
  assert.equal(badRes.status, 400);
});

test('can_reschedule is true for ADMIN, MANAGER, and EXPORT on BOOKED LOADING_PLANNED, and false for SALES_SUPPORT', async () => {
  const { repo, wrappedDb } = await setupRouteFixture();

  for (const role of ['ADMIN', 'MANAGER', 'EXPORT']) {
    const handler = createCalendarHandler({
      repo,
      db: wrappedDb,
      resolveUser: async () => ({ user_id: `U_${role}`, role })
    });
    const res = await handler(new Request('https://example.com/api/operations-calendar?from=2026-11-01&to=2026-11-30'));
    assert.equal(res.status, 200);
    const { data } = await res.json();
    const loading = data.events.find(e => e.event_type === 'LOADING_PLANNED');
    const etd = data.events.find(e => e.event_type === 'ETD');
    assert.equal(loading.can_reschedule, true, `${role} should be able to reschedule BOOKED loading`);
    assert.equal(etd.can_reschedule, false, 'non-loading events are never reschedulable');
  }

  const supportHandler = createCalendarHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' })
  });
  const supportRes = await supportHandler(new Request('https://example.com/api/operations-calendar?from=2026-11-01&to=2026-11-30'));
  const supportEvents = (await supportRes.json()).data.events;
  assert.equal(supportEvents.every(e => e.can_reschedule === false), true);
});

test('worker dispatches /api/operations-calendar (503 without DB binding)', async () => {
  const res = await worker.fetch(new Request('https://example.com/api/operations-calendar'), {});
  assert.equal(res.status, 503);
});
