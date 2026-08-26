import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShipmentRepository } from '../src/shipments/repository.js';

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

test('Expense Category repository listing and creation', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShipmentRepository(wrappedDb);

  // Check initial seeded list
  const cats = await repo.listExpenseCategories();
  assert.equal(cats.length, 12);
  
  // Ocean Freight is sorted first by sort_order
  assert.equal(cats[0].category_code, 'OCEAN_FREIGHT_COST');
  assert.equal(cats[0].category_group, 'OCEAN_FREIGHT');

  // Create active/inactive custom category
  const newCat = await repo.createExpenseCategory({
    id: 'CAT-TEST',
    code: 'TEST_EXTRA',
    name: 'Test Extra Expense',
    categoryGroup: 'OTHER',
    status: 'ACTIVE',
    sortOrder: 500
  });

  assert.equal(newCat.category_code, 'TEST_EXTRA');

  const catsUpdated = await repo.listExpenseCategories();
  assert.equal(catsUpdated.length, 13);
});

import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(userId, 'Test User', `${userId}@example.com`, role, 'ALL', 'hash', 'salt');

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

test('POST /api/expense-categories RBAC controls', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'token-admin');
  await seedUserAndSession(db, 'U_SALES', 'EXTERNAL_SALES', 'token-sales');

  const payload = {
    code: 'NEW_CODE',
    name: 'New Name',
    categoryGroup: 'OTHER',
    status: 'ACTIVE',
    sortOrder: 10
  };

  // 1. Unauthorized gets 403
  const reqSales = makeRequest('/api/expense-categories', 'POST', payload, 'token-sales');
  const resSales = await worker.fetch(reqSales, { DB: wrappedDb });
  assert.equal(resSales.status, 403);

  // 2. Admin is allowed
  const reqAdmin = makeRequest('/api/expense-categories', 'POST', payload, 'token-admin');
  const resAdmin = await worker.fetch(reqAdmin, { DB: wrappedDb });
  assert.equal(resAdmin.status, 200);

  const data = await resAdmin.json();
  assert.equal(data.status, 'SUCCESS');
  assert.equal(data.data.category.category_code, 'NEW_CODE');
});
