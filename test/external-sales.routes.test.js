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

async function seedUserAndSession(db, userId, name, email, role, customerScope, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, name, email, role, customerScope, 'hash', 'salt');

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

test('external-sales: unauthenticated request returns 401', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const req = makeRequest('/api/external-sales', 'GET', null, null);
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 401);
});

test('external-sales: ADMIN can list profile records and sensitive fields are excluded', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  // Seed an external sales user
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0002', 'Sira Owner', 'sira@example.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'ACTIVE', 'hashed_pass', 'salts');

  // Seed a customer owned by Sira
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-1', 'C-1', 'Meelunie B.V.', 'USR-0002');

  const req = makeRequest('/api/external-sales', 'GET', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  const sales = body.data.externalSales;
  
  assert.equal(sales.length, 1);
  assert.equal(sales[0].id, 'USR-0002');
  assert.equal(sales[0].name, 'Sira Owner');
  assert.deepEqual(sales[0].customerIds, ['CUST-1']);
  
  // Exclude sensitive fields
  assert.equal(sales[0].password_hash, undefined);
  assert.equal(sales[0].password_salt, undefined);
});

test('external-sales: duplicate email is rejected during creation', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  // Create first external sales user
  const req1 = makeRequest('/api/external-sales', 'POST', { name: 'Sales 1', email: 'sira@example.com', status: 'ACTIVE' }, 'admin-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 200);

  // Try creating with same email
  const req2 = makeRequest('/api/external-sales', 'POST', { name: 'Sales 2', email: 'sira@example.com', status: 'ACTIVE' }, 'admin-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 409);
});

test('external-sales: non-External-Sales user cannot be modified', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  // Try to update ADMIN via external-sales endpoint
  const req = makeRequest('/api/external-sales/USR-0001', 'PUT', { name: 'New Admin', email: 'admin@example.com', status: 'ACTIVE' }, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 404);
});

test('external-sales: invalid customer ID is rejected during update', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0002', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'ACTIVE', 'h', 's');

  const req = makeRequest('/api/external-sales/USR-0002', 'PUT', { name: 'Sales', email: 'sales@example.com', status: 'ACTIVE', customerIds: ['NON-EXISTENT'] }, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);
});

test('external-sales: customer assignment, reassignment, and unassignment works', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  // Seed two External Sales users
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0002', 'Sales 1', 'sales1@example.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'ACTIVE', 'h', 's');

  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0003', 'Sales 2', 'sales2@example.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'ACTIVE', 'h', 's');

  // Seed customers
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-1', 'C-1', 'Cust 1', 'USR-0002');

  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-2', 'C-2', 'Cust 2', 'USR-0003');

  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-3', 'C-3', 'Cust 3', null);

  // Update Sales 1: assign CUST-2 (reassign from Sales 2) and CUST-3, and unassign CUST-1
  const req = makeRequest('/api/external-sales/USR-0002', 'PUT', {
    name: 'Sales 1 Updated',
    email: 'sales1@example.com',
    status: 'ACTIVE',
    customerIds: ['CUST-2', 'CUST-3']
  }, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);

  // Verify DB state
  // CUST-1 should have owner = NULL (deselected)
  const cust1 = db.prepare('SELECT owner_user_id FROM customers WHERE customer_id = ?').all('CUST-1')[0];
  assert.equal(cust1.owner_user_id, null);

  // CUST-2 should have owner = USR-0002 (reassigned)
  const cust2 = db.prepare('SELECT owner_user_id FROM customers WHERE customer_id = ?').all('CUST-2')[0];
  assert.equal(cust2.owner_user_id, 'USR-0002');

  // CUST-3 should have owner = USR-0002 (newly assigned)
  const cust3 = db.prepare('SELECT owner_user_id FROM customers WHERE customer_id = ?').all('CUST-3')[0];
  assert.equal(cust3.owner_user_id, 'USR-0002');
});

test('external-sales: unauthorized roles cannot mutate profiles', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Support', 'support@example.com', 'SALES_SUPPORT', 'ALL_ASSIGNED', 'support-token');

  // Try to create profile as SALES_SUPPORT
  const req = makeRequest('/api/external-sales', 'POST', { name: 'Sales', email: 's@example.com', status: 'ACTIVE' }, 'support-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);
});

test('external-sales: MANAGER is allowed to POST and PUT profiles', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');
  
  const req1 = makeRequest('/api/external-sales', 'POST', { name: 'Sales 1', email: 'sales1@example.com', status: 'ACTIVE' }, 'manager-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 200);
  const body1 = await res1.json();
  const newUserId = body1.data.externalSales.id;

  const req2 = makeRequest(`/api/external-sales/${newUserId}`, 'PUT', { name: 'Sales 1 Updated', email: 'sales1@example.com', status: 'ACTIVE' }, 'manager-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 200);
});

test('external-sales: POST with customerIds persists and returns assignments, invalid prevents user creation, reassigns correctly', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0002', 'Sales 1', 'sales1@example.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'ACTIVE', 'h', 's');

  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-1', 'C-1', 'Cust 1', 'USR-0002');

  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-2', 'C-2', 'Cust 2', null);

  const req1 = makeRequest('/api/external-sales', 'POST', {
    name: 'Sales New',
    email: 'new@example.com',
    status: 'ACTIVE',
    customerIds: ['CUST-1', 'NON-EXISTENT']
  }, 'admin-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 400);

  const userCheck = db.prepare("SELECT 1 FROM users WHERE email = 'new@example.com'").get();
  assert.equal(userCheck, undefined);

  const req2 = makeRequest('/api/external-sales', 'POST', {
    name: 'Sales New',
    email: 'new@example.com',
    status: 'ACTIVE',
    customerIds: ['CUST-1', 'CUST-2']
  }, 'admin-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 200);
  
  const body2 = await res2.json();
  const createdUser = body2.data.externalSales;
  assert.deepEqual(createdUser.customerIds, ['CUST-1', 'CUST-2']);

  const cust1 = db.prepare('SELECT owner_user_id FROM customers WHERE customer_id = ?').all('CUST-1')[0];
  assert.equal(cust1.owner_user_id, createdUser.id);

  const cust2 = db.prepare('SELECT owner_user_id FROM customers WHERE customer_id = ?').all('CUST-2')[0];
  assert.equal(cust2.owner_user_id, createdUser.id);
});

