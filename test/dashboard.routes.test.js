import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';
import { createDashboardRepository } from '../src/dashboard/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of (await readdir(new URL('../migrations/', import.meta.url))).filter(name=>/^00(?:0[1-9]|1[0-5])_.*\.sql$/.test(name)).sort()) {
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

  // Shared WCAT Team Overview RBAC: identical across 4 internal roles, strictly omitted for EXTERNAL_SALES & PRODUCTION_WAREHOUSE
  assert.ok(adminData.team_overview && typeof adminData.team_overview === 'object');
  assert.deepEqual(mgrData.team_overview, adminData.team_overview);
  assert.deepEqual(supData.team_overview, adminData.team_overview);
  assert.deepEqual(expData.team_overview, adminData.team_overview);
  assert.equal('team_overview' in extData, false, 'team_overview must never be returned to EXTERNAL_SALES');
  assert.equal('team_overview' in whData, false, 'team_overview must never be returned to PRODUCTION_WAREHOUSE');
});

test('WCAT Team Overview calculates active POs, product breakdown, shipped vs remaining, this/next month shipments, and Dec->Jan rollover', async () => {
  const { db, wrappedDb } = await setupTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'mgr-token');
  await seedUserAndSession(db, 'U_SUP', 'SALES_SUPPORT', 'sup-token');
  await seedUserAndSession(db, 'U_EXP', 'EXPORT', 'exp-token');
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'wh-token');
  await seedUserAndSession(db, 'U_SALES1', 'EXTERNAL_SALES', 'sales1-token');

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type, status) VALUES ('C1', 'CUST1', 'Meelunie B.V.', 'U_SALES1', 'ASSIGNED_SALES', 'ACTIVE_CUSTOMER')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1', 'ACTIVE')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, status) VALUES ('P2', 'THS-85', 'Tapioca Starch 85%', 'THS85', 'CAT1', 'FRM1', 'ACTIVE')").run();

  // Active PO1 (PARTIALLY_SHIPPED): P1 100 MT + P2 25 MT
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO1', 'C1', 'PARTIALLY_SHIPPED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-12-31', '2027-01-31', 'U_ADMIN')").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV1' WHERE po_id = 'PO1'").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('L1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo', '40HC', 'Floor')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('L1B', 'REV1', 20, 'P2', 'STANDARD', 'SPEC1', 25, 10, 22, 28, 420, 'Jumbo', '20GP', 'Floor')").run();

  // Active PO2 (OPEN): P2 50 MT
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO2', 'C1', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-12-31', '2027-01-31', 'U_ADMIN')").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV2' WHERE po_id = 'PO2'").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('L2', 'REV2', 10, 'P2', 'STANDARD', 'SPEC1', 50, 10, 45, 55, 400, 'Jumbo', '20GP', 'Floor')").run();

  // Completed PO3 (must be excluded from Active POs)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO3', 'C1', 'COMPLETED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV3', 'PO3', 0, 'ACTIVE', 'CPO-3', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-10-01', '2026-10-31', '2026-11-30', 'U_ADMIN')").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV3' WHERE po_id = 'PO3'").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('L3', 'REV3', 10, 'P1', 'STANDARD', 'SPEC1', 40, 10, 36, 44, 500, 'Jumbo', '40HC', 'Floor')").run();

  // Cancelled PO4 (must be excluded from Active POs)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO4', 'C1', 'CANCELLED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV4', 'PO4', 0, 'ACTIVE', 'CPO-4', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-12-31', '2027-01-31', 'U_ADMIN')").run();
  db.prepare("UPDATE po_headers SET current_active_revision_id = 'REV4' WHERE po_id = 'PO4'").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('L4', 'REV4', 10, 'P1', 'STANDARD', 'SPEC1', 30, 10, 27, 33, 500, 'Jumbo', '40HC', 'Floor')").run();

  // Nov 2026 — SHP-1 (LOADED/COMPLETED): 20 MT actual in 1 active container (+ 1 cancelled container ignored)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'COMPLETED', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'L1', 'P1', 22, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, planned_loading_date, actual_loading_date, created_by) VALUES ('SHP-1', 'DI-1', 'COMPLETED', 'BK-001', '2026-11-08', '2026-11-10', 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-1', 'SHP-1', 'MSCU111', '40HC', 'LOADED', 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-1', 'CNT-1', 'DIL-1', 20, 20, 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-CAN', 'SHP-1', 'MSCU999', '40HC', 'CANCELLED', 'U_EXP')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-CAN', 'CNT-CAN', 'DIL-1', 10, 10, 'U_EXP')").run();

  // Nov 2026 — SHP-2 (BOOKED, remaining to ship this month): 15 MT planned, '2 x 20GP'
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C1', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '2 x 20GP', 'IN_PROGRESS', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-2', 'DI-2', 'PO2', 'REV2', 'L2', 'P2', 15, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, planned_loading_date, created_by) VALUES ('SHP-2', 'DI-2', 'BOOKED', 'BK-002', '2026-11-25', 'U_EXP')").run();

  // Nov 2026 — SHP-3 (CANCELLED, must be excluded from both shipped & monthly totals)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-3', 'C1', 'PO1', 'REV1', 'DI-003', '2026-11', 'SECOND_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-3', 'DI-3', 'PO1', 'REV1', 'L1', 'P1', 18, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, planned_loading_date, created_by) VALUES ('SHP-3', 'DI-3', 'CANCELLED', 'BK-003', '2026-11-28', 'U_EXP')").run();

  // Dec 2026 (next month) — DI-4 (CONFIRMED, no shipment row yet): 45 MT, composite plan '2 x 40HC + 1 x 20GP' => 3 containers
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-4', 'C1', 'PO1', 'REV1', 'DI-004', '2026-12', 'FIRST_HALF', '2 x 40HC + 1 x 20GP', 'CONFIRMED', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-4', 'DI-4', 'PO1', 'REV1', 'L1', 'P1', 45, 'Jumbo Bag', 'U_EXP')").run();

  // Dec 2026 (next month) — SHP-5 (BOOKED, planned_loading_date in Dec 2026): 22 MT, '1 x 40HC' => 1 container
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-5', 'C1', 'PO2', 'REV2', 'DI-005', '2026-11', 'SECOND_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-5', 'DI-5', 'PO2', 'REV2', 'L2', 'P2', 22, 'Jumbo Bag', 'U_EXP')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, planned_loading_date, created_by) VALUES ('SHP-5', 'DI-5', 'BOOKED', 'BK-005', '2026-12-05', 'U_EXP')").run();

  // Jan 2027 — DI-6 (to verify Dec->Jan rollover)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-6', 'C1', 'PO1', 'REV1', 'DI-006', '2027-01', 'FIRST_HALF', '3 x 20GP', 'CONFIRMED', 'U_EXP')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-6', 'DI-6', 'PO1', 'REV1', 'L1B', 'P2', 25, 'Jumbo Bag', 'U_EXP')").run();

  const repo = createDashboardRepository(wrappedDb);
  const novDate = new Date('2026-11-15T00:00:00Z');
  const [adminDash, mgrDash, supDash, expDash, extDash, whDash] = await Promise.all([
    repo.getDashboardForCaller({ user_id: 'U_ADMIN', role: 'ADMIN' }, novDate),
    repo.getDashboardForCaller({ user_id: 'U_MGR', role: 'MANAGER' }, novDate),
    repo.getDashboardForCaller({ user_id: 'U_SUP', role: 'SALES_SUPPORT' }, novDate),
    repo.getDashboardForCaller({ user_id: 'U_EXP', role: 'EXPORT' }, novDate),
    repo.getDashboardForCaller({ user_id: 'U_SALES1', role: 'EXTERNAL_SALES' }, novDate),
    repo.getDashboardForCaller({ user_id: 'U_WH', role: 'PRODUCTION_WAREHOUSE' }, novDate)
  ]);

  assert.deepEqual(mgrDash.team_overview, adminDash.team_overview);
  assert.deepEqual(supDash.team_overview, adminDash.team_overview);
  assert.deepEqual(expDash.team_overview, adminDash.team_overview);
  assert.equal('team_overview' in extDash, false);
  assert.equal('team_overview' in whDash, false);

  const ov = adminDash.team_overview;
  // 1. Active POs: PO1 (100 P1 + 25 P2) + PO2 (50 P2) = 175 MT across 2 active POs
  assert.equal(ov.active_pos.active_po_count, 2);
  assert.equal(ov.active_pos.total_contract_mt, 175);
  assert.equal(ov.active_pos.product_breakdown.length, 2);
  assert.deepEqual(
    ov.active_pos.product_breakdown.map((p) => ({
      code: p.product_code,
      contract: p.contract_qty_mt,
      shipped: p.shipped_qty_mt,
      remaining: p.remaining_qty_mt,
      po_count: p.po_count
    })),
    [
      { code: 'THP-65', contract: 100, shipped: 20, remaining: 80, po_count: 1 },
      { code: 'THS-85', contract: 75, shipped: 0, remaining: 75, po_count: 2 }
    ]
  );

  // 2. Shipped vs Remaining across active POs
  assert.equal(ov.fulfillment.total_contract_mt, 175);
  assert.equal(ov.fulfillment.actual_shipped_mt, 20);
  assert.equal(ov.fulfillment.remaining_contract_mt, 155);
  assert.equal(ov.fulfillment.shipped_pct, 11.4);

  // 3. This Month (2026-11): SHP-1 (20 MT, 1 cnt loaded) + SHP-2 (15 MT, 2 cnt remaining)
  assert.equal(ov.this_month.month, '2026-11');
  assert.equal(ov.this_month.total_mt, 35);
  assert.equal(ov.this_month.total_containers, 3);
  assert.equal(ov.this_month.shipment_count, 2);
  assert.equal(ov.this_month.shipped_mt, 20);
  assert.equal(ov.this_month.shipped_containers, 1);
  assert.equal(ov.this_month.shipped_count, 1);
  assert.equal(ov.this_month.remaining_mt, 15);
  assert.equal(ov.this_month.remaining_containers, 2);
  assert.equal(ov.this_month.remaining_count, 1);

  // 4. Next Month (2026-12): DI-4 (45 MT, 3 cnt) + SHP-5 (22 MT, 1 cnt)
  assert.equal(ov.next_month.month, '2026-12');
  assert.equal(ov.next_month.planned_mt, 67);
  assert.equal(ov.next_month.planned_containers, 4);
  assert.equal(ov.next_month.shipment_count, 2);

  // 5. Dec -> Jan year rollover
  const decDash = await repo.getDashboardForCaller({ user_id: 'U_ADMIN', role: 'ADMIN' }, new Date('2026-12-15T00:00:00Z'));
  assert.equal(decDash.team_overview.this_month.month, '2026-12');
  assert.equal(decDash.team_overview.this_month.total_mt, 67);
  assert.equal(decDash.team_overview.this_month.total_containers, 4);
  assert.equal(decDash.team_overview.next_month.month, '2027-01');
  assert.equal(decDash.team_overview.next_month.planned_mt, 25);
  assert.equal(decDash.team_overview.next_month.planned_containers, 3);
  assert.equal(decDash.team_overview.next_month.shipment_count, 1);
});

