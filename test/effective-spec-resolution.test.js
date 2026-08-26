import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createProductRepository } from '../src/products/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);
  const productSpecsSql = await readFile(new URL('../migrations/0003_product_specs.sql', import.meta.url), 'utf8');
  db.exec(productSpecsSql);

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

test('Effective Customer Spec Resolution', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Setup Product, Customer, Parameters
  const cat = await repo.createCategory({ code: 'TAPIOCA', name: 'Tapioca', status: 'ACTIVE' });
  const form = await repo.createForm({ code: 'PELLET', name: 'Pellet', status: 'ACTIVE' });
  const prod = await repo.createProduct({
    code: 'THP65',
    name: 'Tapioca Hard Pellet 65%',
    shortName: 'THP65',
    categoryId: cat.id,
    formId: form.id,
    applications: ['FEED_GRADE'],
    status: 'ACTIVE'
  });
  const paramStarch = await repo.createParameter({
    code: 'STARCH',
    name: 'Starch Content',
    dataType: 'NUMBER',
    defaultUnit: '%',
    status: 'ACTIVE',
    sortOrder: 1
  });
  const paramMoisture = await repo.createParameter({
    code: 'MOISTURE',
    name: 'Moisture Content',
    dataType: 'NUMBER',
    defaultUnit: '%',
    status: 'ACTIVE',
    sortOrder: 2
  });
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name)
    VALUES ('CUST-001', 'ABC-FEED', 'ABC Feed Corp')
  `).run();

  // Create Standard Spec
  const stdSpec = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-08-26',
    notes: 'Base spec',
    createdBy: 'USR-0001'
  });

  await repo.updateStandardSpecDraftItems(stdSpec.id, [
    { parameterId: paramStarch.id, operator: 'MIN', numericValue: 65, unit: '%' },
    { parameterId: paramMoisture.id, operator: 'MAX', numericValue: 14, unit: '%' }
  ], 'USR-0001');

  const activeStd = await repo.activateStandardSpec(stdSpec.id, 'USR-0001');

  // Create Customer Spec with override on Moisture
  const custSpec = await repo.createCustomerSpecDraft({
    customerId: 'CUST-001',
    productId: prod.id,
    application: 'FEED_GRADE',
    baseStandardSpecId: activeStd.id,
    effectiveDate: '2026-08-26',
    notes: 'Moisture override',
    createdBy: 'USR-0001'
  });

  await repo.updateCustomerSpecDraftOverrides(custSpec.id, [
    { parameterId: paramMoisture.id, operator: 'MAX', numericValue: 13.5, unit: '%' }
  ], 'USR-0001');

  // Resolve Effective Spec
  const effective = await repo.resolveEffectiveCustomerSpec(custSpec.id);
  assert.equal(effective.items.length, 2);

  // Starch should be inherited
  const starchItem = effective.items.find(i => i.parameterCode === 'STARCH');
  assert.ok(starchItem);
  assert.equal(starchItem.operator, 'MIN');
  assert.equal(starchItem.numericValue, 65);
  assert.equal(starchItem.source, 'INHERITED');

  // Moisture should be overridden
  const moistureItem = effective.items.find(i => i.parameterCode === 'MOISTURE');
  assert.ok(moistureItem);
  assert.equal(moistureItem.operator, 'MAX');
  assert.equal(moistureItem.numericValue, 13.5);
  assert.equal(moistureItem.source, 'OVERRIDDEN');
});
