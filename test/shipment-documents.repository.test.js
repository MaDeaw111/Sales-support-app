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

test('Shipment Documents repository lifecycle', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShipmentRepository(wrappedDb);

  // Seed user, customer, product, po, shipment
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U1', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Person')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer 1')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm, po_date, status) VALUES ('PO1', 'C1', 'P1', 'FOB', '2026-08-26', 'ACTIVE')").run();
  db.prepare("INSERT INTO shipments (shipment_id, po_id, is_one_container) VALUES ('SH1', 'PO1', 1)").run();

  // Create valid document link
  const link = await repo.addShipmentDocumentLink({
    shipmentId: 'SH1',
    documentType: 'PO',
    title: 'Signed PO Scan',
    driveUrl: 'https://drive.google.com/file/d/12345/view',
    referenceNo: 'REF-PO-100'
  }, 'U1');

  assert.ok(link.link_id.startsWith('DOC-'));
  assert.equal(link.title, 'Signed PO Scan');

  // Verify list
  const list = await repo.listShipmentDocumentLinks('SH1');
  assert.equal(list.length, 1);
  assert.equal(list[0].link_id, link.link_id);

  // Reject invalid URL format
  await assert.rejects(async () => {
    await repo.addShipmentDocumentLink({
      shipmentId: 'SH1',
      documentType: 'PO',
      title: 'Invalid URL PO',
      driveUrl: 'ftp://drive.google.com/file/d/12345/view'
    }, 'U1');
  }, /Drive URL must start with http:\/\/ or https:\/\//);

  // Reject invalid document type
  await assert.rejects(async () => {
    await repo.addShipmentDocumentLink({
      shipmentId: 'SH1',
      documentType: 'INVALID_TYPE',
      title: 'Invalid Type PO',
      driveUrl: 'https://drive.google.com/file/d/12345/view'
    }, 'U1');
  }, /constraint failed/);
});
