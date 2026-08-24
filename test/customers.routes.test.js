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

function seedCustomer(db, customerId, code, name, ownerId, status = 'ACTIVE_CUSTOMER') {
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(customerId, code, name, ownerId, status);
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

test('customers route: GET /api/customers returns 401 when unauthenticated', async () => {
  const { wrappedDb } = await setupTestDb();
  const req = makeRequest('/api/customers', 'GET');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /Authentication required/i);
});

test('customers route: ADMIN lists all customers', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'OWNED', 'sales-token');
  
  seedCustomer(db, 'CUST-0001', 'C-001', 'Cust 1', 'USR-0001');
  seedCustomer(db, 'CUST-0002', 'C-002', 'Cust 2', 'USR-0002');

  const req = makeRequest('/api/customers', 'GET', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customers.length, 2);
});

test('customers route: EXTERNAL_SALES lists only owned customers', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'OWNED', 'sales-token');
  
  seedCustomer(db, 'CUST-0001', 'C-001', 'Cust 1', 'USR-0001');
  seedCustomer(db, 'CUST-0002', 'C-002', 'Cust 2', 'USR-0002');

  const req = makeRequest('/api/customers', 'GET', null, 'sales-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customers.length, 1);
  assert.equal(body.data.customers[0].id, 'CUST-0002');
});

test('customers route: ADMIN gets customer detail', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  seedCustomer(db, 'CUST-0001', 'C-001', 'Cust 1', 'USR-0001');

  const req = makeRequest('/api/customers/CUST-0001', 'GET', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customer.name, 'Cust 1');
  assert.equal(body.data.customer.code, 'C-001');
});

test('customers route: ADMIN creates customer', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const payload = {
    name: 'New Customer B.V.',
    code: 'C-NEW-1',
    country: 'Netherlands',
    source: 'DIRECT',
    ownerId: 'USR-0001',
    contacts: [
      { name: 'Primary Contact', email: 'primary@customer.com', isPrimary: true }
    ]
  };

  const req = makeRequest('/api/customers', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customer.name, 'New Customer B.V.');
  assert.equal(body.data.customer.contacts.length, 1);
  assert.equal(body.data.customer.contacts[0].name, 'Primary Contact');
  assert.equal(body.data.customer.contacts[0].isPrimary, true);
});

test('customers route: EXTERNAL_SALES mutation returns 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'OWNED', 'sales-token');
  seedCustomer(db, 'CUST-0002', 'C-002', 'Cust 2', 'USR-0002');

  // Try POST
  const postReq = makeRequest('/api/customers', 'POST', { name: 'Sales Cust', code: 'C-S1' }, 'sales-token');
  const postRes = await worker.fetch(postReq, { DB: wrappedDb });
  assert.equal(postRes.status, 403);
  const postBody = await postRes.json();
  assert.equal(postBody.status, 'ERROR');
  assert.match(postBody.message, /Permission denied/i);

  // Try PUT
  const putReq = makeRequest('/api/customers/CUST-0002', 'PUT', { name: 'New Name' }, 'sales-token');
  const putRes = await worker.fetch(putReq, { DB: wrappedDb });
  assert.equal(putRes.status, 403);
  const putBody = await putRes.json();
  assert.equal(putBody.status, 'ERROR');
  assert.match(putBody.message, /Permission denied/i);
});

test('customers route: duplicate customer code returns 409', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  seedCustomer(db, 'CUST-0001', 'C-DUPE', 'Cust 1', 'USR-0001');

  const payload = {
    name: 'Duplicate B.V.',
    code: 'C-DUPE'
  };

  const req = makeRequest('/api/customers', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /already exists/i);
});

test('customers route: invalid payload returns 400', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const payload1 = {
    name: 'No Code B.V.'
  };

  const req1 = makeRequest('/api/customers', 'POST', payload1, 'admin-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 400);
  const body1 = await res1.json();
  assert.equal(body1.status, 'ERROR');
  assert.match(body1.message, /Customer code is required/i);

  const payload2 = {
    code: 'C-NO-NAME'
  };

  const req2 = makeRequest('/api/customers', 'POST', payload2, 'admin-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 400);
  const body2 = await res2.json();
  assert.equal(body2.status, 'ERROR');
  assert.match(body2.message, /Customer name is required/i);
});

test('customers route: GET hidden customer returns 404 for EXTERNAL_SALES', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sales', 'sales@example.com', 'EXTERNAL_SALES', 'OWNED', 'sales-token');
  
  seedCustomer(db, 'CUST-0001', 'C-001', 'Cust 1', 'USR-0001');

  const req = makeRequest('/api/customers/CUST-0001', 'GET', null, 'sales-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /Customer not found/i);
});

test('customers route: ADMIN updates customer and contacts', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  seedCustomer(db, 'CUST-0001', 'C-001', 'Cust 1', 'USR-0001');

  db.prepare(`
    INSERT INTO customer_contacts (contact_id, customer_id, contact_name, position, is_primary)
    VALUES (?, ?, ?, ?, ?)
  `).run('CONT-1', 'CUST-0001', 'Old Contact', 'Manager', 1);

  const payload = {
    name: 'Updated Cust 1',
    contacts: [
      { name: 'New Primary', email: 'primary@new.com', isPrimary: true }
    ]
  };

  const req = makeRequest('/api/customers/CUST-0001', 'PUT', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.customer.name, 'Updated Cust 1');
  assert.equal(body.data.customer.contacts.length, 1);
  assert.equal(body.data.customer.contacts[0].name, 'New Primary');
  assert.equal(body.data.customer.contactPerson, 'New Primary');
});

test('customers route: validate ownerId exists when provided', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const payload = {
    name: 'Test Cust',
    code: 'C-T1',
    ownerId: 'INVALID_USER'
  };

  const req = makeRequest('/api/customers', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /owner user does not exist/i);
});

test('customers route: validate status is ACTIVE_CUSTOMER or INACTIVE_CUSTOMER', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const payload = {
    name: 'Test Cust',
    code: 'C-T1',
    status: 'PENDING_APPROVAL'
  };

  const req = makeRequest('/api/customers', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /invalid customer status/i);
});

test('customers route: reject payload with more than one explicit primary contact', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const payload = {
    name: 'Test Cust',
    code: 'C-T1',
    contacts: [
      { name: 'Contact A', isPrimary: true },
      { name: 'Contact B', isPrimary: true }
    ]
  };

  const req = makeRequest('/api/customers', 'POST', payload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /only one primary contact/i);
});

test('customers route: EXPORT and PRODUCTION_WAREHOUSE customer access is denied', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-EXPORT', 'Export User', 'export@example.com', 'EXPORT', 'ALL', 'export-token');
  await seedUserAndSession(db, 'USR-WH', 'Warehouse User', 'wh@example.com', 'PRODUCTION_WAREHOUSE', 'ALL', 'wh-token');

  const req1 = makeRequest('/api/customers', 'GET', null, 'export-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 403);

  const req2 = makeRequest('/api/customers', 'POST', { name: 'Some Name', code: 'C-SOME' }, 'wh-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 403);
});
