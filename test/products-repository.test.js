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

test('Category repository operations', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Initial list is empty
  const cats0 = await repo.listCategories();
  assert.equal(cats0.length, 0);

  // Create category
  const cat = await repo.createCategory({ code: 'TAPIOCA', name: 'Tapioca Products', status: 'ACTIVE' });
  assert.ok(cat.id.startsWith('CAT-'));
  assert.equal(cat.code, 'TAPIOCA');
  assert.equal(cat.name, 'Tapioca Products');
  assert.equal(cat.status, 'ACTIVE');

  // List categories
  const cats1 = await repo.listCategories();
  assert.equal(cats1.length, 1);
  assert.equal(cats1[0].code, 'TAPIOCA');

  // Update category
  const updated = await repo.updateCategory(cat.id, { name: 'Tapioca Products Updated', status: 'INACTIVE' });
  assert.equal(updated.name, 'Tapioca Products Updated');
  assert.equal(updated.status, 'INACTIVE');
});

test('Form repository operations', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Initial list is empty
  const forms0 = await repo.listForms();
  assert.equal(forms0.length, 0);

  // Create form
  const form = await repo.createForm({ code: 'PELLET', name: 'Pellet', status: 'ACTIVE' });
  assert.ok(form.id.startsWith('FRM-'));
  assert.equal(form.code, 'PELLET');
  assert.equal(form.name, 'Pellet');

  // List forms
  const forms1 = await repo.listForms();
  assert.equal(forms1.length, 1);

  // Update form
  const updated = await repo.updateForm(form.id, { name: 'Pellet Form Updated', status: 'ACTIVE' });
  assert.equal(updated.name, 'Pellet Form Updated');
});

test('Product repository operations', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Create category and form first
  const cat = await repo.createCategory({ code: 'TAPIOCA', name: 'Tapioca Products', status: 'ACTIVE' });
  const form = await repo.createForm({ code: 'PELLET', name: 'Pellet', status: 'ACTIVE' });

  // Initial list is empty
  const prods0 = await repo.listProducts();
  assert.equal(prods0.length, 0);

  // Create product
  const prod = await repo.createProduct({
    code: 'THP65',
    name: 'Tapioca Hard Pellet 65%',
    shortName: 'THP_65',
    categoryId: cat.id,
    formId: form.id,
    hsCode: '1108.14',
    defaultUnit: 'MT',
    applications: ['FEED_GRADE', 'PET_GRADE'],
    status: 'ACTIVE'
  });

  assert.ok(prod.id.startsWith('PRD-'));
  assert.equal(prod.code, 'THP65');
  assert.equal(prod.name, 'Tapioca Hard Pellet 65%');
  assert.deepEqual(prod.applications, ['FEED_GRADE', 'PET_GRADE']);
  assert.equal(prod.category.code, 'TAPIOCA');
  assert.equal(prod.form.code, 'PELLET');

  // Find product by id
  const found = await repo.findProductById(prod.id);
  assert.ok(found);
  assert.equal(found.code, 'THP65');

  // Update product
  const updated = await repo.updateProduct(prod.id, {
    name: 'Tapioca Hard Pellet 65% Updated',
    shortName: 'THP_65_U',
    categoryId: cat.id,
    formId: form.id,
    hsCode: '1108.14.90',
    defaultUnit: 'KG',
    applications: ['PET_GRADE'],
    status: 'INACTIVE'
  });

  assert.equal(updated.name, 'Tapioca Hard Pellet 65% Updated');
  assert.deepEqual(updated.applications, ['PET_GRADE']);
  assert.equal(updated.defaultUnit, 'KG');
  assert.equal(updated.status, 'INACTIVE');
});

test('listProducts and findProductById include ACTIVE standardSpecs summary items only', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  const cat = await repo.createCategory({ code: 'TAPIOCA', name: 'Tapioca Products', status: 'ACTIVE' });
  const form = await repo.createForm({ code: 'PELLET', name: 'Pellet', status: 'ACTIVE' });
  const starch = await repo.createParameter({ code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 1 });
  const moisture = await repo.createParameter({ code: 'MOISTURE', name: 'Moisture', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 2 });

  const prod = await repo.createProduct({
    code: 'THP70',
    name: 'Tapioca Hard Pellet 70%',
    shortName: 'THP70',
    categoryId: cat.id,
    formId: form.id,
    applications: ['FEED_GRADE', 'PET_GRADE'],
    status: 'ACTIVE'
  });

  // Draft spec should NOT appear in active standardSpecs
  const draftFeed = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-11-19',
    notes: 'Draft only'
  });
  await repo.updateStandardSpecDraftItems(draftFeed.id, [
    { parameterId: starch.id, operator: 'MIN', numericValue: 70, unit: '%', sortOrder: 0, notes: '' },
    { parameterId: moisture.id, operator: 'MAX', numericValue: 13.5, unit: '%', sortOrder: 1, notes: '' }
  ]);

  let listed = await repo.listProducts();
  assert.equal(listed[0].standardSpecs.length, 0);

  // Activate spec -> appears in both listProducts and findProductById
  await repo.activateStandardSpec(draftFeed.id, 'USR-0001');
  listed = await repo.listProducts();
  assert.equal(listed[0].standardSpecs.length, 1);
  assert.equal(listed[0].standardSpecs[0].application, 'FEED_GRADE');
  assert.equal(listed[0].standardSpecs[0].items.length, 2);
  assert.equal(listed[0].standardSpecs[0].items[0].parameterCode, 'STARCH');
  assert.equal(listed[0].standardSpecs[0].items[0].numericValue, 70);

  const found = await repo.findProductById(prod.id);
  assert.equal(found.standardSpecs.length, 1);
  assert.equal(found.standardSpecs[0].items[1].parameterCode, 'MOISTURE');
  assert.equal(found.standardSpecs[0].items[1].numericValue, 13.5);
});
