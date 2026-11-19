import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

async function setupPricingDb() {
  const db = new DatabaseSync(':memory:');
  const migrations = [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql',
    '0008_logistics_partners.sql',
    '0009_commission_settlement.sql',
    '0010_booking_bl_no.sql',
    '0011_standard_price_history.sql'
  ];
  for (const name of migrations) {
    db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
  }

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

async function seedUser(db, userId, fullName, email, role, token) {
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt, password_iterations)
    VALUES (?, ?, ?, ?, 'ALL', 'ACTIVE', 'hash', 'salt', 100000)
  `).run(userId, fullName, email, role);
  const tokenHash = await hashSessionToken(token);
  const expires = new Date(Date.now() + 3600_000).toISOString();
  db.prepare(`
    INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(`SES-${userId}`, userId, tokenHash, expires);
}

function makeRequest(path, method = 'GET', body = null, token = null) {
  const headers = {};
  if (token) headers.cookie = `wcat_session=${token}`;
  if (body) headers['content-type'] = 'application/json';
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });
}

function seedProductsAndCustomers(db) {
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Products')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM-001', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('PRD-001', 'THP65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001', 'ACTIVE')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('PRD-002', 'THP70', 'Tapioca Hard Pellet 70%', 'THP70', 'CAT-001', 'FRM-001', 'ACTIVE')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('PRD-INACTIVE', 'OLD01', 'Legacy Inactive Product', 'OLD01', 'CAT-001', 'FRM-001', 'INACTIVE')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('CUST-001', 'C-001', 'Meelunie B.V.', 'USR-EXT1')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('CUST-002', 'C-002', 'Other Buyer', 'USR-EXT2')").run();
}

test('GET /api/pricing lists live ACTIVE D1 products with NOT_SET and enforces RBAC', async () => {
  const { db, wrappedDb } = await setupPricingDb();
  await seedUser(db, 'USR-MGR', 'Manager One', 'mgr@example.com', 'MANAGER', 'mgr-tok');
  await seedUser(db, 'USR-WH', 'Warehouse User', 'wh@example.com', 'PRODUCTION_WAREHOUSE', 'wh-tok');
  await seedUser(db, 'USR-EXT1', 'Ext Sales 1', 'ext1@example.com', 'EXTERNAL_SALES', 'ext1-tok');
  await seedUser(db, 'USR-EXT2', 'Ext Sales 2', 'ext2@example.com', 'EXTERNAL_SALES', 'ext2-tok');
  seedProductsAndCustomers(db);

  // Unauthenticated -> 401
  assert.equal((await worker.fetch(makeRequest('/api/pricing'), { DB: wrappedDb })).status, 401);
  // PRODUCTION_WAREHOUSE -> 403
  assert.equal((await worker.fetch(makeRequest('/api/pricing', 'GET', null, 'wh-tok'), { DB: wrappedDb })).status, 403);

  // Manager sees both ACTIVE products as NOT_SET and does NOT see INACTIVE product
  const res = await worker.fetch(makeRequest('/api/pricing', 'GET', null, 'mgr-tok'), { DB: wrappedDb });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.standardPrices.length, 2);
  assert.deepEqual(body.data.standardPrices.map(x => x.productId), ['PRD-001', 'PRD-002']);
  assert.equal(body.data.standardPrices[0].status, 'NOT_SET');
  assert.equal(body.data.standardPrices[0].hasActivePrice, false);
});

