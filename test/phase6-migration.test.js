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

test('Phase 6 migration is additive and retains Phase 5E shipment anchors', async () => {
  const db = await setupThrough0006();
  db.exec(await readMigration('0007_shipping_di_integration.sql'));

  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipments'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipment_document_links'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'shipment_expenses'").get());
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'phase6_shipments'").get());

  assert.throws(
    () => db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI1','C1','PO1','D1','2026-09','INVALID','DRAFT','U1')").run(),
    /constraint failed/,
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
    'idx_delivery_instruction_lines_po_line',
    'idx_phase6_shipments_status',
    'idx_phase6_shipments_booking_no',
    'idx_shipment_invoices_invoice_no',
    'idx_shipment_containers_container_no',
    'idx_shipment_audit_events_shipment_created_at',
  ]) {
    assert.ok(db.prepare('SELECT name FROM sqlite_master WHERE type = ? AND name = ?').get('index', index), `${index} should exist`);
  }
});
