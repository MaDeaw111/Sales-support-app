import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { validateSpecItems } from '../src/products/validation.js';

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
    }
  };

  return { db, wrappedDb };
}

test('validateSpecItems validation scenarios', async () => {
  const { db, wrappedDb } = await setupTestDb();

  // Seed parameters
  db.prepare(`
    INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit)
    VALUES ('PAR-001', 'STARCH', 'Starch Content', 'NUMBER', '%')
  `).run();
  db.prepare(`
    INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit)
    VALUES ('PAR-002', 'COLOR', 'Color', 'TEXT', '-')
  `).run();

  // 1. Valid items list (number with MIN, using default unit)
  const items1 = [
    {
      parameterId: 'PAR-001',
      operator: 'MIN',
      numericValue: 65
    }
  ];
  const validated1 = await validateSpecItems(wrappedDb, items1);
  assert.equal(validated1.length, 1);
  assert.equal(validated1[0].unit, '%'); // Default unit populated

  // 2. Reject duplicate parameters in same list
  const itemsDuplicate = [
    { parameterId: 'PAR-001', operator: 'MIN', numericValue: 65 },
    { parameterId: 'PAR-001', operator: 'MAX', numericValue: 70 }
  ];
  await assert.rejects(async () => {
    await validateSpecItems(wrappedDb, itemsDuplicate);
  }, /Duplicate parameter/);

  // 3. Reject numeric operator on TEXT parameter
  const itemsTextInvalid = [
    { parameterId: 'PAR-002', operator: 'MIN', textValue: 'Light cream' }
  ];
  await assert.rejects(async () => {
    await validateSpecItems(wrappedDb, itemsTextInvalid);
  }, /Text parameter must use TEXT operator/);

  // 4. Reject TEXT operator on NUMBER parameter
  const itemsNumInvalid = [
    { parameterId: 'PAR-001', operator: 'TEXT', textValue: '65%' }
  ];
  await assert.rejects(async () => {
    await validateSpecItems(wrappedDb, itemsNumInvalid);
  }, /Numeric parameter/);

  // 5. RANGE validations
  // 5a. Range where lower bound is missing
  await assert.rejects(async () => {
    await validateSpecItems(wrappedDb, [{ parameterId: 'PAR-001', operator: 'RANGE', numericValueTo: 10 }]);
  }, /RANGE operator requires both bounds/);

  // 5b. Range where upper <= lower
  await assert.rejects(async () => {
    await validateSpecItems(wrappedDb, [{ parameterId: 'PAR-001', operator: 'RANGE', numericValue: 10, numericValueTo: 8 }]);
  }, /RANGE upper bound must be greater than lower bound/);

  // 5c. Valid range
  const validatedRange = await validateSpecItems(wrappedDb, [{ parameterId: 'PAR-001', operator: 'RANGE', numericValue: 6, numericValueTo: 10 }]);
  assert.equal(validatedRange.length, 1);
});
