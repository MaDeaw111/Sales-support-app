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

test('PO Cancellation and Hard Delete Controls', async () => {
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

  // --- HARD DELETE Tests ---
  // Create a draft PO
  const poDraft = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const draftPoId = poDraft.header.po_id;
  const draftRevId = poDraft.revision.revision_id;

  // Add a line and a document
  const lineDraft = await repo.createPORevisionLine(draftRevId, {
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

  await repo.createPORevisionDocument(draftRevId, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  // Hard delete should work for Draft PO
  await repo.deleteDraftPO(draftPoId);

  // Verify deletion cascaded
  const headerCheck = db.prepare("SELECT * FROM po_headers WHERE po_id = ?").get(draftPoId);
  assert.equal(headerCheck, undefined);
  const revCheck = db.prepare("SELECT * FROM po_revisions WHERE po_id = ?").all(draftPoId);
  assert.equal(revCheck.length, 0);
  const linesCheck = db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").all(draftRevId);
  assert.equal(linesCheck.length, 0);


  // --- DELETE PROTECTION Tests ---
  // Create another draft PO and activate it
  const poActive = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const activePoId = poActive.header.po_id;
  const activeRevId = poActive.revision.revision_id;

  await repo.createPORevisionLine(activeRevId, {
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

  await repo.createPORevisionDocument(activeRevId, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  await repo.activateRevision(activeRevId, 'M1', 'Approve PO');

  // Deletion must be blocked on activated PO
  await assert.rejects(async () => {
    await repo.deleteDraftPO(activePoId);
  }, (err) => err.code === 'PO_ACTIVE_IMMUTABLE');


  // --- CANCELLATION Tests ---
  // Cancellation requires reason
  await assert.rejects(async () => {
    await repo.cancelPO(activePoId, 'M1', '');
  }, /cancellation reason is required/i);

  // Cancel PO
  await repo.cancelPO(activePoId, 'M1', 'Customer cancelled the deal');

  // Verify status shifted
  const headerCancelled = db.prepare("SELECT * FROM po_headers WHERE po_id = ?").get(activePoId);
  assert.equal(headerCancelled.header_status, 'CANCELLED');
  assert.equal(headerCancelled.cancelled_by, 'M1');
  assert.equal(headerCancelled.cancellation_reason, 'Customer cancelled the deal');
  assert.ok(headerCancelled.cancelled_at);

  // Verify PO_CANCELLED event logged
  const auditCancel = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'PO_CANCELLED'").all();
  assert.equal(auditCancel.length, 1);
  assert.equal(auditCancel[0].po_id, activePoId);
  assert.equal(auditCancel[0].actor_id, 'M1');


  // --- TERMINAL STATE constraint tests ---
  // Once cancelled, any edits should throw PO_ALREADY_CANCELLED
  await assert.rejects(async () => {
    await repo.createNextRevision(activePoId, 'U1');
  }, (err) => err.code === 'PO_ALREADY_CANCELLED', 'Should block revision cloning');

  await assert.rejects(async () => {
    await repo.updateRevisionOverview(activeRevId, {
      buyerReference: 'New Ref'
    });
  }, (err) => err.code === 'PO_ALREADY_CANCELLED', 'Should block overview updates');

  await assert.rejects(async () => {
    await repo.createPORevisionLine(activeRevId, {
      lineNo: 20,
      productId: 'P1',
      specSource: 'STANDARD',
      specRevisionId: 'STD1',
      contractQtyMt: 50,
      tolerancePct: 0,
      unitPrice: 350
    });
  }, (err) => err.code === 'PO_ALREADY_CANCELLED', 'Should block line creation');
});
