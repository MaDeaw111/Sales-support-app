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

test('Freight variance on one-container vs multi-container', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShipmentRepository(wrappedDb);

  // Seed user, customer, product, po, quotes
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, po_date, status) VALUES ('PO1', 'C1', 'P1', 'FOB', '2026-08-26', 'ACTIVE')").run();
  
  // Seed freight quote
  db.prepare("INSERT INTO freight_quotes (quote_id, origin_port, destination_port, container_size, shipping_line_or_forwarder, quoted_freight_usd_per_container, created_by) VALUES ('Q1', 'Bangkok', 'Rotterdam', '20GP', 'Maersk', 1500.0, 'U1')").run();

  // SHIP-ONE represents one container
  db.prepare("INSERT INTO shipments (shipment_id, po_id, freight_quote_id, is_one_container) VALUES ('SHIP-ONE', 'PO1', 'Q1', 1)").run();
  
  // SHIP-MULTI represents multi container (is_one_container = 0)
  db.prepare("INSERT INTO shipments (shipment_id, po_id, freight_quote_id, is_one_container) VALUES ('SHIP-MULTI', 'PO1', 'Q1', 0)").run();

  // Add Ocean Freight actual expenses in USD
  // Note: CAT-OCEAN is category group OCEAN_FREIGHT
  db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E1', 'SHIP-ONE', 'CAT-OCEAN', 700.0, 'USD', 35.0, 24500.0)").run();
  db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E2', 'SHIP-ONE', 'CAT-OCEAN', 900.0, 'USD', 35.0, 31500.0)").run();

  db.prepare("INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb) VALUES ('E3', 'SHIP-MULTI', 'CAT-OCEAN', 700.0, 'USD', 35.0, 24500.0)").run();

  // Case 1: One-container shipment
  const res1 = await repo.getShipmentFreightVariance('SHIP-ONE');
  assert.equal(res1.quotedFreight, 1500.0);
  assert.equal(res1.actualFreightSum, 1600.0);
  assert.equal(res1.variance, -100.0);

  // Case 2: Multi-container shipment
  const res2 = await repo.getShipmentFreightVariance('SHIP-MULTI');
  assert.equal(res2.variance, null);
  assert.equal(res2.quotedFreight, null);
  assert.equal(res2.actualFreightSum, null);
});
