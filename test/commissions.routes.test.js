import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMISSION_STATUSES,
  parseCommissionsQuery,
  validateSettlePayload,
  validateSettlementNoteUpdate
} from '../src/commissions/validation.js';

test('commissions validation exposes canonical statuses and parses query filters strictly', () => {
  assert.deepEqual(COMMISSION_STATUSES, ['PENDING', 'PAYABLE', 'PAID']);

  assert.deepEqual(
    parseCommissionsQuery(new URLSearchParams('status=payable&recipientUserId=U_SALES&customerId=C1&paidDateFrom=2026-11-01&paidDateTo=2026-11-30&search= DI-001 ')),
    {
      status: 'PAYABLE',
      recipientUserId: 'U_SALES',
      customerId: 'C1',
      paidDateFrom: '2026-11-01',
      paidDateTo: '2026-11-30',
      search: 'DI-001'
    }
  );

  assert.deepEqual(
    parseCommissionsQuery(new URLSearchParams('status=ALL&recipientUserId=ALL&customerId=ALL&search=   ')),
    {
      status: undefined,
      recipientUserId: undefined,
      customerId: undefined,
      paidDateFrom: undefined,
      paidDateTo: undefined,
      search: undefined
    }
  );

  assert.throws(() => parseCommissionsQuery(new URLSearchParams('status=APPROVED')), /COMMISSION_STATUS_INVALID/);
  assert.throws(() => parseCommissionsQuery(new URLSearchParams('paidDateFrom=2026-02-30')), /COMMISSION_DATE_INVALID/);
  assert.throws(() => parseCommissionsQuery(new URLSearchParams('paidDateTo=bad-date')), /COMMISSION_DATE_INVALID/);
  assert.throws(() => parseCommissionsQuery(new URLSearchParams('paidDateFrom=2026-11-20&paidDateTo=2026-11-10')), /COMMISSION_DATE_RANGE_INVALID/);
});

test('validateSettlePayload enforces strict allowlist and rejects client-supplied amounts', () => {
  assert.deepEqual(
    validateSettlePayload({
      shipmentId: ' SHP-1 ',
      recipientUserId: ' U_SALES ',
      paidDate: '2026-11-19',
      paymentReference: ' TT-COM-001 ',
      note: ' Settled ',
      requestKey: ' req-123 '
    }),
    {
      shipmentId: 'SHP-1',
      recipientUserId: 'U_SALES',
      paidDate: '2026-11-19',
      paymentReference: 'TT-COM-001',
      note: 'Settled',
      requestKey: 'req-123'
    }
  );

  const minimal = validateSettlePayload({
    shipmentId: 'SHP-1',
    recipientUserId: 'U_SALES',
    paidDate: '2026-11-19',
    paymentReference: '  ',
    note: '',
    requestKey: 'req-124'
  });
  assert.equal(minimal.paymentReference, null);
  assert.equal(minimal.note, null);

  assert.throws(
    () => validateSettlePayload({ shipmentId: 'SHP-1', recipientUserId: 'U_SALES', paidDate: '2026-11-19', requestKey: 'req-1', amountUsd: 9999 }),
    /COMMISSION_PROPERTY_INVALID/
  );
  assert.throws(
    () => validateSettlePayload({ shipmentId: '', recipientUserId: 'U_SALES', paidDate: '2026-11-19', requestKey: 'req-1' }),
    /COMMISSION_SHIPMENT_REQUIRED/
  );
  assert.throws(
    () => validateSettlePayload({ shipmentId: 'SHP-1', recipientUserId: '', paidDate: '2026-11-19', requestKey: 'req-1' }),
    /COMMISSION_RECIPIENT_REQUIRED/
  );
  assert.throws(
    () => validateSettlePayload({ shipmentId: 'SHP-1', recipientUserId: 'U_SALES', paidDate: '2026-02-30', requestKey: 'req-1' }),
    /COMMISSION_PAID_DATE_INVALID/
  );
  assert.throws(
    () => validateSettlePayload({ shipmentId: 'SHP-1', recipientUserId: 'U_SALES', paidDate: '2026-11-19', requestKey: '  ' }),
    /COMMISSION_REQUEST_KEY_REQUIRED/
  );
});

