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

test('Audit Event Logging and Field Diff Generation', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('M1', 'manager@example.com', 'MANAGER', 'ACTIVE', 'Manager', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD1', 'P1', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-27')").run();

  const repo = createPORepository(db);

  // 1. Create a draft PO
  const po = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const rev0Id = po.revision.revision_id;

  // Add a line to Rev.0
  const line0 = await repo.createPORevisionLine(rev0Id, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  // Add evidence document to Rev.0
  await repo.createPORevisionDocument(rev0Id, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  // Activate Rev.0
  await repo.activateRevision(rev0Id, 'M1', 'Activate Rev 0');

  // 2. Clone to next draft revision (Rev.1)
  const rev1Draft = await repo.createNextRevision(po.header.po_id, 'U1');
  const rev1Id = rev1Draft.revision_id;

  // Modify some overview fields in Rev.1: change incoterm from FOB to CFR and deliveryEnd to '2026-10-15'
  await repo.updateRevisionOverview(rev1Id, {
    incoterm: 'CFR',
    deliveryEnd: '2026-10-15',
    revisionNote: 'Updating incoterm and lines'
  });

  // Modify line 10 in Rev.1 (unitPrice from 350 to 360)
  const line10InRev1 = db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ? AND line_no = 10").get(rev1Id);
  await repo.updatePORevisionLine(line10InRev1.line_id, {
    unitPrice: 360.00
  });

  // Add a brand new line (line 20) in Rev.1
  const line20 = await repo.createPORevisionLine(rev1Id, {
    lineNo: 20,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD1',
    contractQtyMt: 50,
    tolerancePct: 5,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  // Activate Rev.1 (which triggers generateAndLogFieldDiffs)
  await repo.activateRevision(rev1Id, 'M1', 'Activate Rev 1');

  // 3. Verify generated field diffs in database
  const diffs = db.prepare("SELECT * FROM po_field_diffs WHERE po_revision_id = ?").all(rev1Id);
  
  // We expect:
  // - Incoterm changed (REVISION)
  // - DeliveryEnd changed (REVISION)
  // - Line 10 quantity/price changes (LINE)
  // - Line 20 added (LINE)
  assert.ok(diffs.length >= 4);

  const incotermDiff = diffs.find(d => d.entity_type === 'REVISION' && d.field_name === 'incoterm');
  assert.ok(incotermDiff);
  assert.equal(incotermDiff.old_value, 'FOB');
  assert.equal(incotermDiff.new_value, 'CFR');

  const deliveryEndDiff = diffs.find(d => d.entity_type === 'REVISION' && d.field_name === 'delivery_end');
  assert.ok(deliveryEndDiff);
  assert.equal(deliveryEndDiff.old_value, '2026-09-30');
  assert.equal(deliveryEndDiff.new_value, '2026-10-15');

  const priceDiff = diffs.find(d => d.entity_type === 'LINE' && d.field_name === 'unit_price');
  assert.ok(priceDiff);
  assert.equal(priceDiff.old_value, '350');
  assert.equal(priceDiff.new_value, '360');

  const addedDiff = diffs.find(d => d.entity_type === 'LINE' && d.field_name === 'line_added');
  assert.ok(addedDiff);
  assert.equal(addedDiff.new_value, '20');
});
