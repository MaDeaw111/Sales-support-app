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

test('PO Documents Links Management', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U1')").run();

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

  // 1. Create a document link
  const doc1 = await repo.createPORevisionDocument(revisionId, {
    documentType: 'AMENDMENT',
    label: 'Contract Amendment 1',
    url: 'https://example.com/docs/amend1.pdf'
  }, 'U1');

  assert.ok(doc1);
  assert.equal(doc1.document_type, 'AMENDMENT');
  assert.equal(doc1.label, 'Contract Amendment 1');
  assert.equal(doc1.url, 'https://example.com/docs/amend1.pdf');

  // Verify audit event for document creation
  const audit1 = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'DOCUMENT_ADDED'").all();
  assert.equal(audit1.length, 1);
  assert.equal(audit1[0].po_id, po.header.po_id);
  assert.equal(audit1[0].po_revision_id, revisionId);
  assert.equal(audit1[0].actor_id, 'U1');

  // 2. Enforces valid HTTP/HTTPS URL format
  await assert.rejects(async () => {
    await repo.createPORevisionDocument(revisionId, {
      documentType: 'OTHER',
      label: 'Invalid URL Doc',
      url: 'ftp://example.com/docs/invalid.pdf'
    }, 'U1');
  }, /invalid document url/i, 'Should reject non-http/https URL');

  // 3. Update the document link
  const updatedDoc = await repo.updatePORevisionDocument(doc1.document_id, {
    label: 'Updated Amendment Label',
    url: 'http://example.com/docs/amend1-updated.pdf'
  }, 'U1');

  assert.equal(updatedDoc.label, 'Updated Amendment Label');
  assert.equal(updatedDoc.url, 'http://example.com/docs/amend1-updated.pdf');

  // Verify audit event for update
  const audit2 = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'DOCUMENT_UPDATED'").all();
  assert.equal(audit2.length, 1);

  // 4. Evidence check helper logic
  // Only AMENDMENT exists, so evidence check should fail
  await assert.rejects(async () => {
    await repo.validateRevisionDocumentsForActivation(revisionId);
  }, (err) => {
    return err.code === 'PO_EVIDENCE_REQUIRED' || err.message.toLowerCase().includes('evidence');
  }, 'Should fail evidence check if only AMENDMENT exists');

  // Add CUSTOMER_PO evidence document
  const evidenceDoc = await repo.createPORevisionDocument(revisionId, {
    documentType: 'CUSTOMER_PO',
    label: 'Signed Customer PO',
    url: 'https://example.com/docs/po.pdf'
  }, 'U1');

  // Evidence check should pass now
  await repo.validateRevisionDocumentsForActivation(revisionId);

  // 5. Delete document link works
  await repo.deletePORevisionDocument(doc1.document_id, 'U1');
  const deletedDoc = db.prepare("SELECT * FROM po_revision_documents WHERE document_id = ?").all(doc1.document_id)[0] || null;
  assert.equal(deletedDoc, null);

  // Verify audit event for deletion
  const audit3 = db.prepare("SELECT * FROM po_audit_events WHERE event_type = 'DOCUMENT_REMOVED'").all();
  assert.equal(audit3.length, 1);

  // 6. Block modification on SUPERSEDED revisions
  // Mock revision status as SUPERSEDED
  db.prepare("UPDATE po_revisions SET status = 'SUPERSEDED' WHERE revision_id = ?").run(revisionId);

  await assert.rejects(async () => {
    await repo.createPORevisionDocument(revisionId, {
      documentType: 'EMAIL_CONFIRMATION',
      label: 'Email confirmation',
      url: 'https://example.com/email'
    }, 'U1');
  }, /superseded revision is immutable/i, 'Should block document creation on superseded revisions');

  await assert.rejects(async () => {
    await repo.updatePORevisionDocument(evidenceDoc.document_id, {
      label: 'Cannot update'
    }, 'U1');
  }, /superseded revision is immutable/i, 'Should block document updates on superseded revisions');

  await assert.rejects(async () => {
    await repo.deletePORevisionDocument(evidenceDoc.document_id, 'U1');
  }, /superseded revision is immutable/i, 'Should block document deletions on superseded revisions');
});
