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

test('PO Header & ID Sequence Generation', async () => {
  const db = await setupTestDb();
  
  // Create active salesperson
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  // Create inactive user
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_INACTIVE', 'inactive@example.com', 'EXTERNAL_SALES', 'INACTIVE', 'Inactive Person', 'hash', 'salt')").run();
  
  // Create customers: C1 has active owner, C2 has NULL owner, C4 has inactive owner
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Assigned Sales Customer', 'U1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'House Account Customer', NULL, 'HOUSE_ACCOUNT')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C4', 'CUST4', 'Inactive Owner Customer', 'U_INACTIVE', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C5', 'CUST5', 'Assigned Sales Customer No Owner', NULL, 'ASSIGNED_SALES')").run();

  const repo = createPORepository(db);

  // 1. Test creation of draft PO for ASSIGNED_SALES customer
  const dto1 = {
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  };

  const res1 = await repo.createDraftPO(dto1, 'U1');
  assert.ok(res1.header);
  assert.ok(res1.revision);
  
  assert.equal(res1.header.po_id, 'PO-2026-001');
  assert.equal(res1.header.header_status, 'OPEN');
  assert.equal(res1.header.created_by, 'U1');
  assert.equal(res1.header.current_draft_revision_id, res1.revision.revision_id);
  assert.equal(res1.header.current_active_revision_id, null);

  assert.equal(res1.revision.po_id, 'PO-2026-001');
  assert.equal(res1.revision.revision_no, 0);
  assert.equal(res1.revision.status, 'DRAFT');
  assert.equal(res1.revision.ownership_type_snapshot, 'ASSIGNED_SALES');
  assert.equal(res1.revision.sales_owner_user_id_snapshot, 'U1');
  assert.equal(res1.revision.currency, 'USD');
  assert.equal(res1.revision.incoterm, 'FOB');

  // 2. Test sequential ID generation for same year
  const dto2 = {
    customerId: 'C1',
    poDate: '2026-08-28',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  };
  const res2 = await repo.createDraftPO(dto2, 'U1');
  assert.equal(res2.header.po_id, 'PO-2026-002');

  // 3. Test sequential ID generation for next year
  const dto3 = {
    customerId: 'C1',
    poDate: '2027-01-05',
    currency: 'USD',
    incoterm: 'CIF',
    destination: 'Rotterdam',
    deliveryStart: '2027-02-01',
    deliveryEnd: '2027-02-28',
    validUntil: '2027-01-31'
  };
  const res3 = await repo.createDraftPO(dto3, 'U1');
  assert.equal(res3.header.po_id, 'PO-2027-001');

  // 4. Test HOUSE_ACCOUNT creation (NULL owner)
  const dto4 = {
    customerId: 'C2',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  };
  const res4 = await repo.createDraftPO(dto4, 'U1');
  assert.equal(res4.revision.ownership_type_snapshot, 'HOUSE_ACCOUNT');
  assert.equal(res4.revision.sales_owner_user_id_snapshot, null);

  // 5. Test ASSIGNED_SALES owner validation - invalid (inactive) owner in database
  const dto5 = {
    customerId: 'C4',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  };
  await assert.rejects(async () => {
    await repo.createDraftPO(dto5, 'U1');
  }, (err) => {
    return err.code === 'PO_CUSTOMER_OWNER_REQUIRED' || err.message.toLowerCase().includes('owner required');
  }, 'Should reject if CRM owner is inactive');

  // 6. Test ASSIGNED_SALES owner validation - missing owner (customer has ASSIGNED_SALES in CRM but NULL owner)
  const dto6 = {
    customerId: 'C5', // C5 has NULL owner and ASSIGNED_SALES
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  };
  await assert.rejects(async () => {
    await repo.createDraftPO(dto6, 'U1');
  }, (err) => {
    return err.code === 'PO_CUSTOMER_OWNER_REQUIRED' || err.message.toLowerCase().includes('owner required');
  }, 'Should reject if forced ASSIGNED_SALES but no owner assigned');
});
