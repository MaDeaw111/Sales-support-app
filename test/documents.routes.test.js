import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

function createMockR2Bucket() {
  const store = new Map();
  return {
    store,
    async put(key, value, options = {}) {
      const buf = value instanceof ArrayBuffer
        ? new Uint8Array(value).slice()
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
          : new TextEncoder().encode(String(value));
      store.set(key, {
        body: buf,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {}
      });
    },
    async get(key) {
      const item = store.get(key);
      if (!item) return null;
      return {
        body: item.body,
        httpMetadata: item.httpMetadata,
        customMetadata: item.customMetadata,
        async arrayBuffer() {
          return item.body.buffer.slice(item.body.byteOffset, item.body.byteOffset + item.body.byteLength);
        }
      };
    },
    async delete(key) {
      store.delete(key);
    }
  };
}

async function setupDocumentsTestEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql',
    '0008_logistics_partners.sql',
    '0009_commission_settlement.sql',
    '0010_booking_bl_no.sql',
    '0011_standard_price_history.sql',
    '0012_document_attachments.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  const wrappedDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        params: [],
        bind(...params) {
          this.params = params;
          return this;
        },
        async first() {
          return statement.all(...this.params)[0] || null;
        },
        async all() {
          return { results: statement.all(...this.params), success: true };
        },
        async run() {
          return { success: true, meta: statement.run(...this.params) };
        }
      };
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        const results = [];
        for (const st of statements) results.push(await st.run());
        db.exec('COMMIT');
        return results;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
  };

  const users = [
    ['U_ADMIN', 'ADMIN', 'tok-admin'],
    ['U_MANAGER', 'MANAGER', 'tok-manager'],
    ['U_SUPPORT', 'SALES_SUPPORT', 'tok-support'],
    ['U_EXPORT', 'EXPORT', 'tok-export'],
    ['U_WAREHOUSE', 'PRODUCTION_WAREHOUSE', 'tok-warehouse'],
    ['U_SALES1', 'EXTERNAL_SALES', 'tok-sales1'],
    ['U_SALES2', 'EXTERNAL_SALES', 'tok-sales2']
  ];
  for (const [userId, role, token] of users) {
    db.prepare(
      'INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(userId, `${role} User`, `${userId}@example.com`, role, role === 'EXTERNAL_SALES' ? 'OWN_CUSTOMERS' : 'ALL', 'hash', 'salt');
    db.prepare(
      'INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 3600_000).toISOString());
  }

  // Customers, Product, POs, DIs, Shipments, Invoices
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Owned Customer', 'U_SALES1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'Other Customer', 'U_SALES2', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo Bag', '40HC', 'Floor')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE2', 'REV2', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 400, 'Jumbo Bag', '40HC', 'Floor')").run();

  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'LINE1', 'P1', 20, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, bl_no, vessel, etd, actual_loading_date, all_ship_docs_drive_url, cash_received_amount, payment_status, payment_note, created_by) VALUES ('SHP-1', 'DI-1', 'DOCS_SENT', 'BK-001', 'BL-001', 'MV Pacific', '2026-11-15', '2026-11-12', 'https://drive.google.com/internal-secret', 0, 'UNPAID', 'Internal secret rate note', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-001', '2026-11-13', 'USD', 'FINAL', 1, 'tok1', 0, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-1', 'INV-1', 'LINE1', 20, 500, 'USD', 10000, 'U_EXPORT')").run();

  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C2', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, bl_no, vessel, etd, cash_received_amount, payment_status, created_by) VALUES ('SHP-2', 'DI-2', 'LOADED', 'BK-002', 'BL-002', 'MV Other', '2026-11-20', 0, 'UNPAID', 'U_EXPORT')").run();

  const bucket = createMockR2Bucket();
  const env = { DB: wrappedDb, DOCS_BUCKET: bucket };
  return { db, wrappedDb, bucket, env };
}

function authedRequest(path, token, init = {}) {
  const headers = new Headers(init.headers || {});
  if (token) headers.set('cookie', `wcat_session=${token}`);
  return new Request(`https://example.com${path}`, { ...init, headers });
}

