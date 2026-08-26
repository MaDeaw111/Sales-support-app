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

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'Test User', `${userId}@example.com`, role, 'ALL', 'hash', 'salt');

  const tokenHash = await hashSessionToken(token);
  const expires = new Date(Date.now() + 1000000).toISOString();
  
  db.prepare(`
    INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(`SES-${userId}`, userId, tokenHash, expires);
}

test('POST /api/shipments/:id/ensure creates PO and Shipment anchors when PO does not exist', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'token-mgr');

  // Seed customer, product (needed because of foreign keys on pos)
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const req = new Request('https://example.com/api/shipments/SH_NEW/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-mgr',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'CFR',
      destinationPort: 'Rotterdam',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected status 200, got: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'SUCCESS');

  // Verify DB contents
  const po = db.prepare("SELECT * FROM pos WHERE po_id = 'PO_NEW'").get();
  assert.ok(po);
  assert.equal(po.incoterm, 'CFR');
  assert.equal(po.destination_port, 'Rotterdam');

  const sh = db.prepare("SELECT * FROM shipments WHERE shipment_id = 'SH_NEW'").get();
  assert.ok(sh);
  assert.equal(sh.po_id, 'PO_NEW');
});

test('POST /api/shipments/:id/ensure rejects CFR/CIF without destination port', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'token-mgr');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const req = new Request('https://example.com/api/shipments/SH_NEW2/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-mgr',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW2',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'CFR',
      destinationPort: '',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /destination port/i);
});

test('POST /api/shipments/:id/ensure rejects unauthorized roles with 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_SALES', 'EXTERNAL_SALES', 'token-sales');

  const req = new Request('https://example.com/api/shipments/SH_NEW/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-sales',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'FOB',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /permission denied/i);
});

test('POST /api/shipments/:id/ensure supports tri-state isOneContainer (1, 0, null)', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'token-mgr');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // Case 1: explicit 1
  const req1 = new Request('https://example.com/api/shipments/SH_1/ensure', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-mgr', 'content-type': 'application/json' },
    body: JSON.stringify({ poId: 'PO_1', customerId: 'C1', productId: 'P1', incoterm: 'FOB', isOneContainer: 1 })
  });
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 200);
  const sh1 = db.prepare("SELECT * FROM shipments WHERE shipment_id = 'SH_1'").get();
  assert.equal(sh1.is_one_container, 1);

  // Case 2: explicit 0
  const req2 = new Request('https://example.com/api/shipments/SH_2/ensure', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-mgr', 'content-type': 'application/json' },
    body: JSON.stringify({ poId: 'PO_2', customerId: 'C1', productId: 'P1', incoterm: 'FOB', isOneContainer: 0 })
  });
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 200);
  const sh2 = db.prepare("SELECT * FROM shipments WHERE shipment_id = 'SH_2'").get();
  assert.equal(sh2.is_one_container, 0);

  // Case 3: omitted isOneContainer
  const req3 = new Request('https://example.com/api/shipments/SH_3/ensure', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-mgr', 'content-type': 'application/json' },
    body: JSON.stringify({ poId: 'PO_3', customerId: 'C1', productId: 'P1', incoterm: 'FOB' })
  });
  const res3 = await worker.fetch(req3, { DB: wrappedDb });
  assert.equal(res3.status, 200);
  const sh3 = db.prepare("SELECT * FROM shipments WHERE shipment_id = 'SH_3'").get();
  assert.equal(sh3.is_one_container, null);
});

test('Shipment read routes deny EXTERNAL_SALES and PRODUCTION_WAREHOUSE with 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_SALES', 'EXTERNAL_SALES', 'token-sales');
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'token-wh');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, status) VALUES ('PO1', 'C1', 'P1', 'FOB', 'ACTIVE')").run();
  db.prepare("INSERT INTO shipments (shipment_id, po_id, is_one_container) VALUES ('SH1', 'PO1', 1)").run();

  const unauthorizedTokens = ['token-sales', 'token-wh'];
  const endpoints = [
    '/api/shipments/SH1',
    '/api/shipments/SH1/expenses',
    '/api/shipments/SH1/documents',
    '/api/expense-categories'
  ];

  for (const token of unauthorizedTokens) {
    for (const endpoint of endpoints) {
      const req = new Request(`https://example.com${endpoint}`, {
        method: 'GET',
        headers: { 'cookie': `wcat_session=${token}` }
      });
      const res = await worker.fetch(req, { DB: wrappedDb });
      assert.equal(res.status, 403, `Expected 403 for ${endpoint} with token ${token}, got: ${res.status}`);
      const body = await res.json();
      assert.equal(body.status, 'ERROR');
      assert.match(body.message, /permission denied/i);
    }
  }
});

test('EXPORT role is allowed operational access to write shipment controls', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_EXP', 'EXPORT', 'token-export');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // 1. Can create freight quote
  const resQuote = await worker.fetch(new Request('https://example.com/api/freight-quotes', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-export', 'content-type': 'application/json' },
    body: JSON.stringify({
      originPort: 'Bangkok',
      destinationPort: 'Rotterdam',
      containerSize: "20'",
      shippingLineOrForwarder: 'Maersk',
      quotedFreightUsdPerContainer: 2500.00
    })
  }), { DB: wrappedDb });
  assert.equal(resQuote.status, 200);

  // 2. Can ensure shipment
  const resEnsure = await worker.fetch(new Request('https://example.com/api/shipments/SH1/ensure', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-export', 'content-type': 'application/json' },
    body: JSON.stringify({ poId: 'PO1', customerId: 'C1', productId: 'P1', incoterm: 'FOB', isOneContainer: 1 })
  }), { DB: wrappedDb });
  assert.equal(resEnsure.status, 200);

  // 3. Can add expense
  const resExpense = await worker.fetch(new Request('https://example.com/api/shipments/SH1/expenses', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-export', 'content-type': 'application/json' },
    body: JSON.stringify({ expenseCategoryId: 'CAT-TRUCK', amount: 5000, currency: 'THB' })
  }), { DB: wrappedDb });
  assert.equal(resExpense.status, 200);

  // 4. Can add document link
  const resDoc = await worker.fetch(new Request('https://example.com/api/shipments/SH1/documents', {
    method: 'POST',
    headers: { 'cookie': 'wcat_session=token-export', 'content-type': 'application/json' },
    body: JSON.stringify({ documentType: 'PO', title: 'PO Scan', driveUrl: 'https://drive.google.com/doc' })
  }), { DB: wrappedDb });
  assert.equal(resDoc.status, 200);
});
