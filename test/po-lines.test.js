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

test('PO Line Commercial Model and Tolerance Calculations', async () => {
  const db = await setupTestDb();
  
  // Seed references
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Assigned Customer', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P2', 'THP-70', 'Tapioca Pellet 70%', 'THP70', 'CAT1', 'FRM1')").run();

  const repo = createPORepository(db);

  // Create Draft PO
  const po = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'U1');

  const revisionId = po.revision.revision_id;

  // 1. Create a PO revision line in Draft status
  const lineDto1 = {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'SPEC-REV-1',
    contractQtyMt: 100.0,
    tolerancePct: 10.0,
    unitPrice: 350.0,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  };

  const line1 = await repo.createPORevisionLine(revisionId, lineDto1);
  assert.ok(line1);
  assert.equal(line1.line_no, 10);
  assert.equal(line1.product_id, 'P1');
  assert.equal(line1.contract_qty_mt, 100.0);
  assert.equal(line1.tolerance_pct, 10.0);
  assert.equal(line1.min_qty_mt, 90.0);
  assert.equal(line1.max_qty_mt, 110.0);
  assert.equal(line1.unit_price, 350.0);
  assert.equal(line1.price_unit, '/MT');

  // 2. Reject duplicate line_no within the same revision
  await assert.rejects(async () => {
    await repo.createPORevisionLine(revisionId, {
      lineNo: 10,
      productId: 'P2',
      specSource: 'STANDARD',
      specRevisionId: 'SPEC-REV-1',
      contractQtyMt: 200.0,
      tolerancePct: 5.0,
      unitPrice: 360.0,
      packaging: 'Jumbo Bag',
      containerType: '20GP',
      loadingPattern: 'Palletized'
    });
  }, (err) => {
    return err.code === 'PO_LINE_NUMBER_DUPLICATE' || err.message.toLowerCase().includes('duplicate line number');
  }, 'Should reject duplicate line number');

  // 3. Update the PO revision line
  const updatedLine = await repo.updatePORevisionLine(line1.line_id, {
    contractQtyMt: 150.0,
    tolerancePct: 5.0,
    unitPrice: 355.0
  });

  assert.equal(updatedLine.contract_qty_mt, 150.0);
  assert.equal(updatedLine.tolerance_pct, 5.0);
  assert.equal(updatedLine.min_qty_mt, 142.5);
  assert.equal(updatedLine.max_qty_mt, 157.5);
  assert.equal(updatedLine.unit_price, 355.0);

  // 4. Reject product replacement on an existing line
  await assert.rejects(async () => {
    await repo.updatePORevisionLine(line1.line_id, {
      productId: 'P2'
    });
  }, (err) => {
    return err.message.toLowerCase().includes('product cannot be replaced') || err.message.toLowerCase().includes('replacement');
  }, 'Should reject product replacement on existing line');

  // 5. Delete line works
  await repo.deletePORevisionLine(line1.line_id);
  const deletedQuery = db.prepare("SELECT * FROM po_revision_lines WHERE line_id = ?").all(line1.line_id)[0] || null;
  assert.equal(deletedQuery, null);

  // Re-insert line for active-immutable test
  const line2 = await repo.createPORevisionLine(revisionId, lineDto1);

  // 6. Test DRAFT status enforcement (Immutable revisions)
  // Mock revision status as ACTIVE
  db.prepare("UPDATE po_revisions SET status = 'ACTIVE' WHERE revision_id = ?").run(revisionId);

  // Try to create line on active revision -> should fail
  await assert.rejects(async () => {
    await repo.createPORevisionLine(revisionId, {
      lineNo: 20,
      productId: 'P2',
      specSource: 'STANDARD',
      specRevisionId: 'SPEC-REV-1',
      contractQtyMt: 50.0,
      tolerancePct: 0.0,
      unitPrice: 370.0,
      packaging: 'Jumbo Bag',
      containerType: '20GP',
      loadingPattern: 'Palletized'
    });
  }, (err) => {
    return err.code === 'PO_ACTIVE_IMMUTABLE' || err.message.toLowerCase().includes('immutable');
  }, 'Should reject adding a line to an active revision');

  // Try to update line on active revision -> should fail
  await assert.rejects(async () => {
    await repo.updatePORevisionLine(line2.line_id, {
      contractQtyMt: 200.0
    });
  }, (err) => {
    return err.code === 'PO_ACTIVE_IMMUTABLE' || err.message.toLowerCase().includes('immutable');
  }, 'Should reject updating a line in an active revision');

  // Try to delete line on active revision -> should fail
  await assert.rejects(async () => {
    await repo.deletePORevisionLine(line2.line_id);
  }, (err) => {
    return err.code === 'PO_ACTIVE_IMMUTABLE' || err.message.toLowerCase().includes('immutable');
  }, 'Should reject deleting a line in an active revision');
});
