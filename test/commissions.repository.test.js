import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCommissionsRepository } from '../src/commissions/repository.js';

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

function seedCommissionFixture(db) {
  for (const [id, role, name] of [
    ['U_MGR', 'MANAGER', 'Managing Director'],
    ['U_ADMIN', 'ADMIN', 'System Admin'],
    ['U_SALES1', 'EXTERNAL_SALES', 'Sira TTPagro'],
    ['U_SALES2', 'EXTERNAL_SALES', 'AL Sommerer']
  ]) {
    db.prepare(
      "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, 'hash', 'salt', ?, 'ACTIVE', ?)"
    ).run(id, `${id}@example.com`, role, name);
  }

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C1', 'CUST1', 'Meelunie B.V.', 'U_SALES1', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id, ownership_type) VALUES ('C2', 'CUST2', 'EuroStarch GmbH', 'U_SALES2', 'ASSIGNED_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P2', 'THS-85', 'Tapioca Starch 85%', 'THS85', 'CAT1', 'FRM1')").run();

  // PO1 (C1): 2 lines for U_SALES1 with different rates ($10/MT on P1, $15/MT on P2) + 1 zero-rate line (must be excluded)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'CPO-1', 'ASSIGNED_SALES', 'U_SALES1', 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L1', 'REV1', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 500, 'Jumbo', '40HC', 'Floor', 'U_SALES1', 10)").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L2', 'REV1', 20, 'P2', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 600, 'Jumbo', '40HC', 'Floor', 'U_SALES1', 15)").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L3', 'REV1', 30, 'P1', 'STANDARD', 'SPEC1', 50, 10, 45, 55, 500, 'Jumbo', '40HC', 'Floor', 'U_SALES1', 0)").run();

  // PO2 (C2): 1 line for U_SALES2 ($12/MT)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'CPO-2', 'ASSIGNED_SALES', 'U_SALES2', 'EUR', 'CIF', '2026-11-01', '2026-11-30', '2026-12-31', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern, commission_recipient_user_id, commission_rate_usd_mt) VALUES ('L4', 'REV2', 10, 'P1', 'STANDARD', 'SPEC1', 100, 10, 90, 110, 400, 'Jumbo', '40HC', 'Floor', 'U_SALES2', 12)").run();

  // SHP-1 (C1, U_SALES1): PAID + FINAL invoice + 2 active containers (20 MT of L1 @ $10 = $200, 10 MT of L2 @ $15 = $150 -> total 30 MT, $350) + 1 CANCELLED container (must be ignored!) -> PAYABLE
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-001', '2026-11', 'FIRST_HALF', '2 x 40HC', 'COMPLETED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-1', 'DI-1', 'PO1', 'REV1', 'L1', 'P1', 20, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-2', 'DI-1', 'PO1', 'REV1', 'L2', 'P2', 10, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, actual_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-1', 'DI-1', 'COMPLETED', 'BK-001', '2026-11-15', '2026-11-12', 16000, 'PAID', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-1', 'SHP-1', 'MSCU111', '40HC', 'LOADED', 'U_ADMIN'), ('CNT-2', 'SHP-1', 'MSCU222', '40HC', 'CANCELLED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-1', 'CNT-1', 'DIL-1', 20, 20, 'U_ADMIN'), ('CL-2', 'CNT-1', 'DIL-2', 10, 10, 'U_ADMIN'), ('CL-3', 'CNT-2', 'DIL-1', 5, 5, 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-1', 'SHP-1', 'WCAT-001', '2026-11-13', 'USD', 'FINAL', 1, 'tok1', 1, 'U_ADMIN')").run();

  // SHP-2 (C2, U_SALES2): Loaded 25 MT @ $12 = $300, FINAL invoice, but payment_status = PARTIAL -> PENDING
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-2', 'C2', 'PO2', 'REV2', 'DI-002', '2026-11', 'SECOND_HALF', '1 x 40HC', 'IN_PROGRESS', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-3', 'DI-2', 'PO2', 'REV2', 'L4', 'P1', 25, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, etd, actual_loading_date, cash_received_amount, payment_status, created_by) VALUES ('SHP-2', 'DI-2', 'DOCS_SENT', 'BK-002', '2026-11-20', '2026-11-16', 5000, 'PARTIAL', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CNT-3', 'SHP-2', 'MSCU333', '40HC', 'LOADED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by) VALUES ('CL-4', 'CNT-3', 'DIL-3', 25, 25, 'U_ADMIN')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version, created_by) VALUES ('INV-2', 'SHP-2', 'WCAT-002', '2026-11-17', 'EUR', 'FINAL', 1, 'tok2', 1, 'U_ADMIN')").run();

  // SHP-3 (C1, U_SALES1): CANCELLED shipment (must be excluded)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-3', 'C1', 'PO1', 'REV1', 'DI-003', '2026-11', 'FIRST_HALF', '1 x 20GP', 'CONFIRMED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-4', 'DI-3', 'PO1', 'REV1', 'L1', 'P1', 10, 'Jumbo', 'U_ADMIN')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, cash_received_amount, payment_status, created_by) VALUES ('SHP-3', 'DI-3', 'CANCELLED', 0, 'UNPAID', 'U_ADMIN')").run();
}

