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
  for (const column of ['di_drive_url', 'surveyor_partner_id', 'forwarder_partner_id', 'lifecycle_version']) {
    assert.ok(deliveryInstructionColumns.includes(column), `${column} should exist on delivery_instructions`);
  }

  const auditColumns = db.prepare('PRAGMA table_info(shipment_audit_events)').all().map((column) => column.name);
  assert.deepEqual(auditColumns, ['event_id', 'entity_type', 'entity_id', 'event_type', 'actor_id', 'metadata_json', 'created_at']);

  const containerLineColumns = db.prepare('PRAGMA table_info(shipment_container_lines)').all().map((column) => column.name);
  assert.ok(containerLineColumns.includes('number_of_bags'), 'container lines retain the recorded bag count');

  const shipmentColumns = db.prepare('PRAGMA table_info(phase6_shipments)').all().map((column) => column.name);
  assert.ok(shipmentColumns.includes('container_version'), 'shipments retain a container-write version');
  assert.ok(shipmentColumns.includes('final_invoice_version'), 'shipments retain a FINAL invoice reservation version');
  assert.ok(shipmentColumns.includes('final_invoice_write_token'), 'shipments retain a FINAL invoice reservation token');
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

test('Phase 6 audit permits BOOKING_RECORDED and rejects obsolete BOOKING_UPDATED', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();

  db.prepare("INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES ('EVT-1', 'SHIPMENT', 'SHP-1', 'BOOKING_RECORDED', 'U1')").run();
  assert.equal(db.prepare("SELECT event_type FROM shipment_audit_events WHERE event_id = 'EVT-1'").get().event_type, 'BOOKING_RECORDED');
  assert.throws(
    () => db.prepare("INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES ('EVT-2', 'SHIPMENT', 'SHP-1', 'BOOKING_UPDATED', 'U1')").run(),
    /CHECK constraint failed: event_type/
  );
});

test('Phase 6 audit permits the approved loading-date events', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();

  for (const [eventId, eventType] of [
    ['EVT-1', 'PLANNED_LOADING_DATE_UPDATED'],
    ['EVT-2', 'ACTUAL_LOADING_DATE_RECORDED']
  ]) {
    db.prepare('INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, 'SHIPMENT', 'SHP-1', eventType, 'U1');
  }
  assert.deepEqual(
    db.prepare("SELECT event_type FROM shipment_audit_events WHERE entity_id = 'SHP-1' ORDER BY event_id").all().map((event) => event.event_type),
    ['PLANNED_LOADING_DATE_UPDATED', 'ACTUAL_LOADING_DATE_RECORDED']
  );
});

test('Phase 6 invoice schema has required dates, optimistic versions, and exact Invoice audit events', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();

  const invoiceColumns = db.prepare('PRAGMA table_info(shipment_invoices)').all();
  for (const column of ['invoice_date', 'currency', 'version', 'invoice_version', 'invoice_write_token', 'final_container_version']) {
    assert.ok(invoiceColumns.some((candidate) => candidate.name === column), `${column} should exist on shipment_invoices`);
  }
  assert.equal(invoiceColumns.find((column) => column.name === 'invoice_date').notnull, 1, 'invoice dates are mandatory');
  assert.equal(invoiceColumns.some((column) => column.name === 'status'), false, 'obsolete invoice status must not coexist with version');
  assert.equal(invoiceColumns.some((column) => column.name === 'note'), false, 'invoice notes are not an approved invoice field');
  assert.equal(invoiceColumns.some((column) => column.name === 'drive_url'), false, 'invoice Drive URLs belong only to Shipment documents');
  const invoiceTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'shipment_invoices'").get().sql;
  assert.match(invoiceTableSql, /UNIQUE\s*\(shipment_id,\s*invoice_no\)/i, 'invoice numbers are unique only within a Shipment');
  assert.doesNotMatch(invoiceTableSql, /UNIQUE\s*\(invoice_no\)/i, 'the same manual invoice number can occur on another Shipment');

  for (const [eventId, eventType] of [
    ['EVT-INVOICE-1', 'INVOICE_RECORDED'],
    ['EVT-INVOICE-2', 'INVOICE_FINALIZED']
  ]) {
    db.prepare('INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, 'INVOICE', 'INV-1', eventType, 'U1');
  }
  assert.throws(
    () => db.prepare("INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES ('EVT-INVOICE-3', 'INVOICE', 'INV-1', 'INVOICE_ADDED', 'U1')").run(),
    /CHECK constraint failed: event_type/
  );
});

test('Phase 6 credit schema is lightweight and accepts the approved payment and completion audit events', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();

  const creditColumns = db.prepare('PRAGMA table_info(customer_credits)').all().map((column) => column.name);
  assert.deepEqual(creditColumns, ['credit_id', 'customer_id', 'amount', 'reason', 'remaining_amount', 'request_key', 'created_by', 'created_at']);
  for (const [eventId, eventType] of [
    ['EVT-CREDIT-1', 'CUSTOMER_CREDIT_CREATED'],
    ['EVT-CREDIT-2', 'CUSTOMER_CREDIT_USED'],
    ['EVT-PAYMENT-1', 'PAYMENT_UPDATED'],
    ['EVT-COMPLETION-1', 'SHIPMENT_COMPLETED']
  ]) {
    db.prepare('INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id) VALUES (?, ?, ?, ?, ?)')
      .run(eventId, eventType.startsWith('CUSTOMER') ? 'CREDIT' : 'SHIPMENT', 'SHP-1', eventType, 'U1');
  }
});

test('Phase 6 credit request keys are unique for idempotent creation and usage', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));
  seedDeliveryInstructionReferences(db);

  const creditColumns = db.prepare('PRAGMA table_info(customer_credits)').all().map((column) => column.name);
  const usageColumns = db.prepare('PRAGMA table_info(customer_credit_usages)').all().map((column) => column.name);
  assert.ok(creditColumns.includes('request_key'));
  assert.ok(usageColumns.includes('request_key'));
  const creditSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_credits'").get().sql;
  const usageSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'customer_credit_usages'").get().sql;
  assert.match(creditSql, /request_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
  assert.match(usageSql, /request_key\s+TEXT\s+NOT\s+NULL\s+UNIQUE/i);
});