test('executive dashboard includes draft contracts, scoped watchlists and financial role projections', async () => {
  const {db, wrappedDb}=await setupTestDb();
  await seedFullDashboardFixture(db);
  db.exec("UPDATE po_headers SET current_active_revision_id=NULL WHERE po_id='PO2'; UPDATE po_revisions SET status='DRAFT' WHERE revision_id='REV2'; UPDATE phase6_shipments SET planned_loading_date='2026-11-22', actual_loading_date=NULL WHERE shipment_id='SHP-2'; UPDATE phase6_shipments SET cash_received_amount=7500, status='DOCS_SENT' WHERE shipment_id='SHP-1'; UPDATE shipment_invoices SET invoice_date='2026-09-01' WHERE invoice_id='INV-1'");
  const repo=createDashboardRepository(wrappedDb);
  const now=new Date('2026-11-21T00:00:00Z');
  for(const role of ['ADMIN','MANAGER','SALES_SUPPORT','EXPORT']) {
    const result=await repo.getExecutiveDashboard({role,user_id:'U_ADMIN'},now);
    assert.equal(result.totalContract,150);
    assert.deepEqual(result.contractValue,{USD:50000,EUR:20000});
    assert.deepEqual(result.receivables,{USD:2500});
    assert.equal(result.overdue,1);
    assert.equal(result.upcoming.small,1);
    assert.ok(result.products.some(item=>item.contract===50));
    assert.ok(result.months.some(item=>item.planned===15 || item.planned===35));
    assert.ok(result.watchlist.some(row=>row.ref==='WCAT-001'));
  }
  const warehouse=await repo.getExecutiveDashboard({role:'PRODUCTION_WAREHOUSE',user_id:'U_WH'},now);
  assert.equal(warehouse.totalContract,150);
  assert.equal(warehouse.contractValue,undefined);
  assert.equal(warehouse.receivables,undefined);
  assert.ok(warehouse.watchlist.every(row=>!row.currency && !row.amount && !row.customer && !row.ref));
  assert.match(warehouse.watchlist[0].diId,/^[0-9a-f]{64}$/);
  const sales=await repo.getExecutiveDashboard({role:'EXTERNAL_SALES',user_id:'U_SALES2'},now);
  assert.equal(sales.totalContract,50);
  assert.deepEqual(sales.contractValue,{EUR:20000});
  assert.deepEqual(sales.watchlist.map(row=>row.poId),['PO2']);
  assert.ok(sales.months.every(month=>month.actual===0));
});

