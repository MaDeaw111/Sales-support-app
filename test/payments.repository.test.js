import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPaymentsRepository } from '../src/payments/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql',
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
          }
        };
      }
    }
  };
}

function seedPaymentsFixture(db) {
  for (const [id, role, name] of [
    ['U_ADMIN', 'ADMIN', 'Admin User'],
    ['U_EXPORT', 'EXPORT', 'Export User'],
    ['U_SALES1', 'EXTERNAL_SALES', 'Sales One'],
    ['U_SALES2', 'EXTERNAL_SALES', 'Sales Two']
  ]) {
    db.prepare(
      'INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, \'hash\', \'salt\', ?, \'ACTIVE\', ?)'
    ).run(id, `${id}@example.com`, role, name);
  }

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Meelunie B.V.', 'U_SALES1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'EuroStarch GmbH', 'U_SALES2', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  // PO1 (C1, USD)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, payment_term_snapshot, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-USD-01', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'T/T 30 Days', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo Bag', '40HC', 'Floor')").run();

  // PO2 (C2, EUR)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, payment_term_snapshot, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-EUR-02', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'CAD', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE2', 'REV2', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 400, 'Jumbo Bag', '40HC', 'Floor')").run();

  // SHP-1 (C1, USD, FINAL invoice 10000, cash 6000 + credit 1500 = 7500 -> PARTIAL, outstanding 2500)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, actual_loading_date, cash_received_amount, payment_status, payment_note, created_by) VALUES ('SHP-1', 'DI-1', 'DOCS_SENT', 'BK-001', 'MV ALPHA', '2026-11-15', '2026-11-12', 6000, 'PARTIAL', 'TT Ref 001', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-2026-001', '2026-11-13', 'USD', 'FINAL', 1, 'tok1', 1, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-1', 'INV-1', 'LINE1', 20, 500, 'USD', 10000, 'U_EXPORT')").run();

  // Customer credits for C1 (CR-1: 2000 total, 1500 used on SHP-1, 500 remaining)
  db.prepare("INSERT INTO customer_credits (credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by) VALUES ('CR-1', 'C1', 2000, 'Prior overpayment', 500, 'req-cr-1', 'U_EXPORT')").run();
  db.prepare("INSERT INTO customer_credit_usages (credit_usage_id, credit_id, shipment_id, invoice_id, amount, request_key, actor_id) VALUES ('CRU-1', 'CR-1', 'SHP-1', 'INV-1', 1500, 'req-cru-1', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json, created_at) VALUES ('EVT-1', 'SHIPMENT', 'SHP-1', 'PAYMENT_UPDATED', 'U_EXPORT', '{\"cashReceivedAmount\":6000}', '2026-11-16 10:00:00')").run();

  // SHP-2 (C1, USD, FINAL invoice 5000, cash 5000 -> PAID, COMPLETED)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C1', 'PO1', 'REV1', 'DI-002', '2026-11', 'FIRST_HALF', '1 x 20GP', 'COMPLETED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, actual_loading_date, cash_received_amount, payment_status, payment_note, created_by) VALUES ('SHP-2', 'DI-2', 'COMPLETED', 'BK-002', 'MV BETA', '2026-11-05', '2026-11-02', 5000, 'PAID', 'Paid in full', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-2', 'SHP-2', 'WCAT-2026-002', '2026-11-03', 'USD', 'FINAL', 1, 'tok2', 1, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-2', 'INV-2', 'LINE1', 10, 500, 'USD', 5000, 'U_EXPORT')").run();

  // SHP-3 (C2, EUR, PRELIMINARY only 8000, cash 0 -> UNPAID, outstanding 0 until FINAL)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-3', 'C2', 'PO2', 'REV2', 'DI-003', '2026-11', 'SECOND_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, cash_received_amount, payment_status, created_by) VALUES ('SHP-3', 'DI-3', 'BOOKED', 'BK-003', 'MV GAMMA', '2026-11-20', 0, 'UNPAID', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-3', 'SHP-3', 'PRE-2026-003', '2026-11-14', 'EUR', 'PRELIMINARY', 0, 'tok3', NULL, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-3', 'INV-3', 'LINE2', 20, 400, 'EUR', 8000, 'U_EXPORT')").run();

  // SHP-4 (C2, EUR, FINAL invoice 4000, cash 0 -> UNPAID, outstanding 4000)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-4', 'C2', 'PO2', 'REV2', 'DI-004', '2026-11', 'SECOND_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, cash_received_amount, payment_status, created_by) VALUES ('SHP-4', 'DI-4', 'LOADED', 'BK-004', '2026-11-18', 0, 'UNPAID', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-4', 'SHP-4', 'WCAT-2026-004', '2026-11-17', 'EUR', 'FINAL', 1, 'tok4', 1, 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('INVL-4', 'INV-4', 'LINE2', 10, 400, 'EUR', 4000, 'U_EXPORT')").run();

  // SHP-CANCELLED (must be excluded)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-5', 'C1', 'PO1', 'REV1', 'DI-005', '2026-11', 'FIRST_HALF', '1 x 20GP', 'CONFIRMED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, cash_received_amount, payment_status, created_by) VALUES ('SHP-5', 'DI-5', 'CANCELLED', 'BK-005', 0, 'UNPAID', 'U_EXPORT')").run();
}

