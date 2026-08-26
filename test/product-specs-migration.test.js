import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);
  const productSpecsSql = await readFile(new URL('../migrations/0003_product_specs.sql', import.meta.url), 'utf8');
  db.exec(productSpecsSql);
  return db;
}

test('Unique product code constraint is enforced', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
      VALUES ('PRD-002', 'THP-65', 'Tapioca Hard Pellet 65% Copy', 'THP65C', 'CAT-001', 'FRM-001')
    `).run();
  }, /UNIQUE constraint failed: products\.product_code/);
});

test('Duplicate Product/Application on product_applications is rejected', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  db.prepare(`
    INSERT INTO product_applications (product_id, application)
    VALUES ('PRD-001', 'FEED_GRADE')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO product_applications (product_id, application)
      VALUES ('PRD-001', 'FEED_GRADE')
    `).run();
  }, /UNIQUE constraint failed: product_applications\.product_id, product_applications\.application/);
});

test('Duplicate revision_no on standard_specs is rejected', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  db.prepare(`
    INSERT INTO product_applications (product_id, application)
    VALUES ('PRD-001', 'FEED_GRADE')
  `).run();

  db.prepare(`
    INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
    VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'DRAFT', '2026-08-26')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
      VALUES ('STD-002', 'PRD-001', 'FEED_GRADE', 0, 'DRAFT', '2026-08-26')
    `).run();
  }, /UNIQUE constraint failed: standard_specs\.product_id, standard_specs\.application, standard_specs\.revision_no/);
});

test('Duplicate parameter within same standard spec revision is rejected', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  db.prepare(`
    INSERT INTO product_applications (product_id, application)
    VALUES ('PRD-001', 'FEED_GRADE')
  `).run();

  db.prepare(`
    INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit)
    VALUES ('PAR-001', 'STARCH', 'Starch Content', 'NUMBER', '%')
  `).run();

  db.prepare(`
    INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
    VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'DRAFT', '2026-08-26')
  `).run();

  db.prepare(`
    INSERT INTO standard_spec_items (standard_spec_item_id, standard_spec_id, parameter_id, operator, numeric_value, unit)
    VALUES ('STI-001', 'STD-001', 'PAR-001', 'MIN', 65.0, '%')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO standard_spec_items (standard_spec_item_id, standard_spec_id, parameter_id, operator, numeric_value, unit)
      VALUES ('STI-002', 'STD-001', 'PAR-001', 'MAX', 70.0, '%')
    `).run();
  }, /UNIQUE constraint failed: standard_spec_items\.standard_spec_id, standard_spec_items\.parameter_id/);
});

test('Only one ACTIVE standard spec is allowed per (product_id, application)', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  db.prepare(`
    INSERT INTO product_applications (product_id, application)
    VALUES ('PRD-001', 'FEED_GRADE')
  `).run();

  db.prepare(`
    INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
    VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-26')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
      VALUES ('STD-002', 'PRD-001', 'FEED_GRADE', 1, 'ACTIVE', '2026-08-26')
    `).run();
  }, /UNIQUE constraint failed/);
});

test('Only one ACTIVE customer spec is allowed per (customer_id, product_id, application)', async () => {
  const db = await setupTestDb();
  
  db.prepare(`
    INSERT INTO product_categories (category_id, category_code, category_name)
    VALUES ('CAT-001', 'TAPIOCA', 'Tapioca Product')
  `).run();

  db.prepare(`
    INSERT INTO product_forms (form_id, form_code, form_name)
    VALUES ('FRM-001', 'PELLET', 'Pellet')
  `).run();

  db.prepare(`
    INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id)
    VALUES ('PRD-001', 'THP-65', 'Tapioca Hard Pellet 65%', 'THP65', 'CAT-001', 'FRM-001')
  `).run();

  db.prepare(`
    INSERT INTO product_applications (product_id, application)
    VALUES ('PRD-001', 'FEED_GRADE')
  `).run();

  db.prepare(`
    INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date)
    VALUES ('STD-001', 'PRD-001', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-26')
  `).run();

  db.prepare(`
    INSERT INTO customers (customer_id, customer_code, customer_name)
    VALUES ('CUST-001', 'ABC-FEED', 'ABC Feed Corp')
  `).run();

  db.prepare(`
    INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date)
    VALUES ('CSP-001', 'CUST-001', 'PRD-001', 'FEED_GRADE', 'STD-001', 0, 'ACTIVE', '2026-08-26')
  `).run();

  assert.throws(() => {
    db.prepare(`
      INSERT INTO customer_specs (customer_spec_id, customer_id, product_id, application, base_standard_spec_id, revision_no, status, effective_date)
      VALUES ('CSP-002', 'CUST-001', 'PRD-001', 'FEED_GRADE', 'STD-001', 1, 'ACTIVE', '2026-08-26')
    `).run();
  }, /UNIQUE constraint failed/);
});
