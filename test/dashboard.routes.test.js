import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

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
    '0008_logistics_partners.sql',
    '0009_commission_settlement.sql'
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

async function seedUserAndSession(db, userId, role, token, status = 'ACTIVE') {
  db.prepare(
    'INSERT INTO users (user_id, full_name, email, role, customer_scope, status, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, `${role} ${userId}`, `${userId}@example.com`, role, role === 'EXTERNAL_SALES' ? 'OWN_CUSTOMERS' : 'ALL', status, 'hash', 'salt');
  if (token) {
    db.prepare(
      'INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 60000).toISOString());
  }
}

function addDaysIso(baseIso, days) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function seedFullDashboardFixture(db) {
  const today = new Date().toISOString().slice(0, 10);
  const in2Days = addDaysIso(today, 2);
  const in5Days = addDaysIso(today, 5);

  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'mgr-token');
  await seedUserAndSession(db, 'U_SUP', 'SALES_SUPPORT', 'sup-token');
  await seedUserAndSession(db, 'U_EXP', 'EXPORT', 'exp-token');
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'wh-token');
  await seedUserAndSession(db, 'U_SALES1', 'EXTERNAL_SALES', 'sales1-token');
  await seedUserAndSession(db, 'U_SALES2', 'EXTERNAL_SALES', 'sales2-token');
  await seedUserAndSession(db, 'U_OLD', 'SALES_SUPPORT', null, 'INACTIVE');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type, status) VALUES ('C1', 'CUST1', 'Meelunie B.V.', 'U_SALES1', 'ASSIGNED_SALES', 'ACTIVE_CUSTOMER')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type, status) VALUES ('C2', 'CUST2', 'EuroStarch GmbH', 'U_SALES2', 'ASSIGNED_SALES', 'ACTIVE_CUSTOMER')").run();

  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1', 'ACTIVE')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('P2', 'THS-85', 'Tapioca Starch 85%', 'THS85', 'CAT1', 'FRM1', 'ACTIVE')").run();

  db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, contact_name, status, created_by) VALUES ('SP-001', 'FORWARDER', 'Kerry Ocean', 'Malee', 'ACTIVE', 'U_EXP')").run();
  db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, status, created_by) VALUES ('SP-002', 'TRUCKING', 'No Contact Truck', 'ACTIVE', 'U_EXP')").run();

  // PO1 (C1, USD, 100 MT, $10/MT commission for U_SALES1)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO1', 'C1', 'PARTIALLY_SHIPPED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO2', 'C2', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV1' WHERE po_id = 'PO1'").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV2' WHERE po_id = 'PO2'").run();

  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo', '40HC', 'Floor', 'U_SALES1', 10)").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L2', 'REV2', 10, 'P2', 'STANDARD', 'SPEC1', 50, 10, 45, 55, 400, 'Jumbo', '20GP', 'Floor', 'U_SALES2', 12)").run();

  // SHP-1 (C1): COMPLETED, PAID, FINAL invoice $10,000, loaded today (20 MT -> $200 PAYABLE commission for U_SALES1)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'COMPLETED', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'L1', 'P1', 20, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, planned_loading_date, actual_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-1', 'DI-1', 'COMPLETED', 'BK-001', 'MV ALPHA', ?, ?, ?, 10000, 'PAID', 'U_EXP')").run(in5Days, today, today);
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-1', 'SHP-1', 'MSCU111', '40HC', 'LOADED', 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-1', 'CNT-1', 'DIL-1', 20, 20, 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-001', ?, 'USD', 'FINAL', 1, 'tok1', 1, 'U_EXP')").run(today);
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by) VALUES ('IL-1', 'INV-1', 'L1', 20, 500, 'USD', 10000, 'U_EXP')").run();

  // SHP-2 (C2): BOOKED, UNPAID, no invoice yet, planned loading in 2 days (15 MT)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C2', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-2', 'DI-2', 'PO2', 'REV2', 'L2', 'P2', 15, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, planned_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-2', 'DI-2', 'BOOKED', 'BK-002', 'MV BETA', ?, ?, 0, 'UNPAID', 'U_EXP')").run(in5Days, in2Days);
}

function makeRequest(path, method = 'GET', token = null) {
  const headers = token ? { cookie: `wcat_session=${token}` } : {};
  return new Request(`https://example.com${path}`, { method, headers });
}

test('worker dispatches /api/dashboard (503 without DB, 401 unauthenticated, 404 non-GET)', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');

  assert.equal((await worker.fetch(makeRequest('/api/dashboard'), {})).status, 503);
  assert.equal((await worker.fetch(makeRequest('/api/dashboard'), { DB: wrappedDb })).status, 401);
  assert.equal((await worker.fetch(makeRequest('/api/dashboard', 'POST', 'admin-token'), { DB: wrappedDb })).status, 404);
});

