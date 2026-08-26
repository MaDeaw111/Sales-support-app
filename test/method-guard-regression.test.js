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
    }
  };

  return { db, wrappedDb };
}

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt, password_iterations)
    VALUES (?, ?, ?, ?, 'ALL', 'ACTIVE', 'hash', 'salt', 100000)
  `).run(userId, 'Test User', 'test@example.com', role);

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

test('Route /api/customers/:customerId/specs method guard check - Finding 3', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'ADMIN', 'admin-token');

  // GET is allowed and returns 200
  let req = makeRequest('/api/customers/CUST-001/specs', 'GET', null, 'admin-token');
  let res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);

  // POST is not allowed and returns 404 (Route not found)
  req = makeRequest('/api/customers/CUST-001/specs', 'POST', {}, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 404);

  // PUT is not allowed and returns 404
  req = makeRequest('/api/customers/CUST-001/specs', 'PUT', {}, 'admin-token');
  res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 404);
});
