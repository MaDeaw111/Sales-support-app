import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  return {
    db,
    wrappedDb: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          params: [],
          bind(...params) {
            this.params = params;
            return this;
          },
          async first() {
            return statement.all(...this.params)[0] || null;
          },
          async all() {
            return { results: statement.all(...this.params), success: true };
          },
          async run() {
            return { success: true, meta: statement.run(...this.params) };
          }
        };
      }
    }
  };
}

async function seedUserAndSession(db, userId, role, token) {
  db.prepare('INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(userId, `${role} User`, `${userId}@example.com`, role, 'ALL', 'hash', 'salt');
  db.prepare('INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)')
    .run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 60000).toISOString());
}

function makeRequest(path, method = 'GET', body = null, token = null) {
  const headers = token ? { cookie: `wcat_session=${token}` } : {};
  if (body) headers['content-type'] = 'application/json';
  return new Request(`https://example.com${path}`, { method, headers, body: body ? JSON.stringify(body) : null });
}

test('service-partner routes require authentication and let operational readers list partners', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_SUPPORT', 'SALES_SUPPORT', 'support-token');

  const unauthenticated = await worker.fetch(makeRequest('/api/service-partners'), { DB: wrappedDb });
  assert.equal(unauthenticated.status, 401);

  const response = await worker.fetch(makeRequest('/api/service-partners', 'GET', null, 'support-token'), { DB: wrappedDb });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'SUCCESS', data: { servicePartners: [] } });
});

test('EXPORT can create and deactivate a service partner while external sales cannot write', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_EXPORT', 'EXPORT', 'export-token');
  await seedUserAndSession(db, 'U_SALES', 'EXTERNAL_SALES', 'sales-token');

  const denied = await worker.fetch(makeRequest('/api/service-partners', 'POST', { companyName: 'SGS', partnerType: 'SURVEYOR' }, 'sales-token'), { DB: wrappedDb });
  assert.equal(denied.status, 403);

  const created = await worker.fetch(makeRequest('/api/service-partners', 'POST', { companyName: 'SGS', partnerType: 'SURVEYOR' }, 'export-token'), { DB: wrappedDb });
  assert.equal(created.status, 200);
  const partner = (await created.json()).data.servicePartner;
  assert.equal(partner.status, 'ACTIVE');

  const updated = await worker.fetch(makeRequest(`/api/service-partners/${partner.partner_id}`, 'PATCH', { status: 'INACTIVE' }, 'export-token'), { DB: wrappedDb });
  assert.equal(updated.status, 200);
  assert.equal((await updated.json()).data.servicePartner.status, 'INACTIVE');
});

test('service-partner routes reject payload properties outside the approved master', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MANAGER', 'MANAGER', 'manager-token');

  const response = await worker.fetch(makeRequest('/api/service-partners', 'POST', {
    companyName: 'SGS',
    partnerType: 'SURVEYOR',
    contract: 'Not allowed'
  }, 'manager-token'), { DB: wrappedDb });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).message, 'SERVICE_PARTNER_PROPERTY_INVALID');
});
