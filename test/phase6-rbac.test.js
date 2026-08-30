import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShippingDiHandler } from '../src/shipping-di/routes.js';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';

function request(path) {
  return new Request(`https://example.com${path}`);
}

async function setupRbacFixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql', '0002_customers.sql', '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql', '0005_po_management.sql',
    '0006_customer_ownership_type.sql', '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }
  for (const [userId, role] of [['U_EXPORT', 'EXPORT'], ['U_SALES', 'EXTERNAL_SALES'], ['U_OTHER', 'EXTERNAL_SALES']]) {
    db.prepare('INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, \'hash\', \'salt\', ?, \'ACTIVE\', ?)')
      .run(userId, `${userId}@example.com`, role, userId);
  }
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Owned Customer', 'U_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'ASSIGNED_SALES', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-12-31', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 20, 0, 20, 20, 350, 'Jumbo Bag', '40HC', 'Floor loaded')").run();
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI1', 'C1', 'PO1', 'REV1', 'CUSTOMER-DI-1', '2026-09', 'FIRST_HALF', '2 × 40''HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL1', 'DI1', 'PO1', 'REV1', 'LINE1', 'P1', 20, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, planned_loading_date, actual_loading_date, schedule_result, cash_received_amount, payment_status, payment_note, created_by, updated_by) VALUES ('S1', 'DI1', 'LOADED', 'BK-1', 'MV Internal', '2026-09-08', '2026-09-10', 'ON_PLAN', 7000, 'PAID', 'Internal payment note', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, seal_no, status, created_by, updated_by) VALUES ('CONT1', 'S1', 'EGSU2548896', '20GP', 'SEAL-1', 'LOADED', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by, updated_by) VALUES ('CONTL1', 'CONT1', 'DIL1', 10, 20, 'U_EXPORT', 'U_EXPORT')").run();

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
  return { db, wrappedDb, repo: createShippingDiRepository(wrappedDb) };
}

test('PRODUCTION_WAREHOUSE receives the exact loading read model from repository data', async () => {
  const { repo, wrappedDb } = await setupRbacFixture();
  const handler = createShippingDiHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' })
  });

  const response = await handler(request('/api/shipments-v2/S1'));
  const shipment = (await response.json()).data.shipment;

  assert.equal(response.status, 200);
  assert.deepEqual(shipment, {
    planned_loading_date: '2026-09-08',
    actual_loading_date: '2026-09-10',
    products: [{ product_code: 'THP-65', product_name: 'Tapioca Pellet 65%', planned_qty_mt: 20, packing_snapshot: 'Jumbo Bag' }],
    container_plan: "2 × 40'HC",
    containers: [{
      container_no: 'EGSU2548896',
      seal_no: 'SEAL-1',
      lines: [{ product_code: 'THP-65', product_name: 'Tapioca Pellet 65%', number_of_bags: 10, qty_mt: 20 }]
    }]
  });
});

test('EXTERNAL_SALES receives only its approved shipment-progress allowlist for an owned Customer', async () => {
  const { repo, wrappedDb } = await setupRbacFixture();
  const handler = createShippingDiHandler({
    repo,
    db: wrappedDb,
    resolveUser: async () => ({ user_id: 'U_SALES', role: 'EXTERNAL_SALES' })
  });

  const response = await handler(request('/api/shipments-v2/S1'));
  const shipment = (await response.json()).data.shipment;

  assert.equal(response.status, 200);
  assert.deepEqual(shipment, {
    di_no: 'CUSTOMER-DI-1',
    status: 'LOADED',
    booking_no: 'BK-1',
    vessel: 'MV Internal',
    planned_loading_date: '2026-09-08',
    actual_loading_date: '2026-09-10',
    schedule_result: 'ON_PLAN'
  });
});

test('EXTERNAL_SALES is owner-scoped and shipment-v2 lookup never treats a DI id as a shipment id', async () => {
  const { db, repo, wrappedDb } = await setupRbacFixture();
  let caller = { user_id: 'U_SALES', role: 'EXTERNAL_SALES' };
  const handler = createShippingDiHandler({ repo, db: wrappedDb, resolveUser: async () => caller });

  assert.equal((await handler(request('/api/delivery-instructions/DI1/shipment'))).status, 200);
  assert.equal((await handler(request('/api/shipments-v2/DI1'))).status, 404);

  db.prepare("UPDATE customers SET owner_user_id = 'U_OTHER' WHERE customer_id = 'C1'").run();
  assert.equal((await handler(request('/api/delivery-instructions/DI1/shipment'))).status, 403);
  assert.equal((await handler(request('/api/shipments-v2/S1'))).status, 403);
  caller = { user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' };
  assert.equal((await handler(request('/api/shipments-v2/S1'))).status, 200);
});

test('workspace list is server-projected for external sales and warehouse loading work', async () => {
  const { repo, wrappedDb } = await setupRbacFixture();
  let caller = { user_id: 'U_SALES', role: 'EXTERNAL_SALES' };
  const handler = createShippingDiHandler({ repo, db: wrappedDb, resolveUser: async () => caller });

  let response = await handler(request('/api/delivery-instructions/workspace?search=BK-1'));
  let row = (await response.json()).data.deliveryInstructions[0];
  assert.equal(response.status, 200);
  assert.equal(row.di_no, 'CUSTOMER-DI-1');
  assert.equal('di_id' in row, false);
  assert.equal('payment_status' in row, false);

  caller = { user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' };
  response = await handler(request('/api/delivery-instructions/workspace'));
  row = (await response.json()).data.deliveryInstructions[0];
  assert.equal(row.product_summary, 'Tapioca Pellet 65%');
  assert.equal(row.actual_loading_date, '2026-09-10');
  assert.equal('payment_status' in row, false);
});
