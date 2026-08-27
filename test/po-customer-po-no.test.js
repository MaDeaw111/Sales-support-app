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
  const ownSql = await readFile(new URL('../migrations/0006_customer_ownership_type.sql', import.meta.url), 'utf8');
  db.exec(ownSql);
  return db;
}

test('Customer PO Number Uniqueness and History', async () => {
  const db = await setupTestDb();
  
  // Seed database
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U1')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C2', 'CUST2', 'Customer 2', 'U1')").run();

  const repo = createPORepository(db);

  // 1. Create first PO for Customer 1 with customerPoNo = 'PO-XYZ-111'
  const po1 = await repo.createDraftPO({
    customerId: 'C1',
    customerPoNo: 'PO-XYZ-111',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'U1');

  assert.ok(po1.header);
  assert.equal(po1.revision.customer_po_no, 'PO-XYZ-111');

  // 2. Create second PO for Customer 1 with the same customerPoNo should fail
  await assert.rejects(async () => {
    await repo.createDraftPO({
      customerId: 'C1',
      customerPoNo: 'PO-XYZ-111',
      poDate: '2026-08-27',
      currency: 'USD',
      incoterm: 'FOB',
      deliveryStart: '2026-09-01',
      deliveryEnd: '2026-09-30',
      validUntil: '2026-08-31'
    }, 'U1');
  }, (err) => {
    return err.code === 'PO_CUSTOMER_PO_DUPLICATE' || err.message.toLowerCase().includes('duplicate customer po');
  }, 'Should reject duplicate customer PO number for the same customer');

  // 3. Create PO for Customer 2 with the same customerPoNo should succeed (different customers can have the same PO number)
  const po2 = await repo.createDraftPO({
    customerId: 'C2',
    customerPoNo: 'PO-XYZ-111',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'U1');
  assert.ok(po2.header);
  assert.equal(po2.revision.customer_po_no, 'PO-XYZ-111');

  // 4. Create another PO for Customer 1 with unique PO number, then try to update it to duplicate PO number
  const po3 = await repo.createDraftPO({
    customerId: 'C1',
    customerPoNo: 'PO-XYZ-333',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'U1');

  // Update with unique value should succeed
  const updatedRev = await repo.updateRevisionOverview(po3.revision.revision_id, {
    customerPoNo: 'PO-XYZ-444',
    currency: 'EUR',
    incoterm: 'CIF',
    destination: 'Genoa'
  });
  assert.equal(updatedRev.customer_po_no, 'PO-XYZ-444');
  assert.equal(updatedRev.currency, 'EUR');
  assert.equal(updatedRev.incoterm, 'CIF');
  assert.equal(updatedRev.destination, 'Genoa');

  // Update with duplicate value for the same customer should fail
  await assert.rejects(async () => {
    await repo.updateRevisionOverview(po3.revision.revision_id, {
      customerPoNo: 'PO-XYZ-111'
    });
  }, (err) => {
    return err.code === 'PO_CUSTOMER_PO_DUPLICATE' || err.message.toLowerCase().includes('duplicate customer po');
  }, 'Should reject update to duplicate customer PO number for the same customer');

  // 5. Attempting to update a revision that is ACTIVE should be rejected
  // Mock revision status as ACTIVE manually
  db.prepare("UPDATE po_revisions SET status = 'ACTIVE' WHERE revision_id = ?").run(po3.revision.revision_id);
  
  await assert.rejects(async () => {
    await repo.updateRevisionOverview(po3.revision.revision_id, {
      customerPoNo: 'PO-XYZ-555'
    });
  }, (err) => {
    return err.code === 'PO_ACTIVE_IMMUTABLE' || err.message.toLowerCase().includes('cannot edit active revision') || err.message.toLowerCase().includes('immutable');
  }, 'Should reject updates on active/immutable revisions');
});
