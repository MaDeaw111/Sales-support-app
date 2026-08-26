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

test('GET /api/manager-price-notes: returns 401 when unauthenticated', async () => {
  const { wrappedDb } = await setupTestDb();
  const req = makeRequest('/api/manager-price-notes', 'GET');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 401);
});

test('POST /api/manager-price-notes: MANAGER can create and SALES_SUPPORT is forbidden', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'Mgr', 'mgr@example.com', 'MANAGER', 'token-mgr');
  await seedUserAndSession(db, 'U_SUPP', 'Supp', 'supp@example.com', 'SALES_SUPPORT', 'token-supp');
  await seedUserAndSession(db, 'U_SALES', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'token-sales');

  // Seed references
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const payload = {
    salesUserId: 'U_SALES',
    customerId: 'C1',
    productId: 'P1',
    incoterm: 'CFR',
    destinationPort: 'Rotterdam',
    offerPriceUsdPerMt: 350.0
  };

  // 1. SALES_SUPPORT is forbidden
  const reqSupp = makeRequest('/api/manager-price-notes', 'POST', payload, 'token-supp');
  const resSupp = await worker.fetch(reqSupp, { DB: wrappedDb });
  assert.equal(resSupp.status, 403);

  // 2. MANAGER is allowed
  const reqMgr = makeRequest('/api/manager-price-notes', 'POST', payload, 'token-mgr');
  const resMgr = await worker.fetch(reqMgr, { DB: wrappedDb });
  assert.equal(resMgr.status, 200);

  const dataMgr = await resMgr.json();
  assert.equal(dataMgr.status, 'SUCCESS');
  assert.equal(dataMgr.data.priceNote.offer_price_usd_per_mt, 350.0);

  // 3. GET price notes
  const reqGet = makeRequest('/api/manager-price-notes', 'GET', null, 'token-supp');
  const resGet = await worker.fetch(reqGet, { DB: wrappedDb });
  assert.equal(resGet.status, 200);
  const dataGet = await resGet.json();
  assert.equal(dataGet.data.priceNotes.length, 1);
});