test('dashboard analytics resolve grade from specs and filter Bangkok calendar periods', async () => {
  const {db,wrappedDb}=await setupTestDb();
  await seedFullDashboardFixture(db);
  db.exec(`
    INSERT INTO product_applications(product_id,application) VALUES ('P1','FEED_GRADE'),('P2','PET_GRADE');
    INSERT INTO standard_specs(standard_spec_id,product_id,application,revision_no,effective_date)
      VALUES ('FEED1','P1','FEED_GRADE',1,'2026-09-01'),('PET1','P2','PET_GRADE',1,'2026-09-01');
    UPDATE po_revision_lines SET spec_revision_id='FEED1' WHERE line_id='L1';
    UPDATE po_revision_lines SET spec_revision_id='PET1' WHERE line_id='L2';
    UPDATE po_revisions SET po_date='2026-11-01' WHERE revision_id='REV1';
    UPDATE po_revisions SET po_date='2026-10-01' WHERE revision_id='REV2';
    UPDATE phase6_shipments SET planned_loading_date='2026-11-22', planned_loading_end_date='2026-11-24', actual_loading_date='2026-11-24' WHERE shipment_id='SHP-1';
  `);
  const repo=createDashboardRepository(wrappedDb);
  const now=new Date('2026-11-24T00:00:00Z');
  const admin={role:'ADMIN',user_id:'U_ADMIN'};
  const result=await repo.getExecutiveDashboard(admin,now,'this_quarter');
  assert.deepEqual(result.gradeBreakdown.map(({grade,contract,actual,remaining,sharePct,contractValue})=>({grade,contract,actual,remaining,sharePct,contractValue})),[
    {grade:'FEED_GRADE',contract:100,actual:20,remaining:80,sharePct:66.7,contractValue:{USD:50000}},
    {grade:'PET_GRADE',contract:50,actual:0,remaining:50,sharePct:33.3,contractValue:{EUR:20000}}
  ]);
  assert.equal(result.onPlanRatePct,100);
  assert.equal(result.loadedCount,1);
  assert.equal((await repo.getExecutiveDashboard(admin,now,'this_month')).totalContract,100);
  assert.equal((await repo.getExecutiveDashboard(admin,now,'this_year')).totalContract,150);
  assert.ok(result.insights.every(item=>item.en && item.th));
  const warehouse=await repo.getExecutiveDashboard({role:'PRODUCTION_WAREHOUSE',user_id:'U_WH'},now);
  assert.ok(warehouse.gradeBreakdown.every(item=>item.contractValue===undefined));
  assert.doesNotMatch(JSON.stringify(warehouse.insights),/USD|EUR/);
  const invalid=await worker.fetch(makeRequest('/api/dashboard?period=invalid','GET','admin-token'),{DB:wrappedDb});
  assert.equal(invalid.status,400);
});

