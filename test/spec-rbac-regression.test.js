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

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt, password_iterations)
    VALUES (?, ?, ?, ?, 'ALL', 'ACTIVE', 'hash', 'salt', 100000)
  `).run(userId, `${role} User`, `${role.toLowerCase()}@example.com`, role);

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

test('Spec RBAC Enforcements - Finding 1 Regression Tests', async () => {
  const { db, wrappedDb } = await setupTestDb();

  // Seed roles
  await seedUserAndSession(db, 'U-ADMIN', 'ADMIN', 'admin-t');
  await seedUserAndSession(db, 'U-MANAGER', 'MANAGER', 'manager-t');
  await seedUserAndSession(db, 'U-SUPPORT', 'SALES_SUPPORT', 'support-t');
  await seedUserAndSession(db, 'U-EXPORT', 'EXPORT', 'export-t');
  await seedUserAndSession(db, 'U-WAREHOUSE', 'PRODUCTION_WAREHOUSE', 'warehouse-t');
  await seedUserAndSession(db, 'U-SALES', 'EXTERNAL_SALES', 'sales-t');

  // Seed master data
  db.prepare(`INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca')`).run();
  db.prepare(`INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')`).run();
  db.prepare(`INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('PRD-001', 'THP65', 'Tapioca Hard Pellet', 'THP65', 'CAT-001', 'FRM-001')`).run();
  db.prepare(`INSERT INTO product_applications (product_id, application) VALUES ('PRD-001', 'FEED_GRADE')`).run();
  db.prepare(`INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit) VALUES ('PAR-001', 'STARCH', 'Starch Content', 'NUMBER', '%')`).run();
  db.prepare(`INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('CUST-001', 'ABC-FEED', 'ABC Feed Corp')`).run();
  
  // Seed an active standard spec and a draft standard spec
  db.prepare(`INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-26')`).run();
  db.prepare(`INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD-DRAFT', 'PRD-001', 'FEED_GRADE', 1, 'DRAFT', '2026-08-27')`).run();
  
  // Seed a draft customer spec
  db.prepare(`INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date) VALUES ('CSP-DRAFT', 'CUST-001', 'PRD-001', 'FEED_GRADE', 'STD-001', 0, 'DRAFT', '2026-08-26')`).run();

  const stdSpecPayload = { productId: 'PRD-001', application: 'FEED_GRADE', effectiveDate: '2026-08-28' };
  const stdSpecItemsPayload = { items: [{ parameterId: 'PAR-001', operator: 'MIN', numericValue: 65 }] };
  const custSpecPayload = { customerId: 'CUST-001', productId: 'PRD-001', application: 'FEED_GRADE', baseStandardSpecId: 'STD-001', effectiveDate: '2026-08-26' };
  const custSpecOverridesPayload = { overrides: [{ parameterId: 'PAR-001', operator: 'MIN', numericValue: 66 }] };

  // Helper to run request and return status
  async function checkRoute(path, method, body, token) {
    const req = makeRequest(path, method, body, token);
    const res = await worker.fetch(req, { DB: wrappedDb });
    return res.status;
  }

  // A. ADMIN, MANAGER, SUPPORT: Allowed for draft writes (200 status expected)
  for (const token of ['admin-t', 'manager-t', 'support-t']) {
    // Standard spec create
    assert.equal(await checkRoute('/api/standard-specs', 'POST', stdSpecPayload, token), 200);
    // Standard spec edit draft items
    assert.equal(await checkRoute('/api/standard-specs/STD-DRAFT', 'PUT', stdSpecItemsPayload, token), 200);
    // Customer spec create
    assert.equal(await checkRoute('/api/customer-specs', 'POST', custSpecPayload, token), 200);
    // Customer spec edit overrides
    assert.equal(await checkRoute('/api/customer-specs/CSP-DRAFT', 'PUT', custSpecOverridesPayload, token), 200);
  }

  // B. EXPORT, PRODUCTION_WAREHOUSE, EXTERNAL_SALES: Denied (403 status expected)
  for (const token of ['export-t', 'warehouse-t', 'sales-t']) {
    assert.equal(await checkRoute('/api/standard-specs', 'POST', stdSpecPayload, token), 403);
    assert.equal(await checkRoute('/api/standard-specs/STD-DRAFT', 'PUT', stdSpecItemsPayload, token), 403);
    assert.equal(await checkRoute('/api/customer-specs', 'POST', custSpecPayload, token), 403);
    assert.equal(await checkRoute('/api/customer-specs/CSP-DRAFT', 'PUT', custSpecOverridesPayload, token), 403);
  }

  // C. SALES_SUPPORT activate/archive: Denied (403 status expected)
  assert.equal(await checkRoute('/api/standard-specs/STD-DRAFT/activate', 'POST', null, 'support-t'), 403);
  assert.equal(await checkRoute('/api/standard-specs/STD-001/archive', 'POST', null, 'support-t'), 403);
  assert.equal(await checkRoute('/api/customer-specs/CSP-DRAFT/activate', 'POST', null, 'support-t'), 403);
  assert.equal(await checkRoute('/api/customer-specs/CSP-DRAFT/archive', 'POST', null, 'support-t'), 403);
});
