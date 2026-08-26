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

test('Freight Quotes repository lifecycle', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createPriceNoteRepository(wrappedDb);

  // Seed reference user
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();

  // Create valid freight quote
  const quote = await repo.createFreightQuote({
    originPort: 'Laem Chabang',
    destinationPort: 'Rotterdam',
    containerSize: "20' GP",
    shippingLineOrForwarder: 'Maersk',
    quotedFreightUsdPerContainer: 1450.00,
    validUntil: '2026-12-31',
    remark: 'Valid for Q3'
  }, 'U1');

  assert.ok(quote.quote_id.startsWith('FQ-'));
  assert.equal(quote.quoted_freight_usd_per_container, 1450.00);

  // Verify list
  const list = await repo.listFreightQuotes();
  assert.equal(list.length, 1);
  assert.equal(list[0].quote_id, quote.quote_id);

  // Reject invalid freight quote amount
  await assert.rejects(async () => {
    await repo.createFreightQuote({
      originPort: 'Laem Chabang',
      destinationPort: 'Rotterdam',
      containerSize: "20' GP",
      shippingLineOrForwarder: 'Maersk',
      quotedFreightUsdPerContainer: -50.00,
      validUntil: '2026-12-31'
    }, 'U1');
  }, /Quoted freight must be greater than zero/);
});