test('validateSettlementNoteUpdate allows only paymentReference and note and blocks immutable fields', () => {
  assert.deepEqual(
    validateSettlementNoteUpdate({ paymentReference: ' TT-99 ', note: ' Updated note ' }),
    { hasPaymentReference: true, paymentReference: 'TT-99', hasNote: true, note: 'Updated note' }
  );
  assert.deepEqual(
    validateSettlementNoteUpdate({ note: '' }),
    { hasPaymentReference: false, paymentReference: undefined, hasNote: true, note: null }
  );

  assert.throws(() => validateSettlementNoteUpdate({}), /COMMISSION_PAYLOAD_INVALID/);
  assert.throws(() => validateSettlementNoteUpdate({ amountUsd: 500 }), /COMMISSION_PROPERTY_INVALID/);
  assert.throws(() => validateSettlementNoteUpdate({ paidDate: '2026-11-20' }), /COMMISSION_PROPERTY_INVALID/);
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
  ).run(userId, `${role} ${userId}`, `${userId}@example.com`, role, role === 'EXTERNAL_SALES' ? 'OWN_CUSTOMERS' : 'ALL', 'hash', 'salt');
  db.prepare(
    'INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 60000).toISOString());
}

function seedCommissionRouteFixture(db) {
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Meelunie', 'U_SALES1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'EuroStarch', 'U_SALES2', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo', '40HC', 'Floor', 'U_SALES1', 10)").run();

  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L2', 'REV2', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 400, 'Jumbo', '40HC', 'Floor', 'U_SALES2', 12)").run();

  // SHP-1 (U_SALES1): PAYABLE (20 MT * $10 = $200)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '1 x 40HC', 'COMPLETED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'L1', 'P1', 20, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, actual_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-1', 'DI-1', 'COMPLETED', 'BK-001', '2026-11-15', '2026-11-12', 10000, 'PAID', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-1', 'SHP-1', 'MSCU111', '40HC', 'LOADED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-1', 'CNT-1', 'DIL-1', 20, 20, 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-001', '2026-11-13', 'USD', 'FINAL', 1, 'tok1', 1, 'U_ADMIN')").run();

  // SHP-2 (U_SALES2): PAYABLE (15 MT * $12 = $180)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C2', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '1 x 20GP', 'COMPLETED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-2', 'DI-2', 'PO2', 'REV2', 'L2', 'P1', 15, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, actual_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-2', 'DI-2', 'COMPLETED', 'BK-002', '2026-11-18', '2026-11-15', 6000, 'PAID', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-2', 'SHP-2', 'MSCU222', '20GP', 'LOADED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-2', 'CNT-2', 'DIL-2', 15, 15, 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-2', 'SHP-2', 'WCAT-002', '2026-11-16', 'EUR', 'FINAL', 1, 'tok2', 1, 'U_ADMIN')").run();
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

test('worker dispatches /api/commissions and returns 503 without DB binding', async () => {
  const res = await worker.fetch(makeRequest('/api/commissions'), {});
  assert.equal(res.status, 503);
});

test('strict RBAC returns 401 unauthenticated and 403 for SALES_SUPPORT, EXPORT, and PRODUCTION_WAREHOUSE', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_SUP', 'SALES_SUPPORT', 'sup-token');
  await seedUserAndSession(db, 'U_EXP', 'EXPORT', 'exp-token');
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'wh-token');

  const endpoints = [
    ['/api/commissions', 'GET', null],
    ['/api/commissions/CS-0001', 'GET', null],
    ['/api/commissions/settle', 'POST', { shipmentId: 'SHP-1', recipientUserId: 'U_SALES1', paidDate: '2026-11-19', requestKey: 'r1' }],
    ['/api/commissions/CS-0001', 'PATCH', { note: 'x' }]
  ];

  for (const [path, method, body] of endpoints) {
    assert.equal((await worker.fetch(makeRequest(path, method, body), { DB: wrappedDb })).status, 401);
    for (const token of ['sup-token', 'exp-token', 'wh-token']) {
      assert.equal((await worker.fetch(makeRequest(path, method, body, token), { DB: wrappedDb })).status, 403, `${token} ${method} ${path} must return 403`);
    }
  }
});