test('GET /api/dashboard returns live D1 summaries with strict RBAC across all 6 roles', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedFullDashboardFixture(db);

  // 1. ADMIN
  const adminRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'admin-token'), { DB: wrappedDb });
  assert.equal(adminRes.status, 200);
  const adminData = (await adminRes.json()).data;
  assert.equal(adminData.role, 'ADMIN');
  assert.equal(adminData.kpis.active_users, 7);
  assert.equal(adminData.kpis.inactive_users, 1);
  assert.equal(adminData.kpis.customers_count, 2);
  assert.equal(adminData.kpis.active_products, 2);
  assert.equal(adminData.kpis.active_logistics_partners, 2);
  assert.equal(adminData.kpis.payable_commissions_count, 1);
  assert.ok(adminData.health.some((h) => h.key === 'PARTNER_CONTACT' && h.count === 1));

  // 2. MANAGER
  const mgrRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'mgr-token'), { DB: wrappedDb });
  assert.equal(mgrRes.status, 200);
  const mgrData = (await mgrRes.json()).data;
  assert.equal(mgrData.role, 'MANAGER');
  assert.equal(mgrData.kpis.active_customers_count, 2);
  assert.equal(mgrData.kpis.open_pos_count, 2);
  assert.equal(mgrData.kpis.active_contract_mt, 150);
  assert.equal(mgrData.commissions_summary.payable_usd, 200);
  assert.equal(mgrData.payments_summary.totals_by_currency.length, 2);

  // 3. SALES_SUPPORT (no commission data!)
  const supRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'sup-token'), { DB: wrappedDb });
  assert.equal(supRes.status, 200);
  const supData = (await supRes.json()).data;
  assert.equal(supData.role, 'SALES_SUPPORT');
  assert.equal(supData.kpis.active_customers_count, 2);
  assert.equal(supData.kpis.open_pos_count, 2);
  assert.equal(supData.kpis.payment_followup_count, 1);
  assert.equal('commissions_summary' in supData, false);

  // 4. EXTERNAL_SALES (strictly owner-scoped, zero other-customer or internal leakage!)
  const extRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'sales1-token'), { DB: wrappedDb });
  assert.equal(extRes.status, 200);
  const extData = (await extRes.json()).data;
  assert.equal(extData.role, 'EXTERNAL_SALES');
  assert.equal(extData.kpis.my_customers_count, 1);
  assert.equal(extData.kpis.my_open_pos_count, 1);
  assert.equal(extData.kpis.my_active_shipments_count, 1);
  assert.equal(extData.kpis.my_commission_payable_usd, 200);
  assert.equal(extData.recent_shipments.length, 1);
  assert.equal(extData.recent_shipments[0].di_no, 'DI-001');
  assert.equal('shipment_id' in extData.recent_shipments[0], false);
  assert.equal('payment_note' in extData.recent_shipments[0], false);
  assert.equal('customer_credits' in extData, false);

  // 5. EXPORT (no commission data!)
  const expRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'exp-token'), { DB: wrappedDb });
  assert.equal(expRes.status, 200);
  const expData = (await expRes.json()).data;
  assert.equal(expData.role, 'EXPORT');
  assert.equal(expData.kpis.loading_today_count, 1);
  assert.equal(expData.kpis.awaiting_loading_count, 1);
  assert.equal(expData.kpis.awaiting_final_invoice_count, 1);
  assert.equal(expData.kpis.payment_followup_count, 1);
  assert.equal(expData.kpis.active_logistics_partners_count, 2);
  assert.equal('commissions_summary' in expData, false);

  // 6. PRODUCTION_WAREHOUSE (strict warehouse allowlist ONLY!)
  const whRes = await worker.fetch(makeRequest('/api/dashboard', 'GET', 'wh-token'), { DB: wrappedDb });
  assert.equal(whRes.status, 200);
  const whData = (await whRes.json()).data;
  assert.equal(whData.role, 'PRODUCTION_WAREHOUSE');
  assert.equal(whData.kpis.loading_today_count, 1);
  assert.equal(whData.kpis.due_next_7_days_count, 1);
  assert.equal(whData.kpis.planned_shipments_count, 1);
  assert.equal(whData.kpis.upcoming_planned_mt, 15);
  assert.equal(whData.upcoming_loadings.length, 1);
  const whRow = whData.upcoming_loadings[0];
  assert.equal(whRow.container_plan, '1 x 20GP');
  assert.equal(whRow.planned_qty_mt, 15);
  assert.equal(whRow.products[0].product_code, 'THS-85');
  for (const forbidden of ['di_id', 'di_no', 'shipment_id', 'customer_name', 'booking_no', 'payment_status', 'commission_amount_usd']) {
    assert.equal(forbidden in whRow, false, `${forbidden} must never leak to PRODUCTION_WAREHOUSE`);
  }
  assert.equal('payments_summary' in whData, false);
  assert.equal('commissions_summary' in whData, false);
});
