import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken, verifyPassword } from '../src/auth/crypto.js';

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

test('GET /api/users: unauthenticated request returns 401', async () => {
  const { wrappedDb } = await setupTestDb();
  const req = makeRequest('/api/users', 'GET', null, null);
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 401);
});

test('GET /api/users: SALES_SUPPORT returns 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0002', 'Support', 'support@example.com', 'SALES_SUPPORT', 'NONE', 'support-token');
  const req = makeRequest('/api/users', 'GET', null, 'support-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);
});

test('GET /api/users: ADMIN/MANAGER returns 200 with sanitized user list sorted by full_name', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');

  // ADMIN Request
  const req = makeRequest('/api/users', 'GET', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.ok(Array.isArray(body.data.users));
  assert.equal(body.data.users.length, 2);

  // Sorting check (Alice first, then Zack)
  assert.equal(body.data.users[0].name, 'Alice Manager');
  assert.equal(body.data.users[1].name, 'Zack Admin');

  // Security fields sanitization check
  for (const user of body.data.users) {
    assert.equal(user.password_hash, undefined);
    assert.equal(user.password_salt, undefined);
    assert.equal(user.password_iterations, undefined);
    assert.equal(user.token_hash, undefined);
  }

  // MANAGER Request
  const reqMgr = makeRequest('/api/users', 'GET', null, 'manager-token');
  const resMgr = await worker.fetch(reqMgr, { DB: wrappedDb });
  assert.equal(resMgr.status, 200);
});

test('GET /api/users/:id: unauthenticated -> 401, MANAGER/ADMIN -> 200, unauthorized -> 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');
  await seedUserAndSession(db, 'USR-0003', 'Sales support', 'support@example.com', 'SALES_SUPPORT', 'NONE', 'support-token');

  // Unauthenticated
  const req1 = makeRequest('/api/users/USR-0002', 'GET', null, null);
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 401);

  // MANAGER -> 200
  const req2 = makeRequest('/api/users/USR-0001', 'GET', null, 'manager-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  assert.equal(body2.data.user.name, 'Zack Admin');
  assert.equal(body2.data.user.password_hash, undefined);

  // SALES_SUPPORT -> 403
  const req3 = makeRequest('/api/users/USR-0001', 'GET', null, 'support-token');
  const res3 = await worker.fetch(req3, { DB: wrappedDb });
  assert.equal(res3.status, 403);
});

test('POST /api/users: ADMIN can create internal user with temporary password', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  const newUser = {
    name: 'New User',
    email: 'newuser@example.com',
    role: 'SALES_SUPPORT',
    status: 'ACTIVE',
    customerScope: 'NONE'
  };

  const req = makeRequest('/api/users', 'POST', newUser, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.ok(body.data.user.id);
  assert.equal(body.data.user.name, 'New User');
  assert.equal(body.data.user.mustChangePassword, true);
  assert.ok(body.data.temporaryPassword);

  // Verify stored credentials using verifyPassword
  const storedUser = db.prepare('SELECT * FROM users WHERE email = ?').get('newuser@example.com');
  assert.ok(storedUser);
  assert.equal(storedUser.must_change_password, 1);
  assert.equal(storedUser.password_iterations, 100000);

  const pwdRecord = {
    hash: storedUser.password_hash,
    salt: storedUser.password_salt,
    iterations: storedUser.password_iterations
  };
  const verified = await verifyPassword(body.data.temporaryPassword, pwdRecord);
  assert.equal(verified, true);
});

test('POST /api/users: MANAGER create -> 403, validations reject invalid role, status, duplicate email', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');

  // MANAGER POST -> 403
  const req1 = makeRequest('/api/users', 'POST', { name: 'A', email: 'a@a.com', role: 'SALES_SUPPORT', status: 'ACTIVE' }, 'manager-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 403);

  // Duplicate email -> 409
  const req2 = makeRequest('/api/users', 'POST', { name: 'Alice Clone', email: 'MANAGER@example.com', role: 'SALES_SUPPORT', status: 'ACTIVE' }, 'admin-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 409);

  // Invalid role -> 400
  const req3 = makeRequest('/api/users', 'POST', { name: 'A', email: 'a@a.com', role: 'SUPER_HERO', status: 'ACTIVE' }, 'admin-token');
  const res3 = await worker.fetch(req3, { DB: wrappedDb });
  assert.equal(res3.status, 400);

  // Invalid status -> 400
  const req4 = makeRequest('/api/users', 'POST', { name: 'A', email: 'a@a.com', role: 'SALES_SUPPORT', status: 'UNKNOWN_STATUS' }, 'admin-token');
  const res4 = await worker.fetch(req4, { DB: wrappedDb });
  assert.equal(res4.status, 400);
});

test('PUT /api/users/:id: ADMIN can update user profile, MANAGER -> 403, and duplicate email -> 409', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');

  // Update Alice to Alice Updated
  const updatePayload = {
    name: 'Alice Updated',
    email: 'alice.updated@example.com',
    role: 'MANAGER',
    status: 'ACTIVE',
    customerScope: 'ALL'
  };

  const req = makeRequest('/api/users/USR-0002', 'PUT', updatePayload, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);

  const stored = db.prepare('SELECT * FROM users WHERE user_id = ?').get('USR-0002');
  assert.equal(stored.full_name, 'Alice Updated');
  assert.equal(stored.email, 'alice.updated@example.com');

  // MANAGER -> 403
  const reqMgr = makeRequest('/api/users/USR-0002', 'PUT', updatePayload, 'manager-token');
  const resMgr = await worker.fetch(reqMgr, { DB: wrappedDb });
  assert.equal(resMgr.status, 403);

  // Duplicate email -> 409
  const reqDup = makeRequest('/api/users/USR-0002', 'PUT', { ...updatePayload, email: 'admin@example.com' }, 'admin-token');
  const resDup = await worker.fetch(reqDup, { DB: wrappedDb });
  assert.equal(resDup.status, 409);
});

