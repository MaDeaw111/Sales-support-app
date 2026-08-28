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

test('PO Product Spec Resolution Logic', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Assigned Customer', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P2', 'THP-70', 'Tapioca Pellet 70%', 'THP70', 'CAT1', 'FRM1')").run();
  
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P2', 'FEED_GRADE')").run();

  // Seed Standard Specs
  // STD1: P1 active but superseded (outdated)
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD1', 'P1', 'FEED_GRADE', 0, 'ARCHIVED', '2026-01-01')").run();
  // STD2: P1 current active
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD2', 'P1', 'FEED_GRADE', 1, 'ACTIVE', '2026-08-01')").run();
  // STD3: P1 draft (invalid for activation)
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD3', 'P1', 'FEED_GRADE', 2, 'DRAFT', '2026-09-01')").run();
  // STD4: P2 active
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD4', 'P2', 'FEED_GRADE', 0, 'ACTIVE', '2026-01-01')").run();

  // Seed Customer Specs
  // CST1: Customer spec outdated (active standard spec STD2 exists, but CST1 is linked to STD1 and status is ARCHIVED)
  db.prepare("INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date) VALUES ('CST1', 'C1', 'P1', 'FEED_GRADE', 'STD1', 0, 'ARCHIVED', '2026-01-01')").run();
  // CST2: Customer spec active
  db.prepare("INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date) VALUES ('CST2', 'C1', 'P1', 'FEED_GRADE', 'STD2', 1, 'ACTIVE', '2026-08-01')").run();
  // CST3: Customer spec draft
  db.prepare("INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date) VALUES ('CST3', 'C1', 'P1', 'FEED_GRADE', 'STD2', 2, 'DRAFT', '2026-09-01')").run();

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

  // 1. Rejects invalid spec reference
  await assert.rejects(async () => {
    await repo.createPORevisionLine(revisionId, {
      lineNo: 10,
      productId: 'P1',
      specSource: 'STANDARD',
      specRevisionId: 'STD_NONEXISTENT',
      contractQtyMt: 100,
      tolerancePct: 10,
      unitPrice: 350,
      packaging: 'Jumbo Bag',
      containerType: '20GP',
      loadingPattern: 'Palletized'
    });
  }, /specification not found/i, 'Should reject non-existent spec ID');

  // 2. Rejects product/spec product_id mismatch (e.g. line has product P1, but spec references product P2)
  await assert.rejects(async () => {
    await repo.createPORevisionLine(revisionId, {
      lineNo: 10,
      productId: 'P1',
      specSource: 'STANDARD',
      specRevisionId: 'STD4', // STD4 is for product P2
      contractQtyMt: 100,
      tolerancePct: 10,
      unitPrice: 350,
      packaging: 'Jumbo Bag',
      containerType: '20GP',
      loadingPattern: 'Palletized'
    });
  }, /product spec mismatch/i, 'Should reject spec with mismatched product ID');

  // 3. Verify custom spec overrides (spec_override_json) storage and retrieval
  const overrideObj = { moisture: 'max 14%', starch: 'min 85%' };
  const line = await repo.createPORevisionLine(revisionId, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD2',
    specOverrideJson: overrideObj,
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  assert.ok(line);
  assert.equal(line.spec_override_json, JSON.stringify(overrideObj));

  // 4. Activation check: Rejects activation if a line references a DRAFT spec
  // Update line to reference draft standard spec (STD3)
  const lineDraftSpec = await repo.updatePORevisionLine(line.line_id, {
    specRevisionId: 'STD3'
  });
  assert.equal(lineDraftSpec.spec_revision_id, 'STD3');

  // Helper validation check for activation should throw PO_SPEC_REQUIRED
  await assert.rejects(async () => {
    await repo.validateRevisionSpecsForActivation(revisionId);
  }, (err) => {
    return err.code === 'PO_SPEC_REQUIRED' || err.message.toLowerCase().includes('draft spec not allowed');
  }, 'Should block activation on draft standard specs');

  // Update line to reference draft customer spec (CST3)
  await repo.updatePORevisionLine(line.line_id, {
    specSource: 'CUSTOMER',
    specRevisionId: 'CST3'
  });

  await assert.rejects(async () => {
    await repo.validateRevisionSpecsForActivation(revisionId);
  }, (err) => {
    return err.code === 'PO_SPEC_REQUIRED' || err.message.toLowerCase().includes('draft spec not allowed');
  }, 'Should block activation on draft customer specs');

  // 5. Verification check detects outdated specs correctly
  // Update line to reference outdated standard spec (STD1)
  await repo.updatePORevisionLine(line.line_id, {
    specSource: 'STANDARD',
    specRevisionId: 'STD1'
  });

  const check1 = await repo.validateRevisionSpecsForActivation(revisionId);
  assert.equal(check1.hasOutdated, true);
  assert.equal(check1.outdatedSpecs.length, 1);
  assert.equal(check1.outdatedSpecs[0].line_id, line.line_id);
  assert.equal(check1.outdatedSpecs[0].spec_revision_id, 'STD1');

  // Update line to reference outdated customer spec (CST1)
  await repo.updatePORevisionLine(line.line_id, {
    specSource: 'CUSTOMER',
    specRevisionId: 'CST1'
  });

  const check2 = await repo.validateRevisionSpecsForActivation(revisionId);
  assert.equal(check2.hasOutdated, true);
  assert.equal(check2.outdatedSpecs.length, 1);
  assert.equal(check2.outdatedSpecs[0].spec_revision_id, 'CST1');

  // Update line to current active customer spec (CST2)
  await repo.updatePORevisionLine(line.line_id, {
    specSource: 'CUSTOMER',
    specRevisionId: 'CST2'
  });

  const check3 = await repo.validateRevisionSpecsForActivation(revisionId);
  assert.equal(check3.hasOutdated, false);
  assert.equal(check3.outdatedSpecs.length, 0);
});