test('dashboard endpoint returns live analytics for every period on the complete schema', async () => {
  const {db,wrappedDb}=await setupTestDb();
  await seedFullDashboardFixture(db);
  db.exec(`
    INSERT INTO product_applications(product_id,application) VALUES ('P1','FEED_GRADE'),('P2','PET_GRADE');
    INSERT INTO standard_specs(standard_spec_id,product_id,application,revision_no,effective_date)
      VALUES ('SPEC-F','P1','FEED_GRADE',1,'2026-01-01'),('SPEC-P','P2','PET_GRADE',1,'2026-01-01');
    UPDATE po_headers SET header_status='OPEN', current_active_revision_id=NULL;
    UPDATE po_revisions SET status='DRAFT';
    UPDATE po_revision_lines SET spec_revision_id=CASE product_id WHEN 'P1' THEN 'SPEC-F' ELSE 'SPEC-P' END;
  `);
  for(const suffix of ['', '?period=all','?period=this_month','?period=this_quarter','?period=this_year']) {
    const response=await worker.fetch(makeRequest('/api/dashboard'+suffix,'GET','admin-token'),{DB:wrappedDb});
    assert.equal(response.status,200,suffix);
    const {data}=await response.json();
    assert.equal(data.executiveUnavailable,undefined);
    assert.equal(data.executive.gradeBreakdown.length,2);
    assert.ok(data.health.length);
    assert.ok(data.role_breakdown.length);
    if(!suffix || suffix==='?period=all') assert.equal(data.executive.totalContract,150);
  }
  const empty=await setupTestDb();
  const overview=await createDashboardRepository(empty.wrappedDb).getExecutiveDashboard({role:'ADMIN'});
  assert.equal(overview.totalContract,0);
  assert.deepEqual(overview.products,[]);
});

