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

test('PO Revision Snapshotting & Cloning', async () => {
  const db = await setupTestDb();
  
  // Seed auth & customer & product
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U1', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U2', 'manager@example.com', 'MANAGER', 'ACTIVE', 'Manager Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Assigned Customer', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const repo = createPORepository(db);

  // 1. Create initial PO (creates draft Rev 0)
  const draftPo = await repo.createDraftPO({
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2026-08-31',
    customerPoNo: 'CUST-PO-111'
  }, 'U1');

  const poId = draftPo.header.po_id;
  const rev0Id = draftPo.revision.revision_id;

  // Verify that calling createNextRevision on a PO with an active DRAFT fails
  await assert.rejects(async () => {
    await repo.createNextRevision(poId, 'U1');
  }, (err) => {
    return err.code === 'PO_DRAFT_ALREADY_EXISTS' || err.message.toLowerCase().includes('draft already exists');
  }, 'Should reject if a DRAFT revision already exists');

  // Verify that calling createNextRevision on a PO with NO active revision (only DRAFT) fails
  // But wait! We have a DRAFT already, so we must clean it up or test on another PO.
  // Let's manually activate this PO in D1 to set it up for cloning
  // First, we add lines and documents to Rev 0
  db.prepare(`
    INSERT INTO po_revision_lines (
      line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id,
      contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
      packaging, container_type, loading_pattern
    ) VALUES (
      'L01', ?, 10, 'P1', 'STANDARD', 'SPEC-1',
      100.0, 10.0, 90.0, 110.0, 350.0, '/MT',
      'Jumbo Bag', '20GP', 'Palletized'
    )
  `).run(rev0Id);

  db.prepare(`
    INSERT INTO po_revision_documents (
      document_id, po_revision_id, document_type, label, url, created_by
    ) VALUES (
      'D01', ?, 'CUSTOMER_PO', 'Original PO PDF', 'https://drive.google.com/file/d/111', 'U1'
    )
  `).run(rev0Id);

  // Activate manually (updating statuses and pointers to mock activation)
  db.prepare("UPDATE po_revisions SET status = 'ACTIVE', approved_by = 'U2', approved_at = '2026-08-27T10:00:00Z', approval_note = 'Approved', revision_note = 'Rev 0' WHERE revision_id = ?").run(rev0Id);
  db.prepare("UPDATE po_headers SET current_active_revision_id = ?, current_draft_revision_id = NULL WHERE po_id = ?").run(rev0Id, poId);

  // Now, there is an ACTIVE revision and NO draft revision.
  // 2. Clone to create Rev 1
  const cloneRes = await repo.createNextRevision(poId, 'U1');
  assert.ok(cloneRes);
  assert.equal(cloneRes.po_id, poId);
  assert.equal(cloneRes.revision_no, 1);
  assert.equal(cloneRes.status, 'DRAFT');
  assert.equal(cloneRes.currency, 'USD');
  assert.equal(cloneRes.incoterm, 'FOB');
  assert.equal(cloneRes.customer_po_no, 'CUST-PO-111');
  
  // Verify reset fields
  assert.equal(cloneRes.approved_by, null);
  assert.equal(cloneRes.approved_at, null);
  assert.equal(cloneRes.approval_note, null);
  assert.equal(cloneRes.approval_summary_json, null);
  assert.equal(cloneRes.revision_note, null);
  assert.equal(cloneRes.created_by, 'U1');

  // Verify header has new current_draft_revision_id
  const updatedHeader = db.prepare("SELECT current_draft_revision_id, current_active_revision_id FROM po_headers WHERE po_id = ?").all(poId)[0];
  assert.equal(updatedHeader.current_draft_revision_id, cloneRes.revision_id);
  assert.equal(updatedHeader.current_active_revision_id, rev0Id);

  // Verify lines are snapshot-cloned
  const clonedLines = db.prepare("SELECT * FROM po_revision_lines WHERE po_revision_id = ?").all(cloneRes.revision_id);
  assert.equal(clonedLines.length, 1);
  assert.equal(clonedLines[0].line_no, 10);
  assert.equal(clonedLines[0].product_id, 'P1');
  assert.equal(clonedLines[0].contract_qty_mt, 100.0);
  assert.equal(clonedLines[0].previous_line_id, 'L01');

  // Verify documents are snapshot-cloned
  const clonedDocs = db.prepare("SELECT * FROM po_revision_documents WHERE po_revision_id = ?").all(cloneRes.revision_id);
  assert.equal(clonedDocs.length, 1);
  assert.equal(clonedDocs[0].document_type, 'CUSTOMER_PO');
  assert.equal(clonedDocs[0].label, 'Original PO PDF');
  assert.equal(clonedDocs[0].url, 'https://drive.google.com/file/d/111');
  assert.notEqual(clonedDocs[0].document_id, 'D01'); // should have a new UUID
});