function buildUploadForm({ entityType, entityId, docCategory, files }) {
  const form = new FormData();
  if (entityType !== undefined) form.append('entityType', entityType);
  if (entityId !== undefined) form.append('entityId', entityId);
  if (docCategory !== undefined) form.append('docCategory', docCategory);
  for (const f of files) {
    const fieldName = f.fieldName || 'files';
    const blob = new Blob([f.bytes || '%PDF-1.4 test content'], { type: f.type || 'application/pdf' });
    form.append(fieldName, blob, f.name || 'sample.pdf');
  }
  return form;
}

test('0012_document_attachments migration applies cleanly on 0001-0011 and enforces CHECK constraints', async () => {
  const { db } = await setupDocumentsTestEnv();

  // Valid insert succeeds
  db.prepare(`
    INSERT INTO document_attachments
      (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
    VALUES ('DOC-1', 'SHIPMENT', 'SHP-1', 'STUFFING_REPORT', 'stuffing.pdf', 'application/pdf', 1024, 'shipment/SHP-1/stuffing_report/DOC-1.pdf', 'U_EXPORT', '2026-11-15T10:00:00.000Z')
  `).run();

  // Invalid entity_type rejected
  assert.throws(() => {
    db.prepare(`
      INSERT INTO document_attachments
        (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
      VALUES ('DOC-BAD1', 'CUSTOMER', 'C1', 'PO', 'a.pdf', 'application/pdf', 100, 'k1', 'U_ADMIN', '2026-11-15T10:00:00.000Z')
    `).run();
  });

  // Invalid doc_category rejected
  assert.throws(() => {
    db.prepare(`
      INSERT INTO document_attachments
        (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
      VALUES ('DOC-BAD2', 'SHIPMENT', 'SHP-1', 'SECRET_FILE', 'a.pdf', 'application/pdf', 100, 'k2', 'U_ADMIN', '2026-11-15T10:00:00.000Z')
    `).run();
  });

  // Invalid content_type rejected
  assert.throws(() => {
    db.prepare(`
      INSERT INTO document_attachments
        (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
      VALUES ('DOC-BAD3', 'PO', 'PO1', 'PO', 'script.js', 'application/javascript', 100, 'k3', 'U_ADMIN', '2026-11-15T10:00:00.000Z')
    `).run();
  });

  // Over 10 MB file_size rejected
  assert.throws(() => {
    db.prepare(`
      INSERT INTO document_attachments
        (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
      VALUES ('DOC-BAD4', 'PO', 'PO1', 'PO', 'huge.pdf', 'application/pdf', 10485761, 'k4', 'U_ADMIN', '2026-11-15T10:00:00.000Z')
    `).run();
  });
});

test('worker returns graceful 503 when DOCS_BUCKET is unbound and 401 when unauthenticated', async () => {
  const { wrappedDb, env } = await setupDocumentsTestEnv();

  const unboundRes = await worker.fetch(
    authedRequest('/api/documents?entityType=SHIPMENT&entityId=SHP-1', 'tok-admin'),
    { DB: wrappedDb }
  );
  assert.equal(unboundRes.status, 503);
  const unboundBody = await unboundRes.json();
  assert.equal(unboundBody.status, 'ERROR');
  assert.match(unboundBody.message, /DOCS_BUCKET/i);

  const unauthRes = await worker.fetch(
    new Request('https://example.com/api/documents?entityType=SHIPMENT&entityId=SHP-1'),
    env
  );
  assert.equal(unauthRes.status, 401);

  const unauthShipRes = await worker.fetch(
    new Request('https://example.com/api/phase6/shipments'),
    env
  );
  assert.equal(unauthShipRes.status, 401);
});

