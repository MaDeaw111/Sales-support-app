import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPORepository } from '../src/pos/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);
  const productSpecsSql = await readFile(new URL('../migrations/0003_product_specs.sql', import.meta.url), 'utf8');
  db.exec(productSpecsSql);
  const commercialSql = await readFile(new URL('../migrations/0004_commercial_shipment_control.sql', import.meta.url), 'utf8');
  db.exec(commercialSql);
  const poSql = await readFile(new URL('../migrations/0005_po_management.sql', import.meta.url), 'utf8');
  db.exec(poSql);
  return db;
}

test('Customer CRM Ownership & House Account Rules', async () => {
  const db = await setupTestDb();

  // Create users
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('USR_ACTIVE_SALES', 'active_sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Active Sales', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('USR_INACTIVE_SALES', 'inactive_sales@example.com', 'EXTERNAL_SALES', 'INACTIVE', 'Inactive Sales', 'hash', 'salt')").run();

  // Create customers
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('CUST_WITH_ACTIVE', 'C_ACT', 'Customer with Active Owner', 'USR_ACTIVE_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('CUST_WITH_INACTIVE', 'C_INACT', 'Customer with Inactive Owner', 'USR_INACTIVE_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('CUST_HOUSE_ACCOUNT', 'C_HOUSE', 'Customer House Account', NULL)").run();

  const repo = createPORepository(db);

  // 1. Creating a PO for a customer with no sales owner throws PO_CUSTOMER_OWNER_REQUIRED when ownershipType is ASSIGNED_SALES
  await assert.rejects(async () => {
    await repo.createDraftPO({
      customerId: 'CUST_HOUSE_ACCOUNT',
      ownershipType: 'ASSIGNED_SALES',
      poDate: '2026-08-27',
      currency: 'USD',
      incoterm: 'FOB',
      deliveryStart: '2026-09-01',
      deliveryEnd: '2026-09-30',
      validUntil: '2026-08-31'
    }, 'USR_ACTIVE_SALES');
  }, (err) => {
    return err.code === 'PO_CUSTOMER_OWNER_REQUIRED' || err.message.includes('owner required');
  }, 'Should reject if ASSIGNED_SALES has no owner');

  // 2. Creating a PO for a customer with a valid active owner works when ownershipType is ASSIGNED_SALES
  const po1 = await repo.createDraftPO({
    customerId: 'CUST_WITH_ACTIVE',
    ownershipType: 'ASSIGNED_SALES',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'USR_ACTIVE_SALES');
  
  assert.equal(po1.revision.ownership_type_snapshot, 'ASSIGNED_SALES');
  assert.equal(po1.revision.sales_owner_user_id_snapshot, 'USR_ACTIVE_SALES');

  // 3. Creating a PO for a customer with an inactive owner throws PO_CUSTOMER_OWNER_REQUIRED
  await assert.rejects(async () => {
    await repo.createDraftPO({
      customerId: 'CUST_WITH_INACTIVE',
      poDate: '2026-08-27',
      currency: 'USD',
      incoterm: 'FOB',
      deliveryStart: '2026-09-01',
      deliveryEnd: '2026-09-30',
      validUntil: '2026-08-31'
    }, 'USR_ACTIVE_SALES');
  }, (err) => {
    return err.code === 'PO_CUSTOMER_OWNER_REQUIRED' || err.message.includes('owner required');
  }, 'Should reject if customer owner is inactive');

  // 4. Creating a PO for a customer under HOUSE_ACCOUNT successfully saves with NULL sales owner snapshot
  const po2 = await repo.createDraftPO({
    customerId: 'CUST_HOUSE_ACCOUNT',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'USR_ACTIVE_SALES');

  assert.equal(po2.revision.ownership_type_snapshot, 'HOUSE_ACCOUNT');
  assert.equal(po2.revision.sales_owner_user_id_snapshot, null);
});
