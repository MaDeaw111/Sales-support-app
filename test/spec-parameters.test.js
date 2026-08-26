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

test('Spec parameters API: CRUD and validations', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Support', 'support@example.com', 'SALES_SUPPORT', 'ALL', 'support-token');

  // 1. Initial list
  let req = makeRequest('/api/spec-parameters', 'GET', null, 'support-token');
  let res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.parameters.length, 0);

  // 2. Create Parameter (Valid)
  const payload = {
    code: 'STARCH',
    name: 'Starch Content',
    dataType: 'NUMBER',
    defaultUnit: '%',
    status: 'ACTIVE',
    sortOrder: 1
  };
  req = makeRequest('/api/spec-parameters', 'POST', payload, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.ok(body.data.parameter.id.startsWith('PAR-'));
  assert.equal(body.data.parameter.code, 'STARCH');

  // 3. Create Parameter (Duplicate Code Rejected)
  req = makeRequest('/api/spec-parameters', 'POST', payload, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 409); // Conflict

  // 4. Create Parameter (Invalid Data Type Rejected)
  req = makeRequest('/api/spec-parameters', 'POST', { ...payload, code: 'MOISTURE', dataType: 'INVALID' }, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);

  // 5. Create Parameter (Invalid Status Rejected)
  req = makeRequest('/api/spec-parameters', 'POST', { ...payload, code: 'MOISTURE', status: 'INVALID' }, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);

  // 6. Create Parameter (SALES_SUPPORT Denied Write)
  req = makeRequest('/api/spec-parameters', 'POST', { ...payload, code: 'MOISTURE' }, 'support-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);

  // 7. Update Parameter
  const paramId = body.data.parameter.id;
  req = makeRequest(`/api/spec-parameters/${paramId}`, 'PUT', {
    name: 'Starch Content Updated',
    dataType: 'NUMBER',
    defaultUnit: '%',
    status: 'INACTIVE',
    sortOrder: 2
  }, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.parameter.name, 'Starch Content Updated');
  assert.equal(body.data.parameter.status, 'INACTIVE');
  assert.equal(body.data.parameter.sortOrder, 2);
});
