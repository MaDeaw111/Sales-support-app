import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PAYMENT_STATUSES,
  INVOICE_READINESS_VALUES,
  PAYMENT_SHIPMENT_STATUSES,
  PAYMENT_CURRENCIES,
  parsePaymentsQuery
} from '../src/payments/validation.js';

test('payments validation exposes canonical statuses, invoice readiness, shipment statuses, and currencies', () => {
  assert.deepEqual(PAYMENT_STATUSES, ['UNPAID', 'PARTIAL', 'PAID']);
  assert.deepEqual(INVOICE_READINESS_VALUES, ['FINALIZED', 'PRELIMINARY_ONLY', 'NO_INVOICE']);
  assert.deepEqual(PAYMENT_SHIPMENT_STATUSES, ['PLANNING', 'BOOKED', 'LOADED', 'DOCS_SENT', 'COMPLETED']);
  assert.deepEqual(PAYMENT_CURRENCIES, ['USD', 'THB', 'EUR']);
});

test('parsePaymentsQuery normalizes valid filters, treats ALL as undefined, and rejects invalid enums', () => {
  assert.deepEqual(
    parsePaymentsQuery(new URLSearchParams('paymentStatus=partial&invoiceReadiness=finalized&shipmentStatus=docs_sent&currency=eur&customerId=C1&search=  DI-001  ')),
    {
      paymentStatus: 'PARTIAL',
      invoiceReadiness: 'FINALIZED',
      shipmentStatus: 'DOCS_SENT',
      currency: 'EUR',
      customerId: 'C1',
      search: 'DI-001'
    }
  );

  assert.deepEqual(
    parsePaymentsQuery(new URLSearchParams('paymentStatus=ALL&invoiceReadiness=ALL&shipmentStatus=ALL&currency=ALL&customerId=ALL&search=   ')),
    {
      paymentStatus: undefined,
      invoiceReadiness: undefined,
      shipmentStatus: undefined,
      currency: undefined,
      customerId: undefined,
      search: undefined
    }
  );

  assert.throws(
    () => parsePaymentsQuery(new URLSearchParams('paymentStatus=OVERDUE')),
    /PAYMENT_STATUS_INVALID/
  );
  assert.throws(
    () => parsePaymentsQuery(new URLSearchParams('invoiceReadiness=DRAFT')),
    /PAYMENT_INVOICE_READINESS_INVALID/
  );
  assert.throws(
    () => parsePaymentsQuery(new URLSearchParams('shipmentStatus=CANCELLED')),
    /PAYMENT_SHIPMENT_STATUS_INVALID/
  );
  assert.throws(
    () => parsePaymentsQuery(new URLSearchParams('currency=JPY')),
    /PAYMENT_CURRENCY_INVALID/
  );
});

import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

async function setupRouteTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql', '0015_di_loading_date_range.sql',
    '0008_logistics_partners.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  return {
    db,
    wrappedDb: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          params: [],
          bind(...params) {
            this.params = params;
            return this;
          },
          async first() {
            return statement.all(...this.params)[0] || null;
          },
          async all() {
            return { results: statement.all(...this.params), success: true };
          },
          async run() {
            return { success: true, meta: statement.run(...this.params) };
          },
          _stmt: statement
        };
      },
      async batch(statements) {
        db.exec('BEGIN');
        try {
          const results = [];
          for (const st of statements) {
            results.push(await st.run());
          }
          db.exec('COMMIT');
          return results;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }
    }
  };
}

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(
    'INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, `${role} User`, `${userId}@example.com`, role, role === 'EXTERNAL_SALES' ? 'OWN_CUSTOMERS' : 'ALL', 'hash', 'salt');
  db.prepare(
    'INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 60000).toISOString());
}

function seedRouteFixture(db) {
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Owned Customer', 'U_SALES1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'Other Customer', 'U_SALES2', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo Bag', '40HC', 'Floor')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE2', 'REV2', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 400, 'Jumbo Bag', '40HC', 'Floor')").run();

  // SHP-1 (C1, FINAL 10000, cash 4000 -> PARTIAL)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'LINE1', 'P1', 20, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, actual_loading_date, all_ship_docs_drive_url, digital_docs_sent_date, original_docs_required, cash_received_amount, payment_status, payment_note, created_by) VALUES ('SHP-1', 'DI-1', 'DOCS_SENT', 'BK-SECRET-1', 'MV SECRET', '2026-11-15', '2026-11-12', 'https://drive.google.com/drive/folders/abc', '2026-11-14', 0, 4000, 'PARTIAL', 'Secret bank note', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-1', 'SHP-1', 'MSCU1234567', '40HC', 'LOADED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CNTL-1', 'CNT-1', 'DIL-1', 20, 20, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-001', '2026-11-13', 'USD', 'FINAL', 1, 'tok1', 0, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-1', 'INV-1', 'LINE1', 20, 500, 'USD', 10000, 'U_EXPORT')").run();

  // SHP-2 (C2, FINAL 4000, cash 0 -> UNPAID)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C2', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, cash_received_amount, payment_status, created_by) VALUES ('SHP-2', 'DI-2', 'LOADED', 'BK-002', '2026-11-20', 0, 'UNPAID', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-2', 'SHP-2', 'WCAT-002', '2026-11-18', 'EUR', 'FINAL', 1, 'tok2', 0, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-2', 'INV-2', 'LINE2', 10, 400, 'EUR', 4000, 'U_EXPORT')").run();

  // Credit for C1
  db.prepare("INSERT INTO customer_credits (credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by) VALUES ('CR-1', 'C1', 1000, 'Existing credit', 1000, 'seed-cr-1', 'U_EXPORT')").run();
}

