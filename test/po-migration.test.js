import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

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

test('PO Management D1 migration constraints', async () => {
  const db = await setupTestDb();

  // Set up referenced records
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U2', 'manager@example.com', 'hash', 'salt', 'MANAGER', 'ACTIVE', 'Manager Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // 1. Validate manager_price_notes alteration - sales_user_id is now nullable
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N1', NULL, 'C1', 'P1', 'FOB', 350.0, 'U2')").run();
  }, 'manager_price_notes should allow NULL for sales_user_id');

  // Verify other constraints on manager_price_notes still hold (e.g. check on destination port for CFR/CIF)
  assert.throws(() => {
    db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N2', NULL, 'C1', 'P1', 'CFR', NULL, 350.0, 'U2')").run();
  }, /constraint failed/, 'manager_price_notes should reject CFR with NULL destination_port');

  // 2. Validate po_headers constraints
  // Correct insert
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO-2026-001', 'C1', 'U1')").run();

  // Header status check constraints (OPEN, PARTIALLY_SHIPPED, COMPLETED, CANCELLED)
  assert.throws(() => {
    db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO-2026-002', 'C1', 'INVALID', 'U1')").run();
  }, /constraint failed/, 'po_headers should reject invalid header_status');

  // 3. Validate po_revisions constraints
  // Correct insert
  db.prepare(`
    INSERT INTO po_revisions (
      revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot,
      sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end,
      valid_until, created_by
    ) VALUES (
      'REV1', 'PO-2026-001', 0, 'DRAFT', 'CUST-PO-123', 'ASSIGNED_SALES',
      'U1', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-08-31', 'U1'
    )
  `).run();

  // Invalid revision status (DRAFT, ACTIVE, SUPERSEDED)
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revisions (
        revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot,
        sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end,
        valid_until, created_by
      ) VALUES (
        'REV2', 'PO-2026-001', 1, 'INVALID_STATUS', 'CUST-PO-124', 'ASSIGNED_SALES',
        'U1', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-08-31', 'U1'
      )
    `).run();
  }, /constraint failed/, 'po_revisions should reject invalid status');

  // Delivery start > delivery end check constraint
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revisions (
        revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot,
        sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end,
        valid_until, created_by
      ) VALUES (
        'REV3', 'PO-2026-001', 1, 'DRAFT', 'CUST-PO-125', 'ASSIGNED_SALES',
        'U1', 'USD', 'FOB', '2026-10-01', '2026-09-30', '2026-08-31', 'U1'
      )
    `).run();
  }, /constraint failed/, 'po_revisions should reject delivery_start > delivery_end');

  // Unique PO + revision_no
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revisions (
        revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot,
        sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end,
        valid_until, created_by
      ) VALUES (
        'REV4', 'PO-2026-001', 0, 'DRAFT', 'CUST-PO-126', 'ASSIGNED_SALES',
        'U1', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-08-31', 'U1'
      )
    `).run();
  }, /unique constraint failed/i, 'po_revisions should reject duplicate (po_id, revision_no)');

  // 4. Validate po_revision_lines constraints
  // Correct insert
  db.prepare(`
    INSERT INTO po_revision_lines (
      line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id,
      contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
      packaging, container_type, loading_pattern
    ) VALUES (
      'LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC-REV-1',
      100.0, 10.0, 90.0, 110.0, 350.0, '/MT',
      'Jumbo Bag', '20GP', 'Palletized'
    )
  `).run();

  // Duplicate line_no within same revision
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revision_lines (
        line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id,
        contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
        packaging, container_type, loading_pattern
      ) VALUES (
        'LINE2', 'REV1', 10, 'P1', 'STANDARD', 'SPEC-REV-1',
        200.0, 10.0, 180.0, 220.0, 350.0, '/MT',
        'Jumbo Bag', '20GP', 'Palletized'
      )
    `).run();
  }, /unique constraint failed/i, 'po_revision_lines should reject duplicate line_no per revision');

  // Negative quantity check
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revision_lines (
        line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id,
        contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, price_unit,
        packaging, container_type, loading_pattern
      ) VALUES (
        'LINE3', 'REV1', 20, 'P1', 'STANDARD', 'SPEC-REV-1',
        -10.0, 10.0, -9.0, -11.0, 350.0, '/MT',
        'Jumbo Bag', '20GP', 'Palletized'
      )
    `).run();
  }, /constraint failed/, 'po_revision_lines should reject negative contract_qty_mt');

  // 5. Validate po_revision_documents constraints
  // Correct insert
  db.prepare(`
    INSERT INTO po_revision_documents (
      document_id, po_revision_id, document_type, label, url, created_by
    ) VALUES (
      'DOC1', 'REV1', 'CUSTOMER_PO', 'Client Purchase Order', 'https://drive.google.com/file/d/123', 'U1'
    )
  `).run();

  // Invalid document type
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revision_documents (
        document_id, po_revision_id, document_type, label, url, created_by
      ) VALUES (
        'DOC2', 'REV1', 'INVALID_DOC_TYPE', 'Client Purchase Order', 'https://drive.google.com/file/d/123', 'U1'
      )
    `).run();
  }, /constraint failed/, 'po_revision_documents should reject invalid document_type');

  // Invalid URL format (must start with http:// or https://)
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_revision_documents (
        document_id, po_revision_id, document_type, label, url, created_by
      ) VALUES (
        'DOC3', 'REV1', 'CUSTOMER_PO', 'Client Purchase Order', 'ftp://drive.google.com/file/d/123', 'U1'
      )
    `).run();
  }, /constraint failed/, 'po_revision_documents should reject invalid URL prefix');

  // 6. Validate po_audit_events constraints
  // Correct insert
  db.prepare(`
    INSERT INTO po_audit_events (
      event_id, po_id, po_revision_id, event_type, actor_id
    ) VALUES (
      'AUD1', 'PO-2026-001', 'REV1', 'PO_CREATED', 'U1'
    )
  `).run();

  // Invalid event type
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_audit_events (
        event_id, po_id, po_revision_id, event_type, actor_id
      ) VALUES (
        'AUD2', 'PO-2026-001', 'REV1', 'INVALID_EVENT', 'U1'
      )
    `).run();
  }, /constraint failed/, 'po_audit_events should reject invalid event_type');

  // 7. Validate po_field_diffs constraints
  // Correct insert
  db.prepare(`
    INSERT INTO po_field_diffs (
      diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value
    ) VALUES (
      'DIFF1', 'REV1', 'LINE', 'LINE1', 'contract_qty_mt', '100.0', '150.0'
    )
  `).run();

  // Invalid entity type
  assert.throws(() => {
    db.prepare(`
      INSERT INTO po_field_diffs (
        diff_id, po_revision_id, entity_type, entity_id, field_name, old_value, new_value
      ) VALUES (
        'DIFF2', 'REV1', 'INVALID_ENTITY', 'LINE1', 'contract_qty_mt', '100.0', '150.0'
      )
    `).run();
  }, /constraint failed/, 'po_field_diffs should reject invalid entity_type');
});