test('listCommissions calculates multi-line actual MT x rate, excludes cancelled containers/shipments, and computes KPIs', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedCommissionFixture(db);
  const repo = createCommissionsRepository(wrappedDb);

  const res = await repo.listCommissions();
  assert.equal(res.items.length, 2);

  // Ordered PAYABLE first, then PENDING
  const payable = res.items[0];
  assert.equal(payable.shipment_id, 'SHP-1');
  assert.equal(payable.recipient_user_id, 'U_SALES1');
  assert.equal(payable.status, 'PAYABLE');
  assert.equal(payable.actual_shipped_mt, 30);
  assert.equal(payable.commission_amount_usd, 350); // 20*10 + 10*15 (cancelled container 5 MT ignored)
  assert.equal(payable.line_breakdown.length, 2);

  const pending = res.items[1];
  assert.equal(pending.shipment_id, 'SHP-2');
  assert.equal(pending.recipient_user_id, 'U_SALES2');
  assert.equal(pending.status, 'PENDING');
  assert.equal(pending.actual_shipped_mt, 25);
  assert.equal(pending.commission_amount_usd, 300);

  assert.deepEqual(res.summary, {
    total_count: 2,
    pending_count: 1,
    payable_count: 1,
    paid_count: 0,
    pending_usd: 300,
    payable_usd: 350,
    paid_usd: 0,
    total_usd: 650
  });
  assert.equal(res.recipients.length, 2);
});

test('settleCommission freezes immutable snapshot, enforces idempotency & double-payout protection, and supports note updates', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedCommissionFixture(db);
  const repo = createCommissionsRepository(wrappedDb);

  // Reject settling PENDING (unpaid/partial) shipment
  await assert.rejects(
    () => repo.settleCommission({
      shipmentId: 'SHP-2',
      recipientUserId: 'U_SALES2',
      paidDate: '2026-11-19',
      requestKey: 'req-pending'
    }, 'U_MGR'),
    /COMMISSION_NOT_PAYABLE/
  );

  // Settle PAYABLE SHP-1
  const settled = await repo.settleCommission({
    shipmentId: 'SHP-1',
    recipientUserId: 'U_SALES1',
    paidDate: '2026-11-19',
    paymentReference: 'WIRE-2026-1119',
    note: 'November payout',
    requestKey: 'req-shp1-settle'
  }, 'U_MGR');

  assert.equal(settled.settlement_id, 'CS-0001');
  assert.equal(settled.status, 'PAID');
  assert.equal(settled.actual_mt_snapshot, 30);
  assert.equal(settled.amount_usd_snapshot, 350);
  assert.equal(settled.payment_reference, 'WIRE-2026-1119');

  // Idempotent replay with same requestKey returns existing settlement
  const replay = await repo.settleCommission({
    shipmentId: 'SHP-1',
    recipientUserId: 'U_SALES1',
    paidDate: '2026-11-19',
    requestKey: 'req-shp1-settle'
  }, 'U_MGR');
  assert.equal(replay.settlement_id, 'CS-0001');

  // Mismatched requestKey replay rejected with conflict
  await assert.rejects(
    () => repo.settleCommission({
      shipmentId: 'SHP-1',
      recipientUserId: 'U_SALES1',
      paidDate: '2026-11-20',
      requestKey: 'req-shp1-settle'
    }, 'U_MGR'),
    /COMMISSION_REQUEST_KEY_CONFLICT/
  );

  // Double payout with new requestKey rejected
  await assert.rejects(
    () => repo.settleCommission({
      shipmentId: 'SHP-1',
      recipientUserId: 'U_SALES1',
      paidDate: '2026-11-19',
      requestKey: 'req-shp1-second'
    }, 'U_MGR'),
    /COMMISSION_ALREADY_SETTLED/
  );

  // Snapshot immutability: mutating PO line rate afterwards must NOT alter settled amount!
  db.prepare("UPDATE po_revision_lines SET commission_rate_usd_mt = 99 WHERE line_id = 'L1'").run();
  const afterRateChange = await repo.listCommissions({ recipientUserId: 'U_SALES1' });
  assert.equal(afterRateChange.items.length, 1);
  assert.equal(afterRateChange.items[0].status, 'PAID');
  assert.equal(afterRateChange.items[0].commission_amount_usd, 350);

  // Update payment reference & note with audit trail
  const updated = await repo.updateSettlementMetadata('CS-0001', {
    paymentReference: 'WIRE-2026-1119-REV',
    note: 'Updated bank ref'
  }, 'U_ADMIN');
  assert.equal(updated.payment_reference, 'WIRE-2026-1119-REV');
  assert.equal(updated.note, 'Updated bank ref');

  const detail = await repo.getSettlementDetail('CS-0001');
  assert.equal(detail.settlement.amount_usd_snapshot, 350);
  assert.equal(detail.auditHistory.length, 2);
  assert.equal(detail.auditHistory[0].event_type, 'COMMISSION_NOTE_UPDATED');
  assert.equal(detail.auditHistory[1].event_type, 'COMMISSION_SETTLED');
});

test('EUR PO currency is separate from USD commission calculation', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedCommissionFixture(db);
  db.exec("UPDATE po_revisions SET currency = 'EUR' WHERE revision_id = 'REV1'");
  const result = await createCommissionsRepository(wrappedDb).listCommissions();
  const item = result.items.find(row => row.shipment_id === 'SHP-1');
  assert.equal(item.po_currency, 'EUR');
  assert.equal(item.currency, 'USD');
  assert.equal(item.commission_amount_usd, 350);
  db.close();
});
