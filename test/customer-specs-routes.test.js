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

test('Customer Specs API Routes and RBAC checks', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Support', 'support@example.com', 'SALES_SUPPORT', 'ALL', 'support-token');

  // Seed master data
  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();
  db.prepare(`INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('PRD-001', 'THP65', 'Tapioca Hard Pellet', 'THP65', 'CAT-001', 'FRM-001')`).run();
  db.prepare(`INSERT INTO product_applications (product_id, application) VALUES ('PRD-001', 'FEED_GRADE')`).run();
  db.prepare(`INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit) VALUES ('PAR-001', 'STARCH', 'Starch Content', 'NUMBER', '%')`).run();
  db.prepare(`INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('CUST-001', 'ABC-FEED', 'ABC Feed Corp')`).run();
  db.prepare(`INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-26')`).run();

  // 1. Create customer spec draft (Allowed for SALES_SUPPORT)
  let req = makeRequest('/api/customer-specs', 'POST', {
    customerId: 'CUST-001',
    productId: 'PRD-001',
    application: 'FEED_GRADE',
    baseStandardSpecId: 'STD-001',
    effectiveDate: '2026-08-26',
    notes: 'Draft customer spec'
  }, 'support-token');
  let res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  const specId = body.data.customerSpec.id;

  // 2. Edit draft overrides (Allowed for SALES_SUPPORT)
  req = makeRequest(`/api/customer-specs/${specId}`, 'PUT', {
    overrides: [
      {
        parameterId: 'PAR-001',
        operator: 'MIN',
        numericValue: 66
      }
    ]
  }, 'support-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customerSpec.overrides.length, 1);
  assert.equal(body.data.customerSpec.overrides[0].numericValue, 66);

  // 3. GET effective spec resolution
  req = makeRequest(`/api/customer-specs/${specId}/effective`, 'GET', null, 'support-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.effectiveSpec.items.length, 1);
  assert.equal(body.data.effectiveSpec.items[0].numericValue, 66);
  assert.equal(body.data.effectiveSpec.items[0].source, 'OVERRIDDEN');

  // 4. Activate Customer Spec (Denied for SALES_SUPPORT)
  req = makeRequest(`/api/customer-specs/${specId}/activate`, 'POST', null, 'support-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);

  // 5. Activate Customer Spec (Allowed for ADMIN)
  req = makeRequest(`/api/customer-specs/${specId}/activate`, 'POST', null, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customerSpec.status, 'ACTIVE');
});