test('Standard Price versioning preserves immutable history and Manager/Admin RBAC protects history endpoints', async () => {
  const { db, wrappedDb } = await setupPricingDb();
  await seedUser(db, 'USR-ADM', 'Admin User', 'adm@example.com', 'ADMIN', 'adm-tok');
  await seedUser(db, 'USR-MGR', 'Manager User', 'mgr@example.com', 'MANAGER', 'mgr-tok');
  await seedUser(db, 'USR-SUP', 'Sales Support', 'sup@example.com', 'SALES_SUPPORT', 'sup-tok');
  await seedUser(db, 'USR-EXT1', 'Ext Sales 1', 'ext1@example.com', 'EXTERNAL_SALES', 'ext1-tok');
  await seedUser(db, 'USR-EXT2', 'Ext Sales 2', 'ext2@example.com', 'EXTERNAL_SALES', 'ext2-tok');
  await seedUser(db, 'USR-EXP', 'Export Staff', 'exp@example.com', 'EXPORT', 'exp-tok');
  await seedUser(db, 'USR-WH', 'Warehouse Staff', 'wh@example.com', 'PRODUCTION_WAREHOUSE', 'wh-tok');
  seedProductsAndCustomers(db);

  // Non-manager/non-admin blocked from setting standard price
  for (const token of ['sup-tok', 'ext1-tok', 'exp-tok', 'wh-tok']) {
    const denied = await worker.fetch(makeRequest('/api/pricing/standard/PRD-001', 'PUT', {
      pricePerMt: 185,
      effectiveFrom: '2026-11-01'
    }, token), { DB: wrappedDb });
    assert.equal(denied.status, 403);
  }

  // 1. MANAGER sets initial Standard Price (Rev.1)
  let res = await worker.fetch(makeRequest('/api/pricing/standard/PRD-001', 'PUT', {
    pricePerMt: 185,
    currency: 'USD',
    effectiveFrom: '2026-11-01',
    validUntil: '2026-11-30',
    changeReason: 'Initial November list price'
  }, 'mgr-tok'), { DB: wrappedDb });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.equal(body.data.standardPrice.revisionNo, 1);
  assert.equal(body.data.standardPrice.pricePerMt, 185);
  assert.equal(body.data.standardPrice.previousPricePerMt, null);
  assert.equal(body.data.standardPrice.status, 'ACTIVE');

  // 2. ADMIN updates Standard Price (Rev.2 -> Rev.1 becomes SUPERSEDED)
  res = await worker.fetch(makeRequest('/api/pricing/standard/PRD-001', 'PUT', {
    pricePerMt: 192.5,
    currency: 'USD',
    effectiveFrom: '2026-11-20',
    validUntil: '2026-12-31',
    changeReason: 'Raw cassava root cost increase'
  }, 'adm-tok'), { DB: wrappedDb });
  assert.equal(res.status, 200);
  body = await res.json();
  assert.equal(body.data.standardPrice.revisionNo, 2);
  assert.equal(body.data.standardPrice.pricePerMt, 192.5);
  assert.equal(body.data.standardPrice.previousPricePerMt, 185);
  assert.equal(body.data.standardPrice.historyCount, 2);

  // 3. Create and approve a Special Price for PRD-001
  res = await worker.fetch(makeRequest('/api/pricing/special', 'POST', {
    customerId: 'CUST-001',
    productId: 'PRD-001',
    approvedPriceUsd: 188,
    expectedQtyMt: 540,
    validUntil: '2026-12-15',
    reason: 'Volume contract discount'
  }, 'ext1-tok'), { DB: wrappedDb });
  assert.equal(res.status, 200);
  const sprId = (await res.json()).data.specialPrice.id;

  // EXTERNAL_SALES cannot request special price for unowned customer
  res = await worker.fetch(makeRequest('/api/pricing/special', 'POST', {
    customerId: 'CUST-002',
    productId: 'PRD-001',
    approvedPriceUsd: 180
  }, 'ext1-tok'), { DB: wrappedDb });
  assert.equal(res.status, 403);

  // MANAGER approves special price
  res = await worker.fetch(makeRequest(`/api/pricing/special/${sprId}/review`, 'POST', {
    decision: 'APPROVE'
  }, 'mgr-tok'), { DB: wrappedDb });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.specialPrice.approvalStatus, 'APPROVED');

  // 4. Price History RBAC: 403 for SALES_SUPPORT, EXTERNAL_SALES, EXPORT, PRODUCTION_WAREHOUSE
  for (const token of ['sup-tok', 'ext1-tok', 'exp-tok', 'wh-tok']) {
    assert.equal((await worker.fetch(makeRequest('/api/pricing/products/PRD-001/history', 'GET', null, token), { DB: wrappedDb })).status, 403);
    assert.equal((await worker.fetch(makeRequest('/api/pricing/history', 'GET', null, token), { DB: wrappedDb })).status, 403);
  }

  // 5. MANAGER and ADMIN receive full chronological Standard Price + Approved Special Price history
  for (const token of ['mgr-tok', 'adm-tok']) {
    const histRes = await worker.fetch(makeRequest('/api/pricing/products/PRD-001/history', 'GET', null, token), { DB: wrappedDb });
    assert.equal(histRes.status, 200);
    const histBody = await histRes.json();
    assert.equal(histBody.data.product.code, 'THP65');
    assert.equal(histBody.data.standardPriceHistory.length, 2);
    assert.equal(histBody.data.standardPriceHistory[0].revisionNo, 2);
    assert.equal(histBody.data.standardPriceHistory[0].status, 'ACTIVE');
    assert.equal(histBody.data.standardPriceHistory[0].previousPricePerMt, 185);
    assert.equal(histBody.data.standardPriceHistory[0].pricePerMt, 192.5);
    assert.equal(histBody.data.standardPriceHistory[0].changedByName, 'Admin User');
    assert.equal(histBody.data.standardPriceHistory[0].changeReason, 'Raw cassava root cost increase');
    assert.equal(histBody.data.standardPriceHistory[1].revisionNo, 1);
    assert.equal(histBody.data.standardPriceHistory[1].status, 'SUPERSEDED');
    assert.equal(histBody.data.standardPriceHistory[1].changedByName, 'Manager User');
    assert.equal(histBody.data.approvedSpecialPriceHistory.length, 1);
    assert.equal(histBody.data.approvedSpecialPriceHistory[0].approvedPriceUsd, 188);
  }
});