function makeRequest(path, method = 'GET', body = null, token = null) {
  const headers = token ? { cookie: `wcat_session=${token}` } : {};
  if (body !== null) headers['content-type'] = 'application/json';
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : null
  });
}

test('worker dispatches /api/payments and returns 503 without DB binding', async () => {
  const res = await worker.fetch(makeRequest('/api/payments'), {});
  assert.equal(res.status, 503);
});

test('/api/payments endpoints return 401 when unauthenticated and 403 for PRODUCTION_WAREHOUSE', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'wh-token');

  for (const path of ['/api/payments', '/api/payments/SHP-1']) {
    assert.equal((await worker.fetch(makeRequest(path), { DB: wrappedDb })).status, 401);
    assert.equal((await worker.fetch(makeRequest(path, 'GET', null, 'wh-token'), { DB: wrappedDb })).status, 403);
  }
});

test('EXTERNAL_SALES receives strictly owner-scoped projection with anti-inference and 403 on detail', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_EXPORT', 'EXPORT', 'export-token');
  await seedUserAndSession(db, 'U_SALES1', 'EXTERNAL_SALES', 'sales1-token');
  await seedUserAndSession(db, 'U_SALES2', 'EXTERNAL_SALES', 'sales2-token');
  seedRouteFixture(db);

  // Detail endpoint forbidden for EXTERNAL_SALES
  const detailRes = await worker.fetch(makeRequest('/api/payments/SHP-1', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(detailRes.status, 403);

  // List returns ONLY owned customer C1, strictly projected
  const listRes = await worker.fetch(makeRequest('/api/payments?customerId=C2', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(listRes.status, 200);
  const body = await listRes.json();
  assert.equal(body.data.items.length, 1, 'customerId=C2 must be ignored for EXTERNAL_SALES anti-inference');
  assert.deepEqual(body.data.customerCredits, []);
  assert.equal('customer_credits_summary' in body.data.summary, false);

  const row = body.data.items[0];
  assert.equal(row.di_no, 'DI-001');
  assert.equal(row.customer_name, 'Owned Customer');
  assert.equal(row.final_invoice_total, 10000);
  assert.equal(row.payment_total, 4000);
  assert.equal(row.outstanding_balance, 6000);
  assert.equal(row.payment_status, 'PARTIAL');
  assert.equal(row.commission_ready, false);

  for (const forbidden of [
    'shipment_id', 'di_id', 'po_id', 'customer_id', 'payment_note',
    'cash_received_amount', 'allocated_credit_amount', 'preliminary_invoice_total',
    'booking_no', 'vessel', 'can_edit_payment', 'last_payment_updated_at'
  ]) {
    assert.equal(forbidden in row, false, `${forbidden} must not leak to EXTERNAL_SALES`);
  }

  // Totals by currency must NOT expose cash vs credit split
  assert.equal(body.data.summary.totals_by_currency.length, 1);
  assert.equal('cash_received_total' in body.data.summary.totals_by_currency[0], false);
  assert.equal('allocated_credit_total' in body.data.summary.totals_by_currency[0], false);

  // Anti-inference: searching hidden booking_no or payment_note returns 0 items
  const secretSearch = await worker.fetch(makeRequest('/api/payments?search=Secret%20bank%20note', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(secretSearch.status, 200);
  assert.equal((await secretSearch.json()).data.items.length, 0);
});

test('SALES_SUPPORT is read-only while ADMIN/MANAGER/EXPORT integrate live with Phase 6 payment & credit writes', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_MANAGER', 'MANAGER', 'manager-token');
  await seedUserAndSession(db, 'U_EXPORT', 'EXPORT', 'export-token');
  await seedUserAndSession(db, 'U_SUPPORT', 'SALES_SUPPORT', 'support-token');
  await seedUserAndSession(db, 'U_SALES1', 'EXTERNAL_SALES', 'sales1-token');
  await seedUserAndSession(db, 'U_SALES2', 'EXTERNAL_SALES', 'sales2-token');
  seedRouteFixture(db);

  // SALES_SUPPORT gets full read view with can_edit_payment = false
  const supList = await worker.fetch(makeRequest('/api/payments', 'GET', null, 'support-token'), { DB: wrappedDb });
  assert.equal(supList.status, 200);
  const supBody = await supList.json();
  assert.equal(supBody.data.items.length, 2);
  assert.equal(supBody.data.customerCredits.length, 1);
  assert.equal(supBody.data.items[0].can_edit_payment, false);

  const supDetail = await worker.fetch(makeRequest('/api/payments/SHP-1', 'GET', null, 'support-token'), { DB: wrappedDb });
  assert.equal(supDetail.status, 200);
  assert.equal((await supDetail.json()).data.shipment.can_edit_payment, false);

  // SALES_SUPPORT denied on Phase 6 payment write
  const supWrite = await worker.fetch(makeRequest('/api/shipments-v2/SHP-1/payment', 'PUT', { cashReceivedAmount: 5000 }, 'support-token'), { DB: wrappedDb });
  assert.equal(supWrite.status, 403);

  // MANAGER records additional cash via Phase 6 PUT /api/shipments-v2/SHP-1/payment (4000 -> 9000)
  const cashRes = await worker.fetch(makeRequest('/api/shipments-v2/SHP-1/payment', 'PUT', {
    cashReceivedAmount: 9000,
    paymentNote: 'TT 2nd installment'
  }, 'manager-token'), { DB: wrappedDb });
  assert.equal(cashRes.status, 200);

  // EXPORT applies existing 1000 customer credit via Phase 6 POST /api/shipments-v2/SHP-1/credit-usage -> 9000 + 1000 = 10000 PAID & COMPLETED!
  const creditRes = await worker.fetch(makeRequest('/api/shipments-v2/SHP-1/credit-usage', 'POST', {
    creditId: 'CR-1',
    amount: 1000,
    invoiceId: 'INV-1',
    requestKey: 'phase9-e2e-credit-1'
  }, 'export-token'), { DB: wrappedDb });
  assert.equal(creditRes.status, 200);

  // Phase 9 GET /api/payments/SHP-1 immediately reflects PAID, 0 outstanding, COMPLETED, credit usage, and audit trail
  const detailAfter = await worker.fetch(makeRequest('/api/payments/SHP-1', 'GET', null, 'admin-token'), { DB: wrappedDb });
  assert.equal(detailAfter.status, 200);
  const afterData = (await detailAfter.json()).data;
  assert.equal(afterData.shipment.can_edit_payment, true);
  assert.equal(afterData.shipment.payment_status, 'PAID');
  assert.equal(afterData.shipment.shipment_status, 'COMPLETED');
  assert.equal(afterData.shipment.cash_received_amount, 9000);
  assert.equal(afterData.shipment.allocated_credit_amount, 1000);
  assert.equal(afterData.shipment.payment_total, 10000);
  assert.equal(afterData.shipment.outstanding_balance, 0);
  assert.equal(afterData.shipment.commission_ready, true);
  assert.equal(afterData.creditUsages.length, 1);
  assert.equal(afterData.availableCustomerCredits.length, 0);
  assert.ok(afterData.paymentHistory.some((e) => e.event_type === 'PAYMENT_UPDATED'));

  // 404 & 400 guards
  assert.equal((await worker.fetch(makeRequest('/api/payments/SHP-999', 'GET', null, 'admin-token'), { DB: wrappedDb })).status, 404);
  assert.equal((await worker.fetch(makeRequest('/api/payments?currency=JPY', 'GET', null, 'admin-token'), { DB: wrappedDb })).status, 400);
  assert.equal((await worker.fetch(makeRequest('/api/payments/%E0%A4%A', 'GET', null, 'admin-token'), { DB: wrappedDb })).status, 400);
});