test('listPaymentsDashboard consolidates shipments, multi-currency totals, credits, and excludes cancelled records', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedPaymentsFixture(db);
  const repo = createPaymentsRepository(wrappedDb);

  const dashboard = await repo.listPaymentsDashboard();

  assert.equal(dashboard.items.length, 4);
  // Ordered by PARTIAL first, then UNPAID, then PAID
  assert.equal(dashboard.items[0].shipment_id, 'SHP-1');
  assert.equal(dashboard.items[0].payment_status, 'PARTIAL');
  assert.equal(dashboard.items[0].final_invoice_total, 10000);
  assert.equal(dashboard.items[0].cash_received_amount, 6000);
  assert.equal(dashboard.items[0].allocated_credit_amount, 1500);
  assert.equal(dashboard.items[0].payment_total, 7500);
  assert.equal(dashboard.items[0].outstanding_balance, 2500);
  assert.equal(dashboard.items[0].invoice_readiness, 'FINALIZED');
  assert.equal(dashboard.items[0].final_invoice_nos, 'WCAT-2026-001');
  assert.equal(dashboard.items[0].last_payment_updated_at, '2026-11-16 10:00:00');
  assert.equal(dashboard.items[0].commission_ready, false);

  const shp2 = dashboard.items.find((x) => x.shipment_id === 'SHP-2');
  assert.equal(shp2.payment_status, 'PAID');
  assert.equal(shp2.outstanding_balance, 0);
  assert.equal(shp2.commission_ready, true);

  const shp3 = dashboard.items.find((x) => x.shipment_id === 'SHP-3');
  assert.equal(shp3.invoice_readiness, 'PRELIMINARY_ONLY');
  assert.equal(shp3.preliminary_invoice_total, 8000);
  assert.equal(shp3.final_invoice_total, 0);
  assert.equal(shp3.outstanding_balance, 0);
  assert.equal(shp3.currency, 'EUR');

  // Summary counts
  assert.equal(dashboard.summary.total_shipments, 4);
  assert.equal(dashboard.summary.paid_count, 1);
  assert.equal(dashboard.summary.partial_count, 1);
  assert.equal(dashboard.summary.unpaid_count, 2);
  assert.equal(dashboard.summary.final_invoiced_count, 3);
  assert.equal(dashboard.summary.awaiting_final_invoice_count, 1);

  // Multi-currency totals never blended
  assert.deepEqual(dashboard.summary.totals_by_currency, [
    {
      currency: 'USD',
      shipment_count: 2,
      final_invoice_total: 15000,
      cash_received_total: 11000,
      allocated_credit_total: 1500,
      payment_total: 12500,
      outstanding_total: 2500
    },
    {
      currency: 'EUR',
      shipment_count: 2,
      final_invoice_total: 4000,
      cash_received_total: 0,
      allocated_credit_total: 0,
      payment_total: 0,
      outstanding_total: 4000
    }
  ]);

  // Customer credits overview
  assert.equal(dashboard.customerCredits.length, 1);
  assert.equal(dashboard.customerCredits[0].credit_id, 'CR-1');
  assert.equal(dashboard.customerCredits[0].customer_name, 'Meelunie B.V.');
  assert.equal(dashboard.customerCredits[0].used_amount, 1500);
  assert.equal(dashboard.customerCredits[0].remaining_amount, 500);
  assert.equal(dashboard.customerCredits[0].usage_count, 1);
  assert.deepEqual(dashboard.summary.customer_credits_summary, {
    total_credits: 1,
    active_credits_count: 1,
    total_remaining_amount_by_currency: { USD: 500, EUR: 0 }
  });
});

