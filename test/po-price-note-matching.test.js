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

test('PO Line Manager Price Note Matching', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('USR_SALES', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Assigned Customer', 'USR_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C2', 'CUST2', 'House Customer', NULL)").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('SPEC1', 'P1', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-27')").run();

  // Seed Manager Price Notes
  // 1. Matched note for ASSIGNED_SALES
  db.prepare(`
    INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id)
    VALUES ('NOTE_ASSIGNED', 'USR_SALES', 'C1', 'P1', 'FOB', 350.00, 'USR_SALES')
  `).run();

  // 2. Matched note for HOUSE_ACCOUNT
  db.prepare(`
    INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id)
    VALUES ('NOTE_HOUSE', NULL, 'C2', 'P1', 'FOB', 340.00, 'USR_SALES')
  `).run();

  const repo = createPORepository(db);

  // --- ASSIGNED_SALES Test ---
  const po1 = await repo.createDraftPO({
    customerId: 'C1',
    ownershipType: 'ASSIGNED_SALES',
    salesOwnerUserId: 'USR_SALES',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'USR_SALES');

  // Should automatically match NOTE_ASSIGNED (suggested price 350.00)
  // Check that creating line with unit price 350.00 works without priceOverrideReason
  const line1 = await repo.createPORevisionLine(po1.revision.revision_id, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'SPEC1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  
  assert.equal(line1.suggested_price, 350.00);
  assert.equal(line1.source_price_note_id, 'NOTE_ASSIGNED');

  // Check that creating line with unit price 360.00 fails if priceOverrideReason is empty/missing
  await assert.rejects(async () => {
    await repo.createPORevisionLine(po1.revision.revision_id, {
      lineNo: 20,
      productId: 'P1',
      specSource: 'STANDARD',
      specRevisionId: 'SPEC1',
      contractQtyMt: 100,
      tolerancePct: 10,
      unitPrice: 360.00,
      packaging: 'Jumbo Bag',
      containerType: '20GP',
      loadingPattern: 'Palletized'
    });
  }, (err) => {
    return err.code === 'PO_PRICE_OVERRIDE_REASON_REQUIRED' || err.message.includes('override reason');
  }, 'Should require price override reason when price differs from suggested price');

  // Check that creating line with unit price 360.00 works when priceOverrideReason is supplied
  const line2 = await repo.createPORevisionLine(po1.revision.revision_id, {
    lineNo: 20,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'SPEC1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 360.00,
    priceOverrideReason: 'Special negotiated deal',
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  assert.equal(line2.suggested_price, 350.00);
  assert.equal(line2.unit_price, 360.00);
  assert.equal(line2.price_override_reason, 'Special negotiated deal');


  // --- HOUSE_ACCOUNT Test ---
  const po2 = await repo.createDraftPO({
    customerId: 'C2',
    ownershipType: 'HOUSE_ACCOUNT',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'USR_SALES');

  // Should automatically match NOTE_HOUSE (suggested price 340.00)
  const line3 = await repo.createPORevisionLine(po2.revision.revision_id, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'SPEC1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 340.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  assert.equal(line3.suggested_price, 340.00);
  assert.equal(line3.source_price_note_id, 'NOTE_HOUSE');


  // --- NO MATCH Test ---
  // Create PO with non-matching incoterm CIF
  const po3 = await repo.createDraftPO({
    customerId: 'C1',
    ownershipType: 'HOUSE_ACCOUNT',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'CIF',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31'
  }, 'USR_SALES');

  // Should not match any notes
  const line4 = await repo.createPORevisionLine(po3.revision.revision_id, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'SPEC1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 500.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  assert.equal(line4.suggested_price, null);
  assert.equal(line4.source_price_note_id, null);
  assert.equal(line4.unit_price, 500.00);


  // --- Line Update Matching & Override check ---
  // Update line4 price to a new value (still no match, so should work fine)
  const updated1 = await repo.updatePORevisionLine(line4.line_id, {
    unitPrice: 480.00
  });
  assert.equal(updated1.suggested_price, null);
  assert.equal(updated1.unit_price, 480.00);

  // Update line1 price to 370.00 (which has suggested price 350.00) without reason -> should fail
  await assert.rejects(async () => {
    await repo.updatePORevisionLine(line1.line_id, {
      unitPrice: 370.00
    });
  }, (err) => {
    return err.code === 'PO_PRICE_OVERRIDE_REASON_REQUIRED' || err.message.includes('override reason');
  }, 'Should require price override reason on update');

  // Update line1 price with reason -> should work
  const updated2 = await repo.updatePORevisionLine(line1.line_id, {
    unitPrice: 370.00,
    priceOverrideReason: 'Approved by manager'
  });
  assert.equal(updated2.unit_price, 370.00);
  assert.equal(updated2.price_override_reason, 'Approved by manager');
});