test('upload validates allowed types, max 10 MB size, multi-file upload, inline preview, and attachment download', async () => {
  const { env, bucket } = await setupDocumentsTestEnv();

  // Reject unsupported MIME type (.txt)
  const badMimeRes = await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-export', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'STUFFING_REPORT',
        files: [{ name: 'notes.txt', type: 'text/plain', bytes: 'plain text' }]
      })
    }),
    env
  );
  assert.equal(badMimeRes.status, 400);

  // Reject > 10 MB file
  const oversizeBytes = new Uint8Array(10 * 1024 * 1024 + 1);
  const tooBigRes = await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-export', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'STUFFING_REPORT',
        files: [{ name: 'huge.pdf', type: 'application/pdf', bytes: oversizeBytes }]
      })
    }),
    env
  );
  assert.equal(tooBigRes.status, 400);
  assert.match((await tooBigRes.json()).message, /10 MB/i);

  // Reject category mismatch (PAYMENT_SLIP on SHIPMENT)
  const mismatchRes = await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-admin', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'PAYMENT_SLIP',
        files: [{ name: 'slip.png', type: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }]
      })
    }),
    env
  );
  assert.equal(mismatchRes.status, 400);

  // Multi-file upload (PDF + JPEG + PNG + WEBP)
  const uploadRes = await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-export', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'STUFFING_REPORT',
        files: [
          { name: 'stuffing_photo_1.jpg', type: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) },
          { name: 'stuffing_report.pdf', type: 'application/pdf', bytes: '%PDF-1.7 stuffing' },
          { name: 'seal.webp', type: 'image/webp', bytes: 'RIFFWEBP' }
        ]
      })
    }),
    env
  );
  assert.equal(uploadRes.status, 201);
  const uploadBody = await uploadRes.json();
  assert.equal(uploadBody.data.documents.length, 3);
  assert.equal(bucket.store.size, 3);

  const pdfDoc = uploadBody.data.documents.find((d) => d.file_name === 'stuffing_report.pdf');
  assert.ok(pdfDoc);

  // Preview (default -> Content-Disposition: inline)
  const previewRes = await worker.fetch(
    authedRequest(`/api/documents/${pdfDoc.id}/download`, 'tok-export'),
    env
  );
  assert.equal(previewRes.status, 200);
  assert.equal(previewRes.headers.get('content-type'), 'application/pdf');
  assert.match(previewRes.headers.get('content-disposition'), /^inline;/);
  assert.equal(await previewRes.text(), '%PDF-1.7 stuffing');

  // Force download (?download=1 -> Content-Disposition: attachment)
  const downloadRes = await worker.fetch(
    authedRequest(`/api/documents/${pdfDoc.id}/download?download=1`, 'tok-export'),
    env
  );
  assert.equal(downloadRes.status, 200);
  assert.match(downloadRes.headers.get('content-disposition'), /^attachment;/);
});

