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
