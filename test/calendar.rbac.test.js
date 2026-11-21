import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCalendarHandler } from '../src/calendar/routes.js';
import { createCalendarRepository } from '../src/calendar/repository.js';

function request(path) {
  return new Request(`https://example.com${path}`);
}

function assertFieldsAbsent(record, fields) {
  for (const field of fields) {
    assert.equal(field in record, false, `${field} must be absent`);
  }
}

async function setupCalendarRbacFixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql', '0002_customers.sql', '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql', '0005_po_management.sql',
    '0006_customer_ownership_type.sql', '0007_shipping_di_integration.sql', '0015_di_loading_date_range.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  for (const [userId, role, name] of [
    ['U_ADMIN', 'ADMIN', 'Admin'],
    ['U_EXPORT', 'EXPORT', 'Export Ops'],
    ['U_WAREHOUSE', 'PRODUCTION_WAREHOUSE', 'Somchai Warehouse'],
    ['U_SALES_1', 'EXTERNAL_SALES', 'Sira Sales'],
    ['U_SALES_2', 'EXTERNAL_SALES', 'Other Sales']
  ]) {
    db.prepare(
      "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, 'hash', 'salt', ?, 'ACTIVE', ?)"
    ).run(userId, `${userId}@example.com`, role, name);
  }

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Owned Customer', 'U_SALES_1')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C2', 'CUST2', 'Other Customer', 'U_SALES_2')").run();

  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P2', 'SPP-70', 'Sweet Potato Pellet', 'SPP70', 'CAT1', 'FORM1')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO1', 'C1', 'PARTIALLY_SHIPPED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'PO-OWNED-01', 'ASSIGNED_SALES', 'U_SALES_1', 'USD', 'FOB', 'Rotterdam', '2026-11-05', '2026-11-25', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, commission_rate_usd_mt, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 1, 'P1', 'STANDARD', 'SPEC1', 40, 0, 40, 40, 350, 2.5, 'Jumbo Bag', '40HC', 'Floor')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO2', 'C2', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'PO-OTHER-02', 'ASSIGNED_SALES', 'U_SALES_2', 'USD', 'CIF', 'Brisbane', '2026-11-08', '2026-11-28', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, commission_rate_usd_mt, packaging, container_type, loading_pattern) VALUES ('LINE2', 'REV2', 1, 'P2', 'STANDARD', 'SPEC2', 20, 0, 20, 20, 410, 1.5, '50 kg PP Bag', '20GP', '540 bags')").run();

  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI1', 'C1', 'PO1', 'REV1', 'DI-OWNED-01', '2026-11', 'FIRST_HALF', '2 x 40HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL1', 'DI1', 'PO1', 'REV1', 'LINE1', 'P1', 20, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, schedule_result, cash_received_amount, payment_status, payment_note, created_by, updated_by) VALUES ('S1', 'DI1', 'LOADED', 'BK-OWNED', 'MV OWNED', '2026-11-15', '2026-11-29', '2026-11-10', '2026-11-12', 'ON_PLAN', 7000, 'PAID', 'Secret note', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, seal_no, status, created_by, updated_by) VALUES ('CONT1', 'S1', 'EGSU2548896', '40HC', 'SEAL-1', 'LOADED', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by, updated_by) VALUES ('CONTL1', 'CONT1', 'DIL1', 10, 20, 'U_EXPORT', 'U_EXPORT')").run();

  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI2', 'C2', 'PO2', 'REV2', 'DI-OTHER-02', '2026-11', 'FIRST_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL2', 'DI2', 'PO2', 'REV2', 'LINE2', 'P2', 20, '50 kg PP Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, created_by, updated_by) VALUES ('S2', 'DI2', 'BOOKED', 'BK-OTHER', 'MV OTHER', '2026-11-18', '2026-11-30', '2026-11-14', NULL, 'U_EXPORT', 'U_EXPORT')").run();

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

  return { db, wrappedDb, repo: createCalendarRepository(wrappedDb) };
}

