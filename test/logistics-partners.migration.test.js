import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function readMigration(name) {
  return readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
}

async function setupThrough0007() {
  const db = new DatabaseSync(':memory:');
  for (const name of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readMigration(name));
  }
  return db;
}

test('Phase 8 migration 0008 applies cleanly on top of 0001-0007 and preserves service_partners rows', async () => {
  const db = await setupThrough0007();
  db.prepare(
    "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')"
  ).run();
  db.prepare(
    "INSERT INTO service_partners (partner_id, partner_type, partner_name, contact_name, status, created_by) VALUES ('SP-001', 'FORWARDER', 'Kerry Logistics', 'Somchai', 'ACTIVE', 'U1')"
  ).run();

  db.exec(await readMigration('0008_logistics_partners.sql'));

  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'service_partner_rates'").get(),
    'service_partner_rates table should exist'
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_service_partner_rates_partner_status'").get(),
    'idx_service_partner_rates_partner_status index should exist'
  );
  assert.ok(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_service_partners_type_status'").get(),
    'idx_service_partners_type_status index should exist'
  );

  const existing = db.prepare("SELECT * FROM service_partners WHERE partner_id = 'SP-001'").get();
  assert.equal(existing.partner_name, 'Kerry Logistics');
  assert.equal(existing.contact_name, 'Somchai');
});

test('service_partner_rates enforces FK, price > 0, currency, container_size, status, and valid_until >= effective_date', async () => {
  const db = await setupThrough0007();
  db.exec(await readMigration('0008_logistics_partners.sql'));
  db.prepare(
    "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')"
  ).run();
  db.prepare(
    "INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES ('SP-001', 'TRUCKING', 'Siam Truck', 'U1')"
  ).run();

  // Valid insert with defaults (container_size = '-', status = 'ACTIVE', valid_until = NULL)
  db.prepare(`
    INSERT INTO service_partner_rates (
      rate_id, partner_id, service_type, route_scope, unit, price, currency, effective_date, created_by
    ) VALUES ('SPR-0001', 'SP-001', 'Trucking', 'Factory -> Laem Chabang', 'THB / Container', 8500, 'THB', '2026-11-01', 'U1')
  `).run();

  const inserted = db.prepare("SELECT * FROM service_partner_rates WHERE rate_id = 'SPR-0001'").get();
  assert.equal(inserted.container_size, '-');
  assert.equal(inserted.status, 'ACTIVE');
  assert.equal(inserted.valid_until, null);

  // Valid insert with valid_until == effective_date and all supported currencies/sizes
  for (const [id, size, currency] of [
    ['SPR-0002', '20GP', 'USD'],
    ['SPR-0003', '40GP', 'EUR'],
    ['SPR-0004', '40HC', 'THB'],
    ['SPR-0005', 'BULK', 'USD'],
    ['SPR-0006', 'OTHER', 'EUR']
  ]) {
    db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, container_size, unit, price, currency, effective_date, valid_until, status, created_by
      ) VALUES (?, 'SP-001', 'Ocean Freight', ?, 'USD / Container', 1250.5, ?, '2026-11-01', '2026-11-01', 'INACTIVE', 'U1')
    `).run(id, size, currency);
  }

  // FK violation: unknown partner_id
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-FK', 'SP-999', 'Trucking', 'THB / Container', 1000, 'THB', '2026-11-01', 'U1')
    `).run(),
    /FOREIGN KEY constraint failed/
  );

  // Blank service_type
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-SVC', 'SP-001', '   ', 'THB / Container', 1000, 'THB', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // Blank unit
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-UNIT', 'SP-001', 'Trucking', '   ', 1000, 'THB', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // Price <= 0
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-PRICE0', 'SP-001', 'Trucking', 'THB / Container', 0, 'THB', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-PRICENEG', 'SP-001', 'Trucking', 'THB / Container', -50, 'THB', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // Unsupported currency
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-CURR', 'SP-001', 'Trucking', 'JPY / Container', 1000, 'JPY', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // Unsupported container_size
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, container_size, unit, price, currency, effective_date, created_by
      ) VALUES ('SPR-BAD-SIZE', 'SP-001', 'Trucking', '45HC', 'THB / Container', 1000, 'THB', '2026-11-01', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // Unsupported status
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, status, created_by
      ) VALUES ('SPR-BAD-STATUS', 'SP-001', 'Trucking', 'THB / Container', 1000, 'THB', '2026-11-01', 'ARCHIVED', 'U1')
    `).run(),
    /CHECK constraint failed/
  );

  // valid_until < effective_date
  assert.throws(
    () => db.prepare(`
      INSERT INTO service_partner_rates (
        rate_id, partner_id, service_type, unit, price, currency, effective_date, valid_until, created_by
      ) VALUES ('SPR-BAD-DATE', 'SP-001', 'Trucking', 'THB / Container', 1000, 'THB', '2026-11-10', '2026-11-09', 'U1')
    `).run(),
    /CHECK constraint failed/
  );
});