test('external sales analytics separate paid, unpaid and pipeline commission and scope by assigned customer', async () => {
  const {db,wrappedDb}=await setupTestDb();
  await seedFullDashboardFixture(db);
  db.exec(`
    INSERT INTO product_applications(product_id,application) VALUES ('P1','FEED_GRADE'),('P2','PET_GRADE');
    INSERT INTO standard_specs(standard_spec_id,product_id,application,revision_no,effective_date)
      VALUES ('SF','P1','FEED_GRADE',1,'2026-01-01'),('SP','P2','PET_GRADE',1,'2026-01-01');
    UPDATE po_revision_lines SET spec_revision_id=CASE product_id WHEN 'P1' THEN 'SF' ELSE 'SP' END;
    UPDATE po_revisions SET po_date='2026-11-01' WHERE revision_id='REV1';
    UPDATE po_revisions SET po_date='2026-10-01',status='DRAFT' WHERE revision_id='REV2';
    UPDATE po_headers SET current_active_revision_id=NULL WHERE po_id='PO2';
    UPDATE phase6_shipments SET status='LOADED',cash_received_amount=100,actual_loading_date='2026-11-10' WHERE shipment_id='SHP-2';
    INSERT INTO shipment_invoices (invoice_id,shipment_id,invoice_no,invoice_date,currency,version,invoice_write_token,final_container_version,created_by)
      VALUES ('IX','SHP-2','WCAT014','2026-11-10','EUR','FINAL','ix',0,'U_EXP');
    INSERT INTO shipment_invoice_lines(invoice_line_id,invoice_id,po_revision_line_id,qty_mt,unit_price_snapshot,currency,line_amount,created_by)
      VALUES ('LX','IX','L2',15,400,'EUR',6000,'U_EXP');
  `);
  const response=await worker.fetch(makeRequest('/api/external-sales/analytics','GET','exp-token'),{DB:wrappedDb});
  assert.equal(response.status,200);
  const {data}=await response.json();
  assert.equal(data.summary.earnedCommissionUsd,200);
  assert.equal(data.summary.pendingCommissionUsd,180);
  assert.equal(data.summary.forecastCommissionUsd,1220);
  assert.equal(data.summary.paidShippedMt,20);
  assert.equal(data.summary.unpaidShippedMt,15);
  assert.deepEqual(data.summary.contractValueByCurrency,{USD:50000,EUR:20000});
  assert.equal(data.grades.find(item=>item.grade==='PET_GRADE').shippedMt,15);
  const own=await worker.fetch(makeRequest('/api/external-sales/analytics','GET','sales1-token'),{DB:wrappedDb});
  const scoped=(await own.json()).data;
  assert.deepEqual(scoped.reps.map(rep=>rep.id),['U_SALES1']);
  assert.equal(scoped.summary.pendingCommissionUsd,0);
  assert.equal(scoped.summary.companySharePct,undefined);
  assert.equal(scoped.summary.unassignedCustomers,undefined);
  const {buildExternalSalesAnalytics}=await import('../src/external-sales/analytics.js');
  const filtered=await buildExternalSalesAnalytics(wrappedDb,{role:'EXPORT'},{period:'this_month',status:'active'},new Date('2026-11-21T00:00:00Z'));
  assert.equal(filtered.summary.contractedMt,100);
  const searched=await buildExternalSalesAnalytics(wrappedDb,{role:'EXPORT'},{search:scoped.reps[0].customers[0].name});
  assert.deepEqual(searched.reps.map(rep=>rep.id),['U_SALES1']);
  assert.equal((await worker.fetch(makeRequest('/api/external-sales/analytics','GET','wh-token'),{DB:wrappedDb})).status,403);
});