test('PRODUCTION_WAREHOUSE receives strictly loading events with exact approved fields and resists hidden-field inference', async () => {
  const { repo, wrappedDb } = await setupCalendarRbacFixture();
  const handler = createCalendarHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' })
  });

  const baselineRes = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30'));
  assert.equal(baselineRes.status, 200);
  const { data } = await baselineRes.json();

  // S1 planned (Nov 10), S1 actual (Nov 12), S2 planned (Nov 14) => 3 loading events only
  assert.equal(data.events.length, 3);
  assert.equal(data.events.every(e => e.event_type === 'LOADING_PLANNED' || e.event_type === 'LOADING_ACTUAL'), true);
  assert.ok(data.dailyLoadingSummary.length > 0);

  const s1Actual = data.events.find(e => e.event_type === 'LOADING_ACTUAL');
  assert.match(s1Actual.event_id, /^[a-f0-9]{64}$/);
  assert.equal(s1Actual.event_date, '2026-11-12');
  assert.equal(s1Actual.planned_loading_date, '2026-11-10');
  assert.equal(s1Actual.actual_loading_date, '2026-11-12');
  assert.equal(s1Actual.container_plan, '2 x 40HC');
  assert.equal(s1Actual.planned_qty_mt, 20);
  assert.equal(s1Actual.actual_container_count, 1);
  assert.deepEqual(s1Actual.products, [{
    product_code: 'THP-65',
    product_name: 'Tapioca Pellet 65%',
    planned_qty_mt: 20,
    packing_snapshot: 'Jumbo Bag'
  }]);
  assert.deepEqual(s1Actual.containers, [{
    container_no: 'EGSU2548896',
    seal_no: 'SEAL-1',
    lines: [{ product_code: 'THP-65', product_name: 'Tapioca Pellet 65%', number_of_bags: 10, qty_mt: 20 }]
  }]);

  assertFieldsAbsent(s1Actual, [
    'status', 'di_status', 'shipment_status', 'schedule_result',
    'shipment_id', 'di_id', 'di_no', 'po_id', 'customer_po_no',
    'customer_id', 'customer_name', 'sales_owner_user_id',
    'booking_no', 'vessel', 'etd', 'eta',
    'loading_date_history', 'can_reschedule',
    'payment_status', 'cash_received_amount', 'unit_price'
  ]);

  // Disallowed event types return empty cleanly
  const etdRes = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30&eventType=ETD'));
  assert.equal(etdRes.status, 200);
  assert.deepEqual((await etdRes.json()).data.events, []);

  // Hidden filter params MUST NOT alter returned results (anti-inference)
  const inferredRes = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30&customerId=C1&salesOwnerId=U_SALES_1&status=BOOKED'));
  assert.equal(inferredRes.status, 200);
  assert.deepEqual((await inferredRes.json()).data.events, data.events);

  // Allowed productId filter works
  const p1Res = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30&productId=P1'));
  const p1Events = (await p1Res.json()).data.events;
  assert.equal(p1Events.length, 2);
  assert.equal(p1Events.every(e => e.products.every(p => p.product_code === 'THP-65')), true);
});

test('EXTERNAL_SALES receives strictly owned-Customer events with approved projections, empty summary, and resists inference', async () => {
  const { db, repo, wrappedDb } = await setupCalendarRbacFixture();
  const handler = createCalendarHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_SALES_1', role: 'EXTERNAL_SALES' })
  });

  const baselineRes = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30'));
  assert.equal(baselineRes.status, 200);
  const { data } = await baselineRes.json();

  // Only C1 events: PO1 start/end (2) + S1 planned, actual, ETD, ETA (4) = 6 events; zero C2/S2/PO2
  assert.equal(data.events.length, 6);
  assert.deepEqual(data.dailyLoadingSummary, []);
  assert.equal(data.events.some(e => e.di_no === 'DI-OTHER-02' || e.customer_po_no === 'PO-OTHER-02'), false);

  const shipmentEvent = data.events.find(e => e.event_type === 'ETD');
  assert.match(shipmentEvent.event_id, /^[a-f0-9]{64}$/);
  assert.equal(shipmentEvent.di_no, 'DI-OWNED-01');
  assert.equal(shipmentEvent.booking_no, 'BK-OWNED');
  assert.equal(shipmentEvent.vessel, 'MV OWNED');
  assert.equal(shipmentEvent.etd, '2026-11-15');
  assert.equal(shipmentEvent.eta, '2026-11-29');
  assert.equal(shipmentEvent.schedule_result, 'ON_PLAN');
  assertFieldsAbsent(shipmentEvent, [
    'shipment_id', 'di_id', 'po_id', 'customer_id', 'customer_name',
    'sales_owner_user_id', 'shipping_month', 'shipping_period',
    'container_plan', 'planned_qty_mt', 'actual_container_count',
    'products', 'containers', 'loading_date_history', 'can_reschedule',
    'payment_status', 'cash_received_amount'
  ]);

  const poEvent = data.events.find(e => e.event_type === 'PO_DELIVERY_START');
  assert.match(poEvent.event_id, /^[a-f0-9]{64}$/);
  assert.equal(poEvent.customer_po_no, 'PO-OWNED-01');
  assert.equal(poEvent.total_contract_qty_mt, 40);
  assertFieldsAbsent(poEvent, [
    'po_id', 'customer_id', 'customer_name', 'sales_owner_user_id',
    'unit_price', 'commission_rate_usd_mt', 'products', 'can_reschedule'
  ]);

  // Anti-inference: hidden query params do not change result set
  const inferredRes = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30&customerId=C2&salesOwnerId=U_SALES_2&productId=P2'));
  assert.equal(inferredRes.status, 200);
  assert.deepEqual((await inferredRes.json()).data.events, data.events);

  // Ownership change revokes access immediately
  db.prepare("UPDATE customers SET owner_user_id = 'U_SALES_2' WHERE customer_id = 'C1'").run();
  const afterTransfer = await handler(request('/api/operations-calendar?from=2026-11-01&to=2026-11-30'));
  assert.deepEqual((await afterTransfer.json()).data.events, []);
});
