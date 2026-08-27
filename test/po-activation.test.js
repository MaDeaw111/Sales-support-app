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

test('PO Revision Activation & Atomic Swapping', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('M1', 'manager@example.com', 'MANAGER', 'ACTIVE', 'Manager', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();
  
  // Seed Specs
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD1', 'P1', 'FEED_GRADE', 0, 'ARCHIVED', '2026-01-01')").run();
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD2', 'P1', 'FEED_GRADE', 1, 'ACTIVE', '2026-08-01')").run();
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD_DRAFT', 'P1', 'FEED_GRADE', 2, 'DRAFT', '2026-09-01')").run();

  const repo = createPORepository(db);

  // 1. Create a draft PO
  const po = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31' // Far in the future
  }, 'U1');

  const rev0Id = po.revision.revision_id;

  // Enforce validation: empty lines block
  await assert.rejects(async () => {
    await repo.activateRevision(rev0Id, 'M1', 'Approve Rev.0 empty');
  }, /at least one line/i);

  // Add line to Rev.0
  const line1 = await repo.createPORevisionLine(rev0Id, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD2',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });

  // Enforce validation: missing evidence document block
  await assert.rejects(async () => {
    await repo.activateRevision(rev0Id, 'M1', 'Approve Rev.0 no evidence');
  }, (err) => err.code === 'PO_EVIDENCE_REQUIRED');

  // Add evidence document
  await repo.createPORevisionDocument(rev0Id, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  // Activate Rev.0 should now succeed
  await repo.activateRevision(rev0Id, 'M1', 'Approve Rev.0');

  // Check state after Rev.0 activation
  const activeRev0 = db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").get(rev0Id);
  assert.equal(activeRev0.status, 'ACTIVE');
  assert.equal(activeRev0.approved_by, 'M1');
  assert.equal(activeRev0.approval_note, 'Approve Rev.0');
  assert.ok(activeRev0.approval_summary_json);

  const headerActive = db.prepare("SELECT * FROM po_headers WHERE po_id = ?").get(po.header.po_id);
  assert.equal(headerActive.current_active_revision_id, rev0Id);
  assert.equal(headerActive.current_draft_revision_id, null);

  // Legacy pos table check
  const legacyPo = db.prepare("SELECT * FROM pos WHERE po_id = ?").get(po.header.po_id);
  assert.ok(legacyPo);
  assert.equal(legacyPo.customer_id, 'C1');
  assert.equal(legacyPo.product_id, 'P1');
  assert.equal(legacyPo.status, 'ACTIVE');

  // Verify Audit Log
  const auditLogs = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'REVISION_ACTIVATED'").all();
  assert.equal(auditLogs.length, 1);
  assert.equal(auditLogs[0].po_revision_id, rev0Id);


  // 2. Clone to next draft revision (Rev.1)
  const rev1Draft = await repo.createNextRevision(po.header.po_id, 'U1');
  assert.equal(rev1Draft.revision_no, 1);
  assert.equal(rev1Draft.status, 'DRAFT');

  // Enforce validation: revision_note required for Rev.1+
  await assert.rejects(async () => {
    await repo.activateRevision(rev1Draft.revision_id, 'M1', 'Approve Rev.1 no revision note');
  }, (err) => err.code === 'PO_REVISION_NOTE_REQUIRED');

  // Update revision overview to add a revision note
  await repo.updateRevisionOverview(rev1Draft.revision_id, {
    revisionNote: 'Adding line item overrides'
  });

  // Activate Rev.1 should succeed and atomically swap status
  await repo.activateRevision(rev1Draft.revision_id, 'M1', 'Approve Rev.1');

  // Check state after Rev.1 activation
  const activeRev1 = db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").get(rev1Draft.revision_id);
  assert.equal(activeRev1.status, 'ACTIVE');
  assert.equal(activeRev1.approved_by, 'M1');

  const oldRev0 = db.prepare("SELECT * FROM po_revisions WHERE revision_id = ?").get(rev0Id);
  assert.equal(oldRev0.status, 'SUPERSEDED');

  const headerActive2 = db.prepare("SELECT * FROM po_headers WHERE po_id = ?").get(po.header.po_id);
  assert.equal(headerActive2.current_active_revision_id, rev1Draft.revision_id);

  // Check superseded audit event
  const supersededLog = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'REVISION_SUPERSEDED'").all();
  assert.equal(supersededLog.length, 1);
  assert.equal(supersededLog[0].po_revision_id, rev0Id);


  // 3. Expired valid_until block
  const poExpired = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2020-01-01' // Expired
  }, 'U1');

  const revExpiredId = poExpired.revision.revision_id;
  await repo.createPORevisionLine(revExpiredId, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD2',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  await repo.createPORevisionDocument(revExpiredId, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  await assert.rejects(async () => {
    await repo.activateRevision(revExpiredId, 'M1', 'Approve expired');
  }, (err) => err.code === 'PO_VALIDITY_EXPIRED');


  // 4. Draft Spec Activation Block
  const poDraftSpec = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const revDraftSpecId = poDraftSpec.revision.revision_id;
  await repo.createPORevisionLine(revDraftSpecId, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD_DRAFT', // Draft spec
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  await repo.createPORevisionDocument(revDraftSpecId, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  await assert.rejects(async () => {
    await repo.activateRevision(revDraftSpecId, 'M1', 'Approve draft spec');
  }, (err) => err.code === 'PO_SPEC_REQUIRED');


  // 5. Outdated Spec activation warns/logs SPEC_OLD_REVISION_CONFIRMED
  const poOutdatedSpec = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  }, 'U1');

  const revOutdatedSpecId = poOutdatedSpec.revision.revision_id;
  await repo.createPORevisionLine(revOutdatedSpecId, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD1', // Outdated spec (STD2 is active)
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  await repo.createPORevisionDocument(revOutdatedSpecId, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  }, 'U1');

  await repo.activateRevision(revOutdatedSpecId, 'M1', 'Approve outdated spec');
  
  const outdatedAuditLogs = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'SPEC_OLD_REVISION_CONFIRMED'").all();
  assert.equal(outdatedAuditLogs.length, 1);
  assert.equal(outdatedAuditLogs[0].po_revision_id, revOutdatedSpecId);
});
