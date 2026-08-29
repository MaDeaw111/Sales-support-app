import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  return {
    db,
    wrappedDb: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          params: [],
          bind(...params) {
            this.params = params;
            return this;
          },
          async first() {
            return statement.all(...this.params)[0] || null;
          },
          async all() {
            return { results: statement.all(...this.params), success: true };
          },
          async run() {
            return { success: true, meta: statement.run(...this.params) };
          }
        };
      }
    }
  };
}

test('EXPORT can create and deactivate a SURVEYOR service partner', async () => {
  const { db, wrappedDb } = await setupTestDb();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_EXPORT', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();
  const repo = createShippingDiRepository(wrappedDb);

  const partner = await repo.createServicePartner({ companyName: 'SGS', partnerType: 'SURVEYOR' }, 'U_EXPORT');
  const inactive = await repo.updateServicePartner(partner.partner_id, { status: 'INACTIVE' }, 'U_EXPORT');

  assert.match(partner.partner_id, /^SP-/);
  assert.equal(partner.partner_name, 'SGS');
  assert.equal(partner.partner_type, 'SURVEYOR');
  assert.equal(inactive.status, 'INACTIVE');
  assert.deepEqual(await repo.listServicePartners({ status: 'ACTIVE' }), []);
  assert.deepEqual(await repo.listServicePartners({ status: 'INACTIVE' }), [inactive]);
});

test('service partners reject unapproved partner properties and invalid values', async () => {
  const { db, wrappedDb } = await setupTestDb();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_EXPORT', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();
  const repo = createShippingDiRepository(wrappedDb);

  await assert.rejects(
    () => repo.createServicePartner({ companyName: 'SGS', partnerType: 'SURVEYOR', rate: 100 }, 'U_EXPORT'),
    /SERVICE_PARTNER_PROPERTY_INVALID/
  );
  await assert.rejects(
    () => repo.createServicePartner({ companyName: '  ', partnerType: 'SURVEYOR' }, 'U_EXPORT'),
    /SERVICE_PARTNER_NAME_REQUIRED/
  );
  await assert.rejects(
    () => repo.createServicePartner({ companyName: 'SGS', partnerType: 'OTHER' }, 'U_EXPORT'),
    /SERVICE_PARTNER_TYPE_INVALID/
  );
});