test('strict RBAC across EXTERNAL_SALES, PRODUCTION_WAREHOUSE, EXPORT, SALES_SUPPORT, MANAGER, and ADMIN', async () => {
  const { env, bucket } = await setupDocumentsTestEnv();

  // Seed all 5 categories across owned (PO1, SHP-1) and unowned (PO2, SHP-2)
  async function uploadAs(token, entityType, entityId, docCategory, name) {
    const res = await worker.fetch(
      authedRequest('/api/documents/upload', token, {
        method: 'POST',
        body: buildUploadForm({
          entityType,
          entityId,
          docCategory,
          files: [{ fieldName: 'file', name, type: 'application/pdf', bytes: `bytes:${name}` }]
        })
      }),
      env
    );
    return { status: res.status, body: await res.json() };
  }

  // ADMIN uploads PO1 (internal), SHP-1 DI, SHP-1 STUFFING_REPORT, SHP-1 ALL_SHIP_DOC, SHP-1 PAYMENT_SLIP, plus unowned PO2 & SHP-2 docs
  const adminPo1 = await uploadAs('tok-admin', 'PO', 'PO1', 'PO', 'admin_po1.pdf');
  assert.equal(adminPo1.status, 201);
  const di1 = await uploadAs('tok-export', 'SHIPMENT', 'SHP-1', 'DI', 'internal_di1.pdf');
  assert.equal(di1.status, 201);
  const stuffing1 = await uploadAs('tok-export', 'SHIPMENT', 'SHP-1', 'STUFFING_REPORT', 'stuffing1.pdf');
  assert.equal(stuffing1.status, 201);
  const allShip1 = await uploadAs('tok-export', 'SHIPMENT', 'SHP-1', 'ALL_SHIP_DOC', 'all_ship_doc1.pdf');
  assert.equal(allShip1.status, 201);
  const slip1 = await uploadAs('tok-support', 'PAYMENT', 'SHP-1', 'PAYMENT_SLIP', 'payment_slip1.pdf');
  assert.equal(slip1.status, 201);
  const po2 = await uploadAs('tok-manager', 'PO', 'PO2', 'PO', 'other_po2.pdf');
  assert.equal(po2.status, 201);
  const allShip2 = await uploadAs('tok-export', 'SHIPMENT', 'SHP-2', 'ALL_SHIP_DOC', 'other_all_ship2.pdf');
  assert.equal(allShip2.status, 201);

  // --- EXTERNAL_SALES (U_SALES1 owns C1 -> PO1, SHP-1; does NOT own C2 -> PO2, SHP-2) ---
  // 1) Can upload PO on owned PO1 and delete own uploaded PO doc, but cannot delete ADMIN's PO doc
  const salesPo1 = await uploadAs('tok-sales1', 'PO', 'PO1', 'PO', 'sales_po1.pdf');
  assert.equal(salesPo1.status, 201);
  const salesPo2 = await uploadAs('tok-sales1', 'PO', 'PO2', 'PO', 'unowned_po2.pdf');
  assert.equal(salesPo2.status, 403);

  const salesDelAdminPo = await worker.fetch(
    authedRequest(`/api/documents/${adminPo1.body.data.document.id}`, 'tok-sales1', { method: 'DELETE' }),
    env
  );
  assert.equal(salesDelAdminPo.status, 403);

  const salesDelOwnPo = await worker.fetch(
    authedRequest(`/api/documents/${salesPo1.body.data.document.id}`, 'tok-sales1', { method: 'DELETE' }),
    env
  );
  assert.equal(salesDelOwnPo.status, 200);
  assert.equal(bucket.store.size, 7);

  // 2) Can list & download STUFFING_REPORT and ALL_SHIP_DOC on owned SHP-1, and DI is completely excluded
  const salesShipListRes = await worker.fetch(
    authedRequest('/api/documents?entityType=SHIPMENT&entityId=SHP-1', 'tok-sales1'),
    env
  );
  assert.equal(salesShipListRes.status, 200);
  const salesShipDocs = (await salesShipListRes.json()).data.documents;
  assert.deepEqual(salesShipDocs.map((d) => d.doc_category).sort(), ['ALL_SHIP_DOC', 'STUFFING_REPORT']);
  assert.equal(salesShipDocs.every((d) => d.can_delete === false), true);

  // Also works via opaque 64-hex detail_ref from /api/delivery-instructions/workspace
  const wsRes = await worker.fetch(authedRequest('/api/delivery-instructions/workspace', 'tok-sales1'), env);
  assert.equal(wsRes.status, 200);
  const wsRow = (await wsRes.json()).data.deliveryInstructions[0];
  assert.equal(wsRow.customer_docs_count, 2);
  assert.equal(wsRow.stuffing_report_count, 1);
  assert.equal(wsRow.all_ship_doc_count, 1);

  const salesByRefRes = await worker.fetch(
    authedRequest(`/api/documents?entityType=SHIPMENT&entityId=${wsRow.detail_ref}`, 'tok-sales1'),
    env
  );
  assert.equal(salesByRefRes.status, 200);
  assert.equal((await salesByRefRes.json()).data.documents.length, 2);

  // Download STUFFING_REPORT & ALL_SHIP_DOC allowed
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${stuffing1.body.data.document.id}/download`, 'tok-sales1'), env)).status,
    200
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${allShip1.body.data.document.id}/download`, 'tok-sales1'), env)).status,
    200
  );

  // 3) Blocked (403) from DI, PAYMENT_SLIP, uploading/deleting shipment docs, and unowned SHP-2 / PO2
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=SHIPMENT&entityId=SHP-1&docCategory=DI', 'tok-sales1'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${di1.body.data.document.id}/download`, 'tok-sales1'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=PAYMENT&entityId=SHP-1', 'tok-sales1'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${slip1.body.data.document.id}/download`, 'tok-sales1'), env)).status,
    403
  );
  assert.equal((await uploadAs('tok-sales1', 'SHIPMENT', 'SHP-1', 'STUFFING_REPORT', 'nope.pdf')).status, 403);
  assert.equal((await uploadAs('tok-sales1', 'PAYMENT', 'SHP-1', 'PAYMENT_SLIP', 'nope.pdf')).status, 403);
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${allShip1.body.data.document.id}`, 'tok-sales1', { method: 'DELETE' }), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=SHIPMENT&entityId=SHP-2', 'tok-sales1'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${allShip2.body.data.document.id}/download`, 'tok-sales1'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=PO&entityId=PO2', 'tok-sales1'), env)).status,
    403
  );

  // --- PRODUCTION_WAREHOUSE ---
  // Can ONLY list/download DI on SHIPMENT; 403 on PO, STUFFING_REPORT, ALL_SHIP_DOC, PAYMENT_SLIP, upload, delete
  const whShipRes = await worker.fetch(
    authedRequest('/api/documents?entityType=SHIPMENT&entityId=SHP-1', 'tok-warehouse'),
    env
  );
  assert.equal(whShipRes.status, 200);
  const whDocs = (await whShipRes.json()).data.documents;
  assert.deepEqual(whDocs.map((d) => d.doc_category), ['DI']);

  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${di1.body.data.document.id}/download`, 'tok-warehouse'), env)).status,
    200
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${stuffing1.body.data.document.id}/download`, 'tok-warehouse'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${allShip1.body.data.document.id}/download`, 'tok-warehouse'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=PO&entityId=PO1', 'tok-warehouse'), env)).status,
    403
  );
  assert.equal(
    (await worker.fetch(authedRequest('/api/documents?entityType=PAYMENT&entityId=SHP-1', 'tok-warehouse'), env)).status,
    403
  );
  assert.equal((await uploadAs('tok-warehouse', 'SHIPMENT', 'SHP-1', 'DI', 'wh_di.pdf')).status, 403);
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${di1.body.data.document.id}`, 'tok-warehouse', { method: 'DELETE' }), env)).status,
    403
  );

  // --- EXPORT ---
  // Can read/download PO and PAYMENT_SLIP, but cannot upload or delete PO/PAYMENT_SLIP
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${adminPo1.body.data.document.id}/download`, 'tok-export'), env)).status,
    200
  );
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${slip1.body.data.document.id}/download`, 'tok-export'), env)).status,
    200
  );
  assert.equal((await uploadAs('tok-export', 'PO', 'PO1', 'PO', 'exp_po.pdf')).status, 403);
  assert.equal((await uploadAs('tok-export', 'PAYMENT', 'SHP-1', 'PAYMENT_SLIP', 'exp_slip.pdf')).status, 403);
  assert.equal(
    (await worker.fetch(authedRequest(`/api/documents/${slip1.body.data.document.id}`, 'tok-export', { method: 'DELETE' }), env)).status,
    403
  );
  // EXPORT can delete SHIPMENT doc
  const exportDelDi = await worker.fetch(
    authedRequest(`/api/documents/${di1.body.data.document.id}`, 'tok-export', { method: 'DELETE' }),
    env
  );
  assert.equal(exportDelDi.status, 200);
  assert.equal(bucket.store.size, 6);
});