test('PUT /api/users/:id: last active ADMIN lockout protection', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');

  // Attempt to demote the last active admin -> 400
  const reqDemote = makeRequest('/api/users/USR-0001', 'PUT', {
    name: 'Zack Admin',
    email: 'admin@example.com',
    role: 'SALES_SUPPORT',
    status: 'ACTIVE',
    customerScope: 'ALL'
  }, 'admin-token');
  const resDemote = await worker.fetch(reqDemote, { DB: wrappedDb });
  assert.equal(resDemote.status, 400);
  const bodyDemote = await resDemote.json();
  assert.match(bodyDemote.message, /cannot demote the last active admin/i);

  // Attempt to deactivate the last active admin -> 400
  const reqDeactivate = makeRequest('/api/users/USR-0001', 'PUT', {
    name: 'Zack Admin',
    email: 'admin@example.com',
    role: 'ADMIN',
    status: 'INACTIVE',
    customerScope: 'ALL'
  }, 'admin-token');
  const resDeactivate = await worker.fetch(reqDeactivate, { DB: wrappedDb });
  assert.equal(resDeactivate.status, 400);
  const bodyDeactivate = await resDeactivate.json();
  assert.match(bodyDeactivate.message, /cannot deactivate or suspend the last active admin/i);
});

test('PUT /api/users/:id: block EXTERNAL_SALES role change if customers assigned', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sira', 'sira.p@ttpagro.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'sira-token');

  // Assign a customer to USR-0002
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id)
    VALUES (?, ?, ?, ?)
  `).run('CUST-1', 'C-1', 'Test Customer', 'USR-0002');

  // Attempt to change role of Sira to SALES_SUPPORT -> should be blocked
  const req = makeRequest('/api/users/USR-0002', 'PUT', {
    name: 'Sira',
    email: 'sira.p@ttpagro.com',
    role: 'SALES_SUPPORT',
    status: 'ACTIVE',
    customerScope: 'NONE'
  }, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.message, /cannot change role/i);
});

test('POST /api/users/:id/reset-password: ADMIN can reset, invalidates active sessions, requires password change', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');

  // Reset Alice password
  const req = makeRequest('/api/users/USR-0002/reset-password', 'POST', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.ok(body.data.temporaryPassword);
  assert.equal(body.data.user.mustChangePassword, true);

  // Sessions check: Alice's session should be deleted
  const session = db.prepare('SELECT * FROM sessions WHERE user_id = ?').get('USR-0002');
  assert.equal(session, undefined);

  // Stored password check
  const storedUser = db.prepare('SELECT * FROM users WHERE user_id = ?').get('USR-0002');
  assert.equal(storedUser.must_change_password, 1);

  const pwdRecord = {
    hash: storedUser.password_hash,
    salt: storedUser.password_salt,
    iterations: storedUser.password_iterations
  };
  const verified = await verifyPassword(body.data.temporaryPassword, pwdRecord);
  assert.equal(verified, true);
});

test('POST /api/users/:id/reset-password: MANAGER -> 403, unknown user -> 404', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Alice Manager', 'manager@example.com', 'MANAGER', 'ALL', 'manager-token');

  // MANAGER reset password -> 403
  const req1 = makeRequest('/api/users/USR-0001/reset-password', 'POST', null, 'manager-token');
  const res1 = await worker.fetch(req1, { DB: wrappedDb });
  assert.equal(res1.status, 403);

  // Unknown user -> 404
  const req2 = makeRequest('/api/users/USR-UNKNOWN/reset-password', 'POST', null, 'admin-token');
  const res2 = await worker.fetch(req2, { DB: wrappedDb });
  assert.equal(res2.status, 404);
});

test('Security regression test: verifyPassword matches exact structure generated by auth utilities', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'USR-0001', 'Zack Admin', 'admin@example.com', 'ADMIN', 'ALL', 'admin-token');
  await seedUserAndSession(db, 'USR-0002', 'Sira TTPagro', 'sira.p@ttpagro.com', 'EXTERNAL_SALES', 'OWN_CUSTOMERS', 'sira-token');

  // Reset Sira's password
  const req = makeRequest('/api/users/USR-0002/reset-password', 'POST', null, 'admin-token');
  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();

  const tempPassword = body.data.temporaryPassword;
  const userRecord = db.prepare('SELECT * FROM users WHERE user_id = ?').get('USR-0002');
  
  // Verify length constraints expected
  assert.equal(userRecord.password_hash.length, 43);
  assert.equal(userRecord.password_salt.length, 22);

  const pwdRecord = {
    hash: userRecord.password_hash,
    salt: userRecord.password_salt,
    iterations: userRecord.password_iterations
  };

  const verified = await verifyPassword(tempPassword, pwdRecord);
  assert.equal(verified, true);
});
