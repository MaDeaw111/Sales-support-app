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

test('Customer Spec Repository Lifecycle', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Setup Product & Application & Parameter & Customer & Standard Spec
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
  const param = await repo.createParameter({
    code: 'STARCH',
    name: 'Starch Content',
    dataType: 'NUMBER',
    defaultUnit: '%',
    status: 'ACTIVE',
    sortOrder: 1
  });
  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name)
    VALUES ('CUST-001', 'ABC-FEED', 'ABC Feed Corp')
  `).run();

  const stdSpec = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-08-26',
    notes: 'Initial standard spec',
    createdBy: 'USR-0001'
  });
  // Must activate standard spec first (base spec must be ACTIVE)
  const activeStd = await repo.activateStandardSpec(stdSpec.id, 'USR-0001');

  // 1. Create customer spec draft (should start at Rev.0)
  const spec1 = await repo.createCustomerSpecDraft({
    customerId: 'CUST-001',
    productId: prod.id,
    application: 'FEED_GRADE',
    baseStandardSpecId: activeStd.id,
    effectiveDate: '2026-08-26',
    notes: 'Customer spec draft',
    createdBy: 'USR-0001'
  });

  assert.ok(spec1.id.startsWith('CSP-'));
  assert.equal(spec1.revisionNo, 0);
  assert.equal(spec1.status, 'DRAFT');

  // 2. Add overrides to draft
  const overrides = [
    {
      parameterId: param.id,
      operator: 'MIN',
      numericValue: 66, // Standard is 65 (we haven't set standard items yet, but we override anyway)
      unit: '%'
    }
  ];
  const specWithOverrides = await repo.updateCustomerSpecDraftOverrides(spec1.id, overrides, 'USR-0001');
  assert.equal(specWithOverrides.overrides.length, 1);
  assert.equal(specWithOverrides.overrides[0].numericValue, 66);

  // 3. Activate Customer Spec
  const activeSpec1 = await repo.activateCustomerSpec(spec1.id, 'USR-0001');
  assert.equal(activeSpec1.status, 'ACTIVE');

  // 4. Try updating overrides on an ACTIVE spec should throw an error
  await assert.rejects(async () => {
    await repo.updateCustomerSpecDraftOverrides(spec1.id, overrides, 'USR-0001');
  }, /Cannot edit/);

  // 5. Create new draft customer spec (Rev.1)
  const spec2 = await repo.createCustomerSpecDraft({
    customerId: 'CUST-001',
    productId: prod.id,
    application: 'FEED_GRADE',
    baseStandardSpecId: activeStd.id,
    effectiveDate: '2026-08-27',
    notes: 'Customer spec draft Rev 1',
    createdBy: 'USR-0001'
  });

  assert.equal(spec2.revisionNo, 1);

  // 6. Activate Rev.1 (should auto-archive Rev.0)
  const activeSpec2 = await repo.activateCustomerSpec(spec2.id, 'USR-0001');
  assert.equal(activeSpec2.status, 'ACTIVE');

  const oldSpec = await repo.findCustomerSpecById(spec1.id);
  assert.equal(oldSpec.status, 'ARCHIVED');
});
