import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

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

  const wrappedDb = {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        _params: [],
        bind(...args) {
          this._params = args;
          return this;
        },
        async first() {
          const rows = stmt.all(...this._params);
          return rows[0] || null;
        },
        async run() {
          const res = stmt.run(...this._params);
          return { success: true, meta: res };
        },
        async all() {
          const rows = stmt.all(...this._params);
          return { results: rows, success: true };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    }
  };

  return { db, wrappedDb };
}

async function seedUserAndSession(db, userId, name, email, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, email, role, 'ALL', 'hash', 'salt');

  const tokenHash = await hashSessionToken(token);
  const expires = new Date(Date.now() + 1000000).toISOString();
  
  db.prepare(`
    INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(`SES-${userId}`, userId, tokenHash, expires);
}

function makeRequest(path, method = 'GET', body = null, token = null) {
  const headers = {};
  if (token) {
    headers['cookie'] = `wcat_session=${token}`;
  }
  if (body) {
    headers['content-type'] = 'application/json';
  }
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
}

test('POST /api/shipments/:id/documents: validation and retrieval', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'Mgr', 'mgr@example.com', 'MANAGER', 'token-mgr');

  // Seed customer, product, po, shipment
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, po_date, status) VALUES ('PO1', 'C1', 'P1', 'FOB', '2026-08-26', 'ACTIVE')").run();
  db.prepare("INSERT INTO shipments (shipment_id, po_id, is_one_container) VALUES ('SH1', 'PO1', 1)").run();

  const payload = {
    documentType: 'PO',
    title: 'Signed PO Scan',
    driveUrl: 'https://drive.google.com/file/d/123/view',
    referenceNo: 'REF-PO'
  };

  // 1. Unauthenticated gets 401
  const reqUnauth = makeRequest('/api/shipments/SH1/documents', 'POST', payload);
  const resUnauth = await worker.fetch(reqUnauth, { DB: wrappedDb });
  assert.equal(resUnauth.status, 401);

  // 2. Authenticated MANAGER can create
  const reqMgr = makeRequest('/api/shipments/SH1/documents', 'POST', payload, 'token-mgr');
  const resMgr = await worker.fetch(reqMgr, { DB: wrappedDb });
  assert.equal(resMgr.status, 200);

  const dataMgr = await resMgr.json();
  assert.equal(dataMgr.status, 'SUCCESS');
  assert.equal(dataMgr.data.documentLink.title, 'Signed PO Scan');

  // 3. GET lists documents
  const reqGet = makeRequest('/api/shipments/SH1/documents', 'GET', null, 'token-mgr');
  const resGet = await worker.fetch(reqGet, { DB: wrappedDb });
  assert.equal(resGet.status, 200);
  const dataGet = await resGet.json();
  assert.equal(dataGet.data.documentLinks.length, 1);
});

test('POST /api/shipments/:id/documents allows all 7 canonical document types', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'Mgr', 'mgr@example.com', 'MANAGER', 'token-mgr');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, po_date, status) VALUES ('PO1', 'C1', 'P1', 'FOB', '2026-08-26', 'ACTIVE')").run();
  db.prepare("INSERT INTO shipments (shipment_id, po_id, is_one_container) VALUES ('SH1', 'PO1', 1)").run();

  const docTypes = ['PO', 'DI', 'BOOKING', 'STUFFING_REPORT', 'ALL_SHIP_DOC', 'IR', 'LC'];

  for (const docType of docTypes) {
    const payload = {
      documentType: docType,
      title: `${docType} Link`,
      driveUrl: 'https://drive.google.com/file/d/doc/view',
      referenceNo: 'REF'
    };

    const req = makeRequest('/api/shipments/SH1/documents', 'POST', payload, 'token-mgr');
    const res = await worker.fetch(req, { DB: wrappedDb });
    const body = await res.json();
    assert.equal(res.status, 200, `Failed for document type: ${docType}, response: ${JSON.stringify(body)}`);
    assert.equal(body.status, 'SUCCESS');
    assert.equal(body.data.documentLink.document_type, docType);
  }
});
