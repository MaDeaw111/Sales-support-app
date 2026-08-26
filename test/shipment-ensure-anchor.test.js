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

test('POST /api/shipments/:id/ensure creates PO and Shipment anchors when PO does not exist', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'token-mgr');

  // Seed customer, product (needed because of foreign keys on pos)
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const req = new Request('https://example.com/api/shipments/SH_NEW/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-mgr',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'CFR',
      destinationPort: 'Rotterdam',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  const body = await res.json();
  assert.equal(res.status, 200, `Expected status 200, got: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'SUCCESS');

  // Verify DB contents
  const po = db.prepare("SELECT * FROM pos WHERE po_id = 'PO_NEW'").get();
  assert.ok(po);
  assert.equal(po.incoterm, 'CFR');
  assert.equal(po.destination_port, 'Rotterdam');

  const sh = db.prepare("SELECT * FROM shipments WHERE shipment_id = 'SH_NEW'").get();
  assert.ok(sh);
  assert.equal(sh.po_id, 'PO_NEW');
});

test('POST /api/shipments/:id/ensure rejects CFR/CIF without destination port', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'token-mgr');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca 65%', 'THP65', 'CAT1', 'FRM1')").run();

  const req = new Request('https://example.com/api/shipments/SH_NEW2/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-mgr',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW2',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'CFR',
      destinationPort: '',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  const body = await res.json();
  assert.equal(res.status, 400);
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /destination port/i);
});

test('POST /api/shipments/:id/ensure rejects unauthorized roles with 403', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_SALES', 'EXTERNAL_SALES', 'token-sales');

  const req = new Request('https://example.com/api/shipments/SH_NEW/ensure', {
    method: 'POST',
    headers: {
      'cookie': 'wcat_session=token-sales',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      poId: 'PO_NEW',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'FOB',
      isOneContainer: 1
    })
  });

  const res = await worker.fetch(req, { DB: wrappedDb });
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.status, 'ERROR');
  assert.match(body.message, /permission denied/i);
});
