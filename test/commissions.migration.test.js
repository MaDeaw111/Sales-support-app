import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function readMigration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

async function setupThrough0008() {
  const db = new DatabaseSync(':memory:');
  for (const name of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql',
    '0008_logistics_partners.sql'
  ]) {
    db.exec(await readMigration(name));
  }
  return db;
}

function seedCommissionReferences(db) {
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_MGR', 'mgr@example.com', 'hash', 'salt', 'MANAGER', 'ACTIVE', 'Manager')").run();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_SALES', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'External Sales')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Customer 1', 'U_SALES', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_MGR')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'ASSIGNED_SALES', 'U_SALES', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_MGR')").run();
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_MGR')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, cash_received_amount, payment_status, created_by) VALUES ('SHP1', 'DI1', 'COMPLETED', 10000, 'PAID', 'U_MGR')").run();
}

test('Phase 10 migration 0009 applies cleanly on top of 0001-0008 and creates tables and indexes', async () => {
  const db = await setupThrough0008();
  seedCommissionReferences(db);

  db.exec(await readMigration('0009_commission_settlement.sql'));

  for (const table of ['commission_settlements', 'commission_audit_events']) {
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `${table} should exist`
    );
  }
  for (const index of [
    'idx_commission_settlements_recipient_status',
    'idx_commission_settlements_shipment',
    'idx_commission_audit_events_settlement'
  ]) {
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(index),
      `${index} should exist`
    );
  }

  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM phase6_shipments WHERE shipment_id = 'SHP1'").get().n, 1);
});

test('commission_settlements and commission_audit_events enforce FKs, positive snapshots, uniqueness, and event types', async () => {
  const db = await setupThrough0008();
  db.exec(await readMigration('0009_commission_settlement.sql'));
  seedCommissionReferences(db);

  // Valid insert
  db.prepare(`
    INSERT INTO commission_settlements (
      settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
      actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, line_breakdown_json,
      paid_date, payment_reference, note, request_key, settled_by
    ) VALUES (
      'CS-0001', 'SHP1', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES',
      20.5, 10, 205, '[{"line_id":"L1","actual_mt":20.5,"rate_usd_mt":10,"amount_usd":205}]',
      '2026-11-19', 'TT-COM-001', 'Settled via wire', 'req-cs-1', 'U_MGR'
    )
  `).run();

  const row = db.prepare("SELECT * FROM commission_settlements WHERE settlement_id = 'CS-0001'").get();
  assert.equal(row.currency, 'USD');
  assert.equal(row.status, 'PAID');

  // Double-payout prevention: UNIQUE(shipment_id, recipient_user_id)
  assert.throws(
    () => db.prepare(`
      INSERT INTO commission_settlements (
        settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
        actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, line_breakdown_json,
        paid_date, request_key, settled_by
      ) VALUES (
        'CS-DUP', 'SHP1', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES',
        20.5, 10, 205, '[]', '2026-11-19', 'req-cs-2', 'U_MGR'
      )
    `).run(),
    /UNIQUE constraint failed: commission_settlements\.shipment_id, commission_settlements\.recipient_user_id/
  );

  // Idempotency key uniqueness
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_SALES2', 'sales2@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'External Sales 2')").run();
  assert.throws(
    () => db.prepare(`
      INSERT INTO commission_settlements (
        settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
        actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, line_breakdown_json,
        paid_date, request_key, settled_by
      ) VALUES (
        'CS-DUP-KEY', 'SHP1', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES2',
        10, 5, 50, '[]', '2026-11-19', 'req-cs-1', 'U_MGR'
      )
    `).run(),
    /UNIQUE constraint failed: commission_settlements\.request_key/
  );

  // Positive snapshot & enum constraints
  assert.throws(
    () => db.prepare(`
      INSERT INTO commission_settlements (
        settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
        actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, line_breakdown_json,
        paid_date, request_key, settled_by
      ) VALUES (
        'CS-ZERO', 'SHP1', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES2',
        0, 5, 50, '[]', '2026-11-19', 'req-zero', 'U_MGR'
      )
    `).run(),
    /CHECK constraint failed/
  );

  assert.throws(
    () => db.prepare(`
      INSERT INTO commission_settlements (
        settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
        actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, currency, line_breakdown_json,
        paid_date, request_key, settled_by
      ) VALUES (
        'CS-EUR', 'SHP1', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES2',
        10, 5, 50, 'EUR', '[]', '2026-11-19', 'req-eur', 'U_MGR'
      )
    `).run(),
    /CHECK constraint failed/
  );

  // FK violation
  assert.throws(
    () => db.prepare(`
      INSERT INTO commission_settlements (
        settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
        actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, line_breakdown_json,
        paid_date, request_key, settled_by
      ) VALUES (
        'CS-BAD-FK', 'SHP999', 'DI1', 'PO1', 'REV1', 'C1', 'U_SALES2',
        10, 5, 50, '[]', '2026-11-19', 'req-fk', 'U_MGR'
      )
    `).run(),
    /FOREIGN KEY constraint failed/
  );

  // Audit events constraints
  db.prepare("INSERT INTO commission_audit_events (event_id, settlement_id, event_type, actor_id, metadata_json) VALUES ('CEVT-1', 'CS-0001', 'COMMISSION_SETTLED', 'U_MGR', '{}')").run();
  db.prepare("INSERT INTO commission_audit_events (event_id, settlement_id, event_type, actor_id, metadata_json) VALUES ('CEVT-2', 'CS-0001', 'COMMISSION_NOTE_UPDATED', 'U_MGR', '{}')").run();
  assert.throws(
    () => db.prepare("INSERT INTO commission_audit_events (event_id, settlement_id, event_type, actor_id) VALUES ('CEVT-BAD', 'CS-0001', 'COMMISSION_DELETED', 'U_MGR')").run(),
    /CHECK constraint failed/
  );
});
