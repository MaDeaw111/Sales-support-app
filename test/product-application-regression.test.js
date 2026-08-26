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

test('Product Applications Diff Update & Constraints - Finding 2', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Setup initial master data
  const cat = await repo.createCategory({ code: 'TAPIOCA', name: 'Tapioca', status: 'ACTIVE' });
  const form = await repo.createForm({ code: 'PELLET', name: 'Pellet', status: 'ACTIVE' });

  // Create product with PET_GRADE
  const prod = await repo.createProduct({
    code: 'THP_PET',
    name: 'Tapioca hard pellet pet',
    shortName: 'THPP',
    categoryId: cat.id,
    formId: form.id,
    applications: ['PET_GRADE'],
    status: 'ACTIVE'
  });

  // A. Create Standard Spec for PET_GRADE. Update only product name keeping PET_GRADE. Succeeds.
  await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'PET_GRADE',
    effectiveDate: '2026-08-26',
    notes: 'Base spec',
    createdBy: 'USR-0001'
  });

  const updatedName = await repo.updateProduct(prod.id, {
    name: 'Tapioca hard pellet pet UPDATEDName',
    shortName: 'THPP',
    categoryId: cat.id,
    formId: form.id,
    applications: ['PET_GRADE'],
    status: 'ACTIVE'
  });
  assert.equal(updatedName.name, 'Tapioca hard pellet pet UPDATEDName');

  // B. Try to remove PET_GRADE. Expected: controlled validation error.
  await assert.rejects(async () => {
    await repo.updateProduct(prod.id, {
      name: 'Tapioca hard pellet pet UPDATEDName',
      shortName: 'THPP',
      categoryId: cat.id,
      formId: form.id,
      applications: ['FEED_GRADE'], // Trying to swap PET_GRADE to FEED_GRADE
      status: 'ACTIVE'
    });
  }, /Cannot remove PET_GRADE because specification history exists/);

  // C. Add FEED_GRADE. Succeeds without deleting PET_GRADE.
  const withBoth = await repo.updateProduct(prod.id, {
    name: 'Tapioca hard pellet pet UPDATEDName',
    shortName: 'THPP',
    categoryId: cat.id,
    formId: form.id,
    applications: ['PET_GRADE', 'FEED_GRADE'],
    status: 'ACTIVE'
  });
  assert.deepEqual(withBoth.applications.sort(), ['FEED_GRADE', 'PET_GRADE']);

  // D. Product has PET_GRADE + FEED_GRADE and no spec history for FEED_GRADE. Remove FEED_GRADE. Succeeds.
  const backToPet = await repo.updateProduct(prod.id, {
    name: 'Tapioca hard pellet pet UPDATEDName',
    shortName: 'THPP',
    categoryId: cat.id,
    formId: form.id,
    applications: ['PET_GRADE'],
    status: 'ACTIVE'
  });
  assert.deepEqual(backToPet.applications, ['PET_GRADE']);

  // E. Reject zero applications.
  await assert.rejects(async () => {
    await repo.updateProduct(prod.id, {
      name: 'Tapioca hard pellet pet',
      shortName: 'THPP',
      categoryId: cat.id,
      formId: form.id,
      applications: [],
      status: 'ACTIVE'
    });
  }, /must retain at least one valid application/);
});