test('GET /api/phase6/shipments & :id enforces customer-scoped read-only projection for EXTERNAL_SALES and masks internal costs', async () => {
  const { env } = await setupDocumentsTestEnv();

  // Upload Stuffing Report & All Ship Doc on SHP-1
  await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-export', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'STUFFING_REPORT',
        files: [{ name: 'stf.pdf', type: 'application/pdf', bytes: '%PDF stuffing' }]
      })
    }),
    env
  );
  await worker.fetch(
    authedRequest('/api/documents/upload', 'tok-export', {
      method: 'POST',
      body: buildUploadForm({
        entityType: 'SHIPMENT',
        entityId: 'SHP-1',
        docCategory: 'ALL_SHIP_DOC',
        files: [{ name: 'all_docs.pdf', type: 'application/pdf', bytes: '%PDF all ship docs' }]
      })
    }),
    env
  );

  // EXTERNAL_SALES list only contains owned SHP-1 with doc counts and masked internal fields
  const salesListRes = await worker.fetch(authedRequest('/api/phase6/shipments', 'tok-sales1'), env);
  assert.equal(salesListRes.status, 200);
  const salesShipments = (await salesListRes.json()).data.shipments;
  assert.equal(salesShipments.length, 1);
  assert.equal(salesShipments[0].shipment_id, 'SHP-1');
  assert.equal(salesShipments[0].customer_docs_count, 2);
  assert.equal(salesShipments[0].stuffing_report_count, 1);
  assert.equal(salesShipments[0].all_ship_doc_count, 1);
  assert.equal('payment_note' in salesShipments[0], false);
  assert.equal('cash_received_amount' in salesShipments[0], false);
  assert.equal('forwarder_partner_id' in salesShipments[0], false);
  assert.equal('all_ship_docs_drive_url' in salesShipments[0], false);

  // EXTERNAL_SALES detail on owned SHP-1 succeeds and masks internal fields
  const salesDetailRes = await worker.fetch(authedRequest('/api/phase6/shipments/SHP-1', 'tok-sales1'), env);
  assert.equal(salesDetailRes.status, 200);
  const salesDetail = (await salesDetailRes.json()).data.shipment;
  assert.equal(salesDetail.shipment_id, 'SHP-1');
  assert.equal(salesDetail.customer_docs_count, 2);
  assert.equal('payment_note' in salesDetail, false);
  assert.equal('cash_received_amount' in salesDetail, false);

  // EXTERNAL_SALES detail on unowned SHP-2 returns 403
  const salesUnownedRes = await worker.fetch(authedRequest('/api/phase6/shipments/SHP-2', 'tok-sales1'), env);
  assert.equal(salesUnownedRes.status, 403);

  // ADMIN sees both shipments including internal fields
  const adminListRes = await worker.fetch(authedRequest('/api/phase6/shipments', 'tok-admin'), env);
  assert.equal(adminListRes.status, 200);
  assert.equal((await adminListRes.json()).data.shipments.length, 2);
});