test('ADMIN/MANAGER settle lifecycle and EXTERNAL_SALES strict recipient isolation & anti-inference', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_MGR', 'MANAGER', 'mgr-token');
  await seedUserAndSession(db, 'U_SALES1', 'EXTERNAL_SALES', 'sales1-token');
  await seedUserAndSession(db, 'U_SALES2', 'EXTERNAL_SALES', 'sales2-token');
  seedCommissionRouteFixture(db);

  // MANAGER settles SHP-1 for U_SALES1 and SHP-2 for U_SALES2
  const settle1 = await worker.fetch(makeRequest('/api/commissions/settle', 'POST', {
    shipmentId: 'SHP-1',
    recipientUserId: 'U_SALES1',
    paidDate: '2026-11-19',
    paymentReference: 'WIRE-001',
    note: 'Paid Nov 19',
    requestKey: 'key-s1'
  }, 'mgr-token'), { DB: wrappedDb });
  assert.equal(settle1.status, 200);
  const cs1 = (await settle1.json()).data.settlement;
  assert.equal(cs1.settlement_id, 'CS-0001');
  assert.equal(cs1.amount_usd_snapshot, 200);

  // Duplicate settle returns 409
  const dupSettle = await worker.fetch(makeRequest('/api/commissions/settle', 'POST', {
    shipmentId: 'SHP-1',
    recipientUserId: 'U_SALES1',
    paidDate: '2026-11-19',
    requestKey: 'key-s1-dup'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(dupSettle.status, 409);

  const settle2 = await worker.fetch(makeRequest('/api/commissions/settle', 'POST', {
    shipmentId: 'SHP-2',
    recipientUserId: 'U_SALES2',
    paidDate: '2026-11-19',
    paymentReference: 'WIRE-002',
    requestKey: 'key-s2'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(settle2.status, 200);
  const cs2 = (await settle2.json()).data.settlement;
  assert.equal(cs2.settlement_id, 'CS-0002');

  // ADMIN patches note on CS-0001
  const patch1 = await worker.fetch(makeRequest('/api/commissions/CS-0001', 'PATCH', {
    paymentReference: 'WIRE-001-FINAL',
    note: 'Bank slip verified'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(patch1.status, 200);
  assert.equal((await patch1.json()).data.settlement.payment_reference, 'WIRE-001-FINAL');

  // EXTERNAL_SALES (U_SALES1) sees ONLY own row even when querying recipientUserId=U_SALES2 or customerId=C2
  const extList = await worker.fetch(makeRequest('/api/commissions?recipientUserId=U_SALES2&customerId=C2', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(extList.status, 200);
  const extBody = await extList.json();
  assert.equal(extBody.data.items.length, 1);
  assert.deepEqual(extBody.data.recipients, []);
  const extRow = extBody.data.items[0];
  assert.equal(extRow.settlement_id, 'CS-0001');
  assert.equal(extRow.di_no, 'DI-001');
  assert.equal(extRow.commission_amount_usd, 200);
  assert.equal(extRow.status, 'PAID');
  for (const forbidden of ['shipment_id', 'di_id', 'po_id', 'po_revision_id', 'customer_id', 'recipient_user_id', 'settled_by', 'can_settle']) {
    assert.equal(forbidden in extRow, false, `${forbidden} must not leak to EXTERNAL_SALES`);
  }

  // EXTERNAL_SALES can view own settlement receipt (projected), receives 404 for another recipient's settlement
  const ownDetail = await worker.fetch(makeRequest('/api/commissions/CS-0001', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(ownDetail.status, 200);
  const ownDetailBody = await ownDetail.json();
  assert.equal(ownDetailBody.data.settlement.settlement_id, 'CS-0001');
  assert.deepEqual(ownDetailBody.data.auditHistory, []);
  assert.equal('settled_by' in ownDetailBody.data.settlement, false);

  const otherDetail = await worker.fetch(makeRequest('/api/commissions/CS-0002', 'GET', null, 'sales1-token'), { DB: wrappedDb });
  assert.equal(otherDetail.status, 404);

  // EXTERNAL_SALES denied on settle & patch
  assert.equal((await worker.fetch(makeRequest('/api/commissions/settle', 'POST', {
    shipmentId: 'SHP-1', recipientUserId: 'U_SALES1', paidDate: '2026-11-19', requestKey: 'ext-try'
  }, 'sales1-token'), { DB: wrappedDb })).status, 403);
  assert.equal((await worker.fetch(makeRequest('/api/commissions/CS-0001', 'PATCH', { note: 'hack' }, 'sales1-token'), { DB: wrappedDb })).status, 403);

  // ADMIN sees both rows and full audit detail
  const adminList = await worker.fetch(makeRequest('/api/commissions', 'GET', null, 'admin-token'), { DB: wrappedDb });
  assert.equal(adminList.status, 200);
  const adminBody = await adminList.json();
  assert.equal(adminBody.data.items.length, 2);
  assert.equal(adminBody.data.recipients.length, 2);
  assert.equal(adminBody.data.summary.paid_usd, 380);

  const adminDetail = await worker.fetch(makeRequest('/api/commissions/CS-0001', 'GET', null, 'admin-token'), { DB: wrappedDb });
  assert.equal(adminDetail.status, 200);
  assert.equal((await adminDetail.json()).data.auditHistory.length, 2);
});
