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

async function seedUserAndSession(db, userId, name, email, role, customerScope, token, status = 'ACTIVE') {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt, password_iterations)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, email, role, customerScope, status, 'hash', 'salt', 100000);

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

test('GET /api/products returns 401 when unauthenticated', async () => {
  const { wrappedDb } = await setupTestDb();
  const req = makeRequest('/api/products', 'GET');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 401);
});

test('GET /api/products returns 200 for authenticated SALES_SUPPORT', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0002', 'Support', 'support@example.com', 'SALES_SUPPORT', 'ALL', 'support-token');

  // Seed category, form, product
  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();
  db.prepare(`INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('PRD-001', 'THP65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')`).run();

  const req = makeRequest('/api/products', 'GET', null, 'support-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'SUCCESS');
  assert.equal(data.data.products.length, 1);
  assert.equal(data.data.products[0].code, 'THP65');
});

test('POST /api/products allowed for ADMIN and creates product', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();

  const payload = {
    code: 'THP65',
    name: 'Tapioca Hard Pellet 65%',
    shortName: 'THP65',
    categoryId: 'CAT-001',
    formId: 'FRM-001',
    hsCode: '1108.14',
    defaultUnit: 'MT',
    applications: ['FEED_GRADE', 'PET_GRADE'],
    status: 'ACTIVE'
  };

  const req = makeRequest('/api/products', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'SUCCESS');
  assert.equal(data.data.product.code, 'THP65');
  assert.deepEqual(data.data.product.applications, ['FEED_GRADE', 'PET_GRADE']);
});

test('POST /api/products returns 403 for SALES_SUPPORT', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0002', 'Support', 'support@example.com', 'SALES_SUPPORT', 'ALL', 'support-token');

  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();

  const payload = {
    code: 'THP65',
    name: 'Tapioca Hard Pellet 65%',
    shortName: 'THP65',
    categoryId: 'CAT-001',
    formId: 'FRM-001',
    hsCode: '1108.14',
    defaultUnit: 'MT',
    applications: ['FEED_GRADE'],
    status: 'ACTIVE'
  };

  const req = makeRequest('/api/products', 'POST', payload, 'support-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);
});

test('PUT /api/products/:id updates product successfully', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();
  db.prepare(`INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('PRD-001', 'THP65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')`).run();

  const payload = {
    name: 'Tapioca Hard Pellet 65% Updated',
    shortName: 'THP65U',
    categoryId: 'CAT-001',
    formId: 'FRM-001',
    hsCode: '1108.14.99',
    defaultUnit: 'KG',
    applications: ['PET_GRADE'],
    status: 'INACTIVE'
  };

  const req = makeRequest('/api/products/PRD-001', 'PUT', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.status, 'SUCCESS');
  assert.equal(data.data.product.name, 'Tapioca Hard Pellet 65% Updated');
  assert.deepEqual(data.data.product.applications, ['PET_GRADE']);
  assert.equal(data.data.product.status, 'INACTIVE');
});