test('listPaymentsDashboard supports filters, owner scoping, and restrictedSearch anti-inference', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedPaymentsFixture(db);
  const repo = createPaymentsRepository(wrappedDb);

  const byCurrency = await repo.listPaymentsDashboard({ currency: 'EUR' });
  assert.equal(byCurrency.items.length, 2);
  assert.ok(byCurrency.items.every((x) => x.currency === 'EUR'));

  const byReadiness = await repo.listPaymentsDashboard({ invoiceReadiness: 'PRELIMINARY_ONLY' });
  assert.equal(byReadiness.items.length, 1);
  assert.equal(byReadiness.items[0].shipment_id, 'SHP-3');

  const ownerScoped = await repo.listPaymentsDashboard({
    ownedByUserId: 'U_SALES1',
    includeCustomerCredits: false
  });
  assert.equal(ownerScoped.items.length, 2);
  assert.ok(ownerScoped.items.every((x) => x.customer_id === 'C1'));
  assert.deepEqual(ownerScoped.customerCredits, []);
  assert.equal(ownerScoped.summary.customer_credits_summary, undefined);

  // restrictedSearch must NOT match hidden booking_no or payment_note
  const hiddenSearch = await repo.listPaymentsDashboard({
    ownedByUserId: 'U_SALES1',
    search: 'TT Ref 001',
    restrictedSearch: true,
    includeCustomerCredits: false
  });
  assert.equal(hiddenSearch.items.length, 0);

  // restrictedSearch DOES match projected fields (final_invoice_nos / di_no)
  const visibleSearch = await repo.listPaymentsDashboard({
    ownedByUserId: 'U_SALES1',
    search: 'WCAT-2026-001',
    restrictedSearch: true,
    includeCustomerCredits: false
  });
  assert.equal(visibleSearch.items.length, 1);
  assert.equal(visibleSearch.items[0].di_no, 'DI-001');
});

test('getShipmentPaymentDetail returns invoices, credit usages, available credits, and audit history', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedPaymentsFixture(db);
  const repo = createPaymentsRepository(wrappedDb);

  const detail = await repo.getShipmentPaymentDetail('SHP-1');
  assert.ok(detail);
  assert.equal(detail.shipment.shipment_id, 'SHP-1');
  assert.equal(detail.shipment.outstanding_balance, 2500);
  assert.equal(detail.invoices.length, 1);
  assert.equal(detail.invoices[0].invoice_no, 'WCAT-2026-001');
  assert.equal(detail.invoices[0].invoice_total, 10000);
  assert.equal(detail.creditUsages.length, 1);
  assert.equal(detail.creditUsages[0].credit_id, 'CR-1');
  assert.equal(detail.creditUsages[0].amount, 1500);
  assert.equal(detail.creditUsages[0].reason, 'Prior overpayment');
  assert.equal(detail.availableCustomerCredits.length, 1);
  assert.equal(detail.availableCustomerCredits[0].remaining_amount, 500);
  assert.equal(detail.paymentHistory.length, 1);
  assert.equal(detail.paymentHistory[0].event_type, 'PAYMENT_UPDATED');

  // Cancelled or unknown shipment returns null
  assert.equal(await repo.getShipmentPaymentDetail('SHP-5'), null);
  assert.equal(await repo.getShipmentPaymentDetail('SHP-999'), null);
});

test('external payments exclude House Accounts even with a stale owner link', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedPaymentsFixture(db);
  db.exec("UPDATE customers SET ownership_type = 'HOUSE_ACCOUNT' WHERE customer_id = 'C1'");
  const result = await createPaymentsRepository(wrappedDb).listPaymentsDashboard({ ownedByUserId: 'U_SALES1', includeCustomerCredits: false });
  assert.equal(result.items.length, 0);
  db.close();
});

test('payments expose PO currency separately from invoice currency', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedPaymentsFixture(db);
  db.exec("UPDATE po_revisions SET currency = 'EUR' WHERE revision_id = 'REV1'");
  const result = await createPaymentsRepository(wrappedDb).listPaymentsDashboard();
  const item = result.items.find(row => row.shipment_id === 'SHP-1');
  assert.equal(item.po_currency, 'EUR');
  assert.equal(item.currency, 'USD');
  db.close();
});
