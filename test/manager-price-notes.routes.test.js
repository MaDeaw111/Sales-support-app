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
  // Seed references
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U_SALES')").run();
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

test('POST /api/manager-price-notes validates salesperson role and customer assignment', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'Mgr', 'mgr@example.com', 'MANAGER', 'token-mgr');
  await seedUserAndSession(db, 'U_SALES_A', 'Sales A', 'salesA@example.com', 'EXTERNAL_SALES', 'token-salesA');
  await seedUserAndSession(db, 'U_SALES_B', 'Sales B', 'salesB@example.com', 'EXTERNAL_SALES', 'token-salesB');
  await seedUserAndSession(db, 'U_NOT_SALES', 'Not Sales', 'notsales@example.com', 'EXPORT', 'token-export');

  // Seed customers
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C_A', 'CUSTA', 'Customer A', 'U_SALES_A')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C_B', 'CUSTB', 'Customer B', 'U_SALES_B')").run();

  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // 1. Rejected if salesperson role is invalid
  const reqInvalidRole = makeRequest('/api/manager-price-notes', 'POST', {
    salesUserId: 'U_NOT_SALES',
    customerId: 'C_A',
    productId: 'P1',
    incoterm: 'FOB',
    offerPriceUsdPerMt: 350.0
  }, 'token-mgr');
  const resInvalidRole = await worker.fetch(reqInvalidRole, { DB: wrappedDb });
  assert.equal(resInvalidRole.status, 400);
  const bodyInvalidRole = await resInvalidRole.json();
  assert.match(bodyInvalidRole.message, /not a salesperson/i);

  // 2. Rejected if customer is not owned by the salesperson
  const reqMismatch = makeRequest('/api/manager-price-notes', 'POST', {
    salesUserId: 'U_SALES_A',
    customerId: 'C_B', // owned by U_SALES_B
    productId: 'P1',
    incoterm: 'FOB',
    offerPriceUsdPerMt: 350.0
  }, 'token-mgr');
  const resMismatch = await worker.fetch(reqMismatch, { DB: wrappedDb });
  assert.equal(resMismatch.status, 400);
  const bodyMismatch = await resMismatch.json();
  assert.match(bodyMismatch.message, /not assigned to this salesperson/i);

  // 3. Allowed if owner matches
  const reqMatch = makeRequest('/api/manager-price-notes', 'POST', {
    salesUserId: 'U_SALES_A',
    customerId: 'C_A',
    productId: 'P1',
    incoterm: 'FOB',
    offerPriceUsdPerMt: 350.0
  }, 'token-mgr');
  const resMatch = await worker.fetch(reqMatch, { DB: wrappedDb });
  assert.equal(resMatch.status, 200);
});

test('GET /api/manager-price-notes enforces date filters and sales-user visibility', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'Mgr', 'mgr@example.com', 'MANAGER', 'token-mgr');
  await seedUserAndSession(db, 'U_SALES_A', 'Sales A', 'salesA@example.com', 'EXTERNAL_SALES', 'token-salesA');
  await seedUserAndSession(db, 'U_SALES_B', 'Sales B', 'salesB@example.com', 'EXTERNAL_SALES', 'token-salesB');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C_A', 'CUSTA', 'Customer A', 'U_SALES_A')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C_B', 'CUSTB', 'Customer B', 'U_SALES_B')").run();

  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // Create notes with custom dates
  db.prepare(`
    INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id, created_at)
    VALUES ('PN1', 'U_SALES_A', 'C_A', 'P1', 'FOB', 350.0, 'U_MGR', '2026-08-20 10:00:00')
  `).run();
  db.prepare(`
    INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id, created_at)
    VALUES ('PN2', 'U_SALES_B', 'C_B', 'P1', 'FOB', 360.0, 'U_MGR', '2026-08-25 10:00:00')
  `).run();

  // 1. Date range filter
  const reqDate = makeRequest('/api/manager-price-notes?dateFrom=2026-08-24&dateTo=2026-08-26', 'GET', null, 'token-mgr');
  const resDate = await worker.fetch(reqDate, { DB: wrappedDb });
  const bodyDate = await resDate.json();
  assert.equal(bodyDate.data.priceNotes.length, 1);
  assert.equal(bodyDate.data.priceNotes[0].id, 'PN2');

  // 2. Sales A visibility (should only see note for Customer A / Sales A)
  const reqSalesA = makeRequest('/api/manager-price-notes', 'GET', null, 'token-salesA');
  const resSalesA = await worker.fetch(reqSalesA, { DB: wrappedDb });
  const bodySalesA = await resSalesA.json();
  assert.equal(bodySalesA.data.priceNotes.length, 1);
  assert.equal(bodySalesA.data.priceNotes[0].id, 'PN1');
});
