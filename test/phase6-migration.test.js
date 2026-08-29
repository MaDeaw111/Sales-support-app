import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function readMigration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

async function setupThrough0006() {
  const db = new DatabaseSync(':memory:');
  for (const name of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
  ]) {
    db.exec(await readMigration(name));
  }
  return db;
}

function seedDeliveryInstructionReferences(db) {
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U1')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'DRAFT', 'ASSIGNED_SALES', 'U1', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-08-31', 'U1')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC-REV-1', 100, 10, 90, 110, 350, 'Jumbo Bag', '20GP', 'Palletized')").run();
}

test('Phase 6 migration is additive and retains Phase 5E shipment anchors', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  seedDeliveryInstructionReferences(db);

  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipments'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipment_document_links'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipment_expenses'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'phase6_shipments'").get());

  assert.throws(
    () => db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI1','C1','PO1','REV1','D1','2026-09','INVALID','DRAFT','U1')").run(),
    /CHECK constraint failed: shipping_period/,
  );

  for (const [diId, status] of [['DI2', 'CONFIRMED'], ['DI3', 'IN_PROGRESS'], ['DI4', 'COMPLETED']]) {
    db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES (?, 'C1', 'PO1', 'REV1', ?, '2026-09', 'FIRST_HALF', ?, 'U1')")
      .run(diId, `${diId}-NO`, status);
  }
  assert.throws(
    () => db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI5', 'C1', 'PO1', 'REV1', 'DI5-NO', '2026-09', 'FIRST_HALF', 'ISSUED', 'U1')").run(),
    /CHECK constraint failed: status/
  );
});

test('Phase 6 schema creates every shipping DI table and required lookup indexes', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));

  for (const table of [
    'service_partners',
    'delivery_instructions',
    'delivery_instruction_lines',
    'phase6_shipments',
    'shipment_containers',
    'shipment_container_lines',
    'shipment_invoices',
    'shipment_invoice_lines',
    'customer_credits',
    'customer_credit_usages',
    'shipment_audit_events',
  ]) {
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('table', table), `${table} should exist`);
  }

  for (const index of [
    'idx_delivery_instructions_di_no',
    'idx_delivery_instructions_customer_status',
    'idx_delivery_instructions_customer_history',
    'idx_delivery_instruction_lines_po_line',
    'idx_phase6_shipments_status',
    'idx_phase6_shipments_booking_no',
    'idx_shipment_invoices_invoice_no',
    'idx_shipment_containers_container_no',
    'idx_shipment_audit_events_entity_created_at',
  ]) {
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('index', index), `${index} should exist`);
  }

  const deliveryInstructionColumns = db.prepare('PRAGMA table_info(delivery_instructions)').all().map((column) => column.name);
  for (const column of ['di_drive_url', 'surveyor_partner_id', 'forwarder_partner_id']) {
    assert.ok(deliveryInstructionColumns.includes(column), `${column} should exist on delivery_instructions`);
  }

  const auditColumns = db.prepare('PRAGMA table_info(shipment_audit_events)').all().map((column) => column.name);
  assert.deepEqual(auditColumns, ['event_id', 'entity_type', 'entity_id', 'event_type', 'actor_id', 'metadata_json', 'created_at']);
});

test('Phase 6 service partners permit the approved SURVEYOR type and reject OTHER', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();

  db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES ('SP-001', 'SURVEYOR', 'SGS', 'U1')").run();
  assert.throws(
    () => db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES ('SP-002', 'OTHER', 'Other Partner', 'U1')").run(),
    /CHECK constraint failed: partner_type/
  );
});
