import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPriceNoteRepository } from '../src/price-notes/repository.js';

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

test('Manager Price Notes repository lifecycle', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createPriceNoteRepository(wrappedDb);

  // Seed references
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U2', 'manager@example.com', 'hash', 'salt', 'MANAGER', 'ACTIVE', 'Manager Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // Create valid note
  const note = await repo.createPriceNote({
    salesUserId: 'U1',
    customerId: 'C1',
    productId: 'P1',
    incoterm: 'CFR',
    destinationPort: 'Rotterdam',
    offerPriceUsdPerMt: 355.50,
    note: 'Instruct sales to offer Rotterdam price'
  }, 'U2');

  assert.ok(note.id.startsWith('PN-'));
  assert.equal(note.offer_price_usd_per_mt, 355.50);
  assert.equal(note.destination_port, 'Rotterdam');

  // Verify list
  const list = await repo.listPriceNotes({});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, note.id);

  // Reject offering price <= 0
  await assert.rejects(async () => {
    await repo.createPriceNote({
      salesUserId: 'U1',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'FOB',
      offerPriceUsdPerMt: 0,
      note: 'Zero price note'
    }, 'U2');
  }, /Offer price must be greater than zero/);

  // Reject CFR/CIF without destination port
  await assert.rejects(async () => {
    await repo.createPriceNote({
      salesUserId: 'U1',
      customerId: 'C1',
      productId: 'P1',
      incoterm: 'CFR',
      destinationPort: '',
      offerPriceUsdPerMt: 355.50,
      note: 'Empty port'
    }, 'U2');
  }, /Destination port is required for CFR and CIF/);
});
