import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createProductRepository, sortProductSpecItems } from '../src/products/repository.js';

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

test('Standard Spec Repository Lifecycle', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

  // Setup Product & Application & Parameter
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

  // 1. Create standard spec draft (should start at Rev.0)
  const spec1 = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-08-26',
    notes: 'Initial standard spec draft',
    createdBy: 'USR-0001'
  });

  assert.ok(spec1.id.startsWith('STD-'));
  assert.equal(spec1.revisionNo, 0);
  assert.equal(spec1.status, 'DRAFT');

  // 2. Add spec items to draft
  const items = [
    {
      parameterId: param.id,
      operator: 'MIN',
      numericValue: 65,
      unit: '%'
    }
  ];
  const specWithItems = await repo.updateStandardSpecDraftItems(spec1.id, items, 'USR-0001');
  assert.equal(specWithItems.items.length, 1);
  assert.equal(specWithItems.items[0].numericValue, 65);

  // 3. Activate Standard Spec
  const activeSpec1 = await repo.activateStandardSpec(spec1.id, 'USR-0001');
  assert.equal(activeSpec1.status, 'ACTIVE');

  // 4. Try updating items on an ACTIVE spec should throw an error
  await assert.rejects(async () => {
    await repo.updateStandardSpecDraftItems(spec1.id, items, 'USR-0001');
  }, /Cannot edit/);

  // 5. Create new draft standard spec (should copy items from active spec, Rev.1)
  const spec2 = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-08-27',
    notes: 'Revision 1 draft spec',
    createdBy: 'USR-0001'
  });

  assert.equal(spec2.revisionNo, 1);
  // Items should be copied automatically
  assert.equal(spec2.items.length, 1);
  assert.equal(spec2.items[0].numericValue, 65);

  // 6. Activate Rev.1 (should auto-archive Rev.0)
  const activeSpec2 = await repo.activateStandardSpec(spec2.id, 'USR-0001');
  assert.equal(activeSpec2.status, 'ACTIVE');

  const oldSpec = await repo.findStandardSpecById(spec1.id);
  assert.equal(oldSpec.status, 'ARCHIVED');
});

test('Canonical standard spec parameter ordering across listProducts, findProductById, and findStandardSpecById', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createProductRepository(wrappedDb);

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

  // Intentionally create parameters and spec items out of canonical order with inverted sortOrder
  const pMoisture = await repo.createParameter({ code: 'MOISTURE', name: 'Moisture', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 1 });
  const pFiber = await repo.createParameter({ code: 'FIBER', name: 'Fiber', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 2 });
  const pAsh = await repo.createParameter({ code: 'ASH', name: 'Ash', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 10 });
  const pStarch = await repo.createParameter({ code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 50 });
  const pSand = await repo.createParameter({ code: 'SAND_SILICA', name: 'Sand & Silica', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 40 });
  const pColor = await repo.createParameter({ code: 'COLOR', name: 'Color', dataType: 'TEXT', defaultUnit: '', status: 'ACTIVE', sortOrder: 20 });
  const pProtein = await repo.createParameter({ code: 'PROTEIN', name: 'Protein', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 30 });

  const draft = await repo.createStandardSpecDraft({
    productId: prod.id,
    application: 'FEED_GRADE',
    effectiveDate: '2026-08-26',
    notes: 'Canonical order test',
    createdBy: 'USR-0001'
  });

  await repo.updateStandardSpecDraftItems(draft.id, [
    { parameterId: pMoisture.id, operator: 'MAX', numericValue: 14, unit: '%', sortOrder: 1 },
    { parameterId: pFiber.id, operator: 'MAX', numericValue: 5, unit: '%', sortOrder: 2 },
    { parameterId: pColor.id, operator: 'TEXT', textValue: 'Cream', unit: '', sortOrder: 20 },
    { parameterId: pStarch.id, operator: 'MIN', numericValue: 65, unit: '%', sortOrder: 50 },
    { parameterId: pSand.id, operator: 'MAX', numericValue: 3, unit: '%', sortOrder: 40 },
    { parameterId: pAsh.id, operator: 'MAX', numericValue: 4, unit: '%', sortOrder: 10 },
    { parameterId: pProtein.id, operator: 'MIN', numericValue: 2, unit: '%', sortOrder: 30 }
  ], 'USR-0001');

  await repo.activateStandardSpec(draft.id, 'USR-0001');

  const expectedCodes = ['STARCH', 'PROTEIN', 'MOISTURE', 'SAND_SILICA', 'FIBER', 'ASH', 'COLOR'];

  const bySpecId = await repo.findStandardSpecById(draft.id);
  assert.deepEqual(bySpecId.items.map(i => i.parameterCode), expectedCodes);

  const byProductId = await repo.findProductById(prod.id);
  assert.deepEqual(byProductId.standardSpecs[0].items.map(i => i.parameterCode), expectedCodes);

  const listed = await repo.listProducts();
  const listedProd = listed.find(p => p.id === prod.id);
  assert.deepEqual(listedProd.standardSpecs[0].items.map(i => i.parameterCode), expectedCodes);

  // Direct helper check for case-insensitive name matching when code is non-standard
  const directSorted = sortProductSpecItems([
    { parameterName: 'Moisture', sortOrder: 1 },
    { parameterName: 'Fiber', sortOrder: 2 },
    { parameterName: 'pH', sortOrder: 2 },
    { parameterName: 'Starch', sortOrder: 5 },
    { parameterName: 'Sand & Silica', sortOrder: 4 },
    { parameterName: 'Protein', sortOrder: 3 },
    { parameterName: 'Ash', sortOrder: 1 }
  ]);
  assert.deepEqual(
    directSorted.map(i => i.parameterName),
    ['Starch', 'Protein', 'Moisture', 'Sand & Silica', 'Fiber', 'Ash', 'pH']
  );
});