test('GET /api/payments and /api/payments/:id include earliest all_ship_doc_uploaded_at and payment_slip_count', async () => {
  const { db, env } = await setupDocumentsTestEnv();

  // Seed two ALL_SHIP_DOC uploads with different timestamps to verify earliest is picked
  db.prepare(`
    INSERT INTO document_attachments
      (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by, uploaded_at)
    VALUES
      ('DOC-A1', 'SHIPMENT', 'SHP-1', 'ALL_SHIP_DOC', 'first.pdf', 'application/pdf', 100, 'k-a1', 'U_EXPORT', '2026-11-10T08:00:00.000Z'),
      ('DOC-A2', 'SHIPMENT', 'SHP-1', 'ALL_SHIP_DOC', 'second.pdf', 'application/pdf', 100, 'k-a2', 'U_EXPORT', '2026-11-12T08:00:00.000Z'),
      ('DOC-P1', 'PAYMENT', 'SHP-1', 'PAYMENT_SLIP', 'slip.jpg', 'image/jpeg', 200, 'k-p1', 'U_SUPPORT', '2026-11-15T08:00:00.000Z')
  `).run();

  const listRes = await worker.fetch(authedRequest('/api/payments', 'tok-admin'), env);
  assert.equal(listRes.status, 200);
  const paymentRow = (await listRes.json()).data.items.find((p) => p.shipment_id === 'SHP-1');
  assert.ok(paymentRow);
  assert.equal(paymentRow.all_ship_doc_uploaded_at, '2026-11-10T08:00:00.000Z');
  assert.equal(paymentRow.payment_slip_count, 1);

  const detailRes = await worker.fetch(authedRequest('/api/payments/SHP-1', 'tok-admin'), env);
  assert.equal(detailRes.status, 200);
  const paymentDetail = (await detailRes.json()).data.shipment;
  assert.equal(paymentDetail.all_ship_doc_uploaded_at, '2026-11-10T08:00:00.000Z');
  assert.equal(paymentDetail.payment_slip_count, 1);
});