test('PO Spec Resolution - Outdated Spec Keep Old & Update Latest Flow', async () => {
  const db = await setupTestDb();
  
  // Seed basic data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Assigned Customer', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();

  // STD_OLD: archived standard spec
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD_OLD', 'P1', 'FEED_GRADE', 1, 'ARCHIVED', '2026-01-01')").run();
  // STD_NEW: active standard spec
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD_NEW', 'P1', 'FEED_GRADE', 2, 'ACTIVE', '2026-08-01')").run();

  // Create document in database so we satisfy evidence rule
  const repo = createPORepository(db);
  const po = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const poId = po.header.po_id;
  const revisionId = po.revision.revision_id;

  // Add document
  await repo.createPORevisionDocument(revisionId, {
    documentType: 'CUSTOMER_PO',
    label: 'PO Doc',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  // Add line referencing STD_OLD (archived/outdated)
  const line = await repo.createPORevisionLine(revisionId, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD_OLD',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  }, 'U1');

  // 1. Outdated review returns selected + latest IDs
  const review = await repo.getPORevisionReview(revisionId);
  assert.equal(review.hasOutdatedSpecs, true);
  assert.equal(review.outdatedSpecs.length, 1);
  const out = review.outdatedSpecs[0];
  assert.equal(out.lineId, line.line_id);
  assert.equal(out.specSource, 'STANDARD');
  assert.equal(out.selectedSpecRevisionId, 'STD_OLD');
  assert.equal(out.latestActiveSpecRevisionId, 'STD_NEW');

  // 2. Outdated spec without confirmation blocks activation (throws PO_SPEC_OUTDATED)
  await assert.rejects(async () => {
    await repo.activateRevision(revisionId, 'U1', 'activation note', []);
  }, (err) => {
    return err.code === 'PO_SPEC_OUTDATED' && err.details.length === 1;
  });

  // 3. Keep Old explicit confirmation allows activation + logs audit event SPEC_OLD_REVISION_CONFIRMED
  await repo.activateRevision(revisionId, 'U1', 'activation note', [line.line_id]);

  const auditEvents = db.prepare("SELECT event_type, metadata_json FROM po_audit_events WHERE event_type = 'SPEC_OLD_REVISION_CONFIRMED'").all();
  assert.equal(auditEvents.length, 1);
  const metadata = JSON.parse(auditEvents[0].metadata_json);
  assert.equal(metadata.line_id, line.line_id);
  assert.equal(metadata.spec_revision_id, 'STD_OLD');

  // Let's create another draft to test Choice B (Update Latest)
  const po2 = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');
  const revId2 = po2.revision.revision_id;

  const line2 = await repo.createPORevisionLine(revId2, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD_OLD',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  }, 'U1');

  // 4. Update Latest changes Draft line
  const review2 = await repo.getPORevisionReview(revId2);
  const latestSpecId = review2.outdatedSpecs[0].latestActiveSpecRevisionId;
  assert.equal(latestSpecId, 'STD_NEW');

  await repo.updatePORevisionLine(line2.line_id, {
    specRevisionId: latestSpecId
  });

  // 5. After update, review no longer reports that line as outdated
  const reviewPostUpdate = await repo.getPORevisionReview(revId2);
  assert.equal(reviewPostUpdate.hasOutdatedSpecs, false);
  assert.equal(reviewPostUpdate.outdatedSpecs.length, 0);

  // 6. Draft Spec always blocked (cannot activate, throws PO_SPEC_REQUIRED or similar)
  // Let's change standard specs so STD_NEW status is DRAFT
  db.prepare("UPDATE standard_specs SET status = 'DRAFT' WHERE standard_spec_id = 'STD_NEW'").run();
  
  await assert.rejects(async () => {
    await repo.validateRevisionSpecsForActivation(revId2);
  }, (err) => err.code === 'PO_SPEC_REQUIRED');

  // Restore STD_NEW to ACTIVE
  db.prepare("UPDATE standard_specs SET status = 'ACTIVE' WHERE standard_spec_id = 'STD_NEW'").run();

  // 7. No valid Active Spec blocks activation (even if Keep Old confirmation is passed)
  // Let's archive STD_NEW so no active specs exist
  db.prepare("UPDATE standard_specs SET status = 'ARCHIVED' WHERE standard_spec_id = 'STD_NEW'").run();
  
  // Set line2 to STD_OLD (archived)
  await repo.updatePORevisionLine(line2.line_id, {
    specRevisionId: 'STD_OLD'
  });

  // Since latest Active does not exist, activating even with confirmation must throw PO_SPEC_REQUIRED
  await assert.rejects(async () => {
    await repo.activateRevision(revId2, 'U1', 'activation note', [line2.line_id]);
  }, (err) => {
    return err.code === 'PO_SPEC_REQUIRED';
  });
});
