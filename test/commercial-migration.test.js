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
  const commercialSql = await readFile(new URL('../migrations/0004_commercial_shipment_control.sql', import.meta.url), 'utf8');
  db.exec(commercialSql);
  return db;
}

test('D1 constraints enforced', async () => {
  const db = await setupTestDb();
  
  // Set up referenced records
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U2', 'manager@example.com', 'hash', 'salt', 'MANAGER', 'ACTIVE', 'Manager Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  
  // Seed POS and Shipments anchors
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, destination_port, po_date, status) VALUES ('PO1', 'C1', 'P1', 'CFR', 'Rotterdam', '2026-08-26', 'ACTIVE')").run();
  db.prepare("INSERT INTO shipments (shipment_id, po_id, is_one_container) VALUES ('S1', 'PO1', 1)").run();

  // 1. USD expense with NULL FX must fail
  assert.throws(() => {
    db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E1', 'S1', 'CAT-OCEAN', 100, 'USD', NULL, 3500)").run();
  }, /constraint failed/);

  // 2. THB expense with FX must fail
  assert.throws(() => {
    db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E2', 'S1', 'CAT-OCEAN', 100, 'THB', 35, 100)").run();
  }, /constraint failed/);

  // 3. CFR Price Note without destination port must fail
  assert.throws(() => {
    db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N1', 'U1', 'C1', 'P1', 'CFR', NULL, 300, 'U2')").run();
  }, /constraint failed/);

  // 4. Price Note missing relationship ids must fail
  assert.throws(() => {
    db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N2', NULL, 'C1', 'P1', 'FOB', 300, 'U2')").run();
  }, /NOT NULL constraint failed/);

  // 5. Zero/negative offer price must fail
  assert.throws(() => {
    db.prepare("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('N3', 'U1', 'C1', 'P1', 'FOB', 0, 'U2')").run();
  }, /constraint failed/);

  // 6. Zero/negative freight quote must fail
  assert.throws(() => {
    db.prepare("INSERT INTO freight_quotes (quote_id, origin_port, destination_port, container_size, shipping_line_or_forwarder, quoted_freight_usd_per_container, created_by) VALUES ('Q1', 'Bangkok', 'Rotterdam', '20GP', 'Maersk', 0, 'U2')").run();
  }, /constraint failed/);
});
