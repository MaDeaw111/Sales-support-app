import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCalendarRepository } from '../src/calendar/repository.js';

async function setupCalendarFixture() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql', '0002_customers.sql', '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql', '0005_po_management.sql',
    '0006_customer_ownership_type.sql', '0007_shipping_di_integration.sql', '0015_di_loading_date_range.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  for (const [userId, role, name] of [
    ['U_ADMIN', 'ADMIN', 'Admin User'],
    ['U_EXPORT', 'EXPORT', 'Export Ops'],
    ['U_SALES_1', 'EXTERNAL_SALES', 'Sira Sales'],
    ['U_SALES_2', 'EXTERNAL_SALES', 'Other Sales']
  ]) {
    db.prepare(
      "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES (?, ?, 'hash', 'salt', ?, 'ACTIVE', ?)"
    ).run(userId, `${userId}@example.com`, role, name);
  }

  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'MEEL', 'MEELUNIE B.V.', 'U_SALES_1')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C2', 'LKO', 'LKO Feeds', 'U_SALES_2')").run();

  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P2', 'SPP-70', 'Sweet Potato Pellet', 'SPP70', 'CAT1', 'FORM1')").run();

  // PO1 (ACTIVE, owned by U_SALES_1, P1) — delivery 2026-11-05 .. 2026-11-25, valid_until 2026-11-28 (valid_until must NOT appear)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO1', 'C1', 'PARTIALLY_SHIPPED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'PO-MEEL-01', 'ASSIGNED_SALES', 'U_SALES_1', 'USD', 'FOB', 'Rotterdam', '2026-11-05', '2026-11-25', '2026-11-28', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE1', 'REV1', 1, 'P1', 'STANDARD', 'SPEC1', 100, 5, 95, 105, 350, 'Jumbo Bag 850 kg', '20GP', '20 bags')").run();

  // PO2 (ACTIVE, owned by U_SALES_2, P2)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO2', 'C2', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'PO-LKO-02', 'ASSIGNED_SALES', 'U_SALES_2', 'USD', 'CIF', 'Brisbane', '2026-11-10', '2026-11-29', '2026-12-15', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES ('LINE2', 'REV2', 1, 'P2', 'STANDARD', 'SPEC2', 54, 0, 54, 54, 410, '50 kg PP Bag', '20GP', '540 bags')").run();

  // PO3 (CANCELLED — must be excluded)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO3', 'C1', 'CANCELLED', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV3', 'PO3', 0, 'ACTIVE', 'PO-CANCEL', 'ASSIGNED_SALES', 'U_SALES_1', 'USD', 'FOB', 'Rotterdam', '2026-11-06', '2026-11-26', '2026-12-01', 'U_ADMIN')").run();

  // PO4 (DRAFT only — must be excluded)
  db.prepare("INSERT INTO po_headers (po_id, customer_id, header_status, created_by) VALUES ('PO4', 'C1', 'OPEN', 'U_ADMIN')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, customer_po_no, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, destination, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV4', 'PO4', 0, 'DRAFT', 'PO-DRAFT', 'ASSIGNED_SALES', 'U_SALES_1', 'USD', 'FOB', 'Rotterdam', '2026-11-07', '2026-11-27', '2026-12-01', 'U_ADMIN')").run();

  // DI1 / S1 (BOOKED, planned 2026-11-12, actual NULL, ETD 2026-11-15, ETA 2026-12-10, has reschedule audit)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI1', 'C1', 'PO1', 'REV1', 'MEEL-NOV-01', '2026-11', 'FIRST_HALF', '2 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL1', 'DI1', 'PO1', 'REV1', 'LINE1', 'P1', 34, 'Jumbo Bag 850 kg', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, schedule_result, created_by, updated_by) VALUES ('S1', 'DI1', 'BOOKED', 'BK-001', 'MSC ARIES', '2026-11-15', '2026-12-10', '2026-11-12', NULL, NULL, 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json, created_at) VALUES ('AUD1', 'SHIPMENT', 'S1', 'PLANNED_LOADING_DATE_UPDATED', 'U_EXPORT', '{\"old\":\"2026-11-10\",\"new\":\"2026-11-12\"}', '2026-11-08 09:00:00')").run();

  // DI2 / S2 (LOADED, planned 2026-11-12 AND actual 2026-11-12 -> same day deduplication: emit LOADING_ACTUAL only!)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI2', 'C2', 'PO2', 'REV2', 'LKO-NOV-01', '2026-11', 'FIRST_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL2', 'DI2', 'PO2', 'REV2', 'LINE2', 'P2', 27, '50 kg PP Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, schedule_result, created_by, updated_by) VALUES ('S2', 'DI2', 'LOADED', 'BK-002', 'ONE OCEAN', '2026-11-18', '2026-11-29', '2026-11-12', '2026-11-12', 'ON_PLAN', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, seal_no, status, created_by, updated_by) VALUES ('CONT2', 'S2', 'MSKU1234567', '20GP', 'SL-99', 'LOADED', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by, updated_by) VALUES ('CONTL2', 'CONT2', 'DIL2', 540, 27, 'U_EXPORT', 'U_EXPORT')").run();

  // DI3 / S3 (LOADED, planned 2026-11-14, actual 2026-11-17 -> different days: emit BOTH LOADING_PLANNED and LOADING_ACTUAL)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI3', 'C1', 'PO1', 'REV1', 'MEEL-NOV-02', '2026-11', 'FIRST_HALF', '1 x 20GP', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL3', 'DI3', 'PO1', 'REV1', 'LINE1', 'P1', 17, 'Jumbo Bag 850 kg', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, booking_no, vessel, etd, eta, planned_loading_date, actual_loading_date, schedule_result, created_by, updated_by) VALUES ('S3', 'DI3', 'LOADED', 'BK-003', 'COSCO STAR', '2026-11-20', '2026-12-20', '2026-11-14', '2026-11-17', 'OUT_OF_PLAN', 'U_EXPORT', 'U_EXPORT')").run();

  // DI4 / S4 (CANCELLED — must be excluded)
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI4', 'C1', 'PO1', 'REV1', 'MEEL-CANCEL', '2026-11', 'FIRST_HALF', '1 x 20GP', 'CANCELLED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, planned_loading_date, etd, created_by, updated_by) VALUES ('S4', 'DI4', 'CANCELLED', '2026-11-13', '2026-11-16', 'U_EXPORT', 'U_EXPORT')").run();

  const wrappedDb = {
    prepare(sql) {
      const statement = db.prepare(sql);
      return {
        params: [],
        bind(...params) { this.params = params; return this; },
        async first() { return statement.all(...this.params)[0] || null; },
        async all() { return { results: statement.all(...this.params), success: true }; },
        async run() { return { success: true, meta: statement.run(...this.params) }; }
      };
    }
  };

  return { db, wrappedDb, repo: createCalendarRepository(wrappedDb) };
}

test('repository lists non-cancelled PO and Shipping/DI milestones within range, deduplicating same-day loading and excluding valid_until', async () => {
  const { repo } = await setupCalendarFixture();
  const { events, dailyLoadingSummary } = await repo.listCalendarData({
    from: '2026-11-01',
    to: '2026-11-30'
  });

  // No CANCELLED, no DRAFT PO, no valid_until
  assert.equal(events.some(e => e.po_id === 'PO3' || e.po_id === 'PO4'), false);
  assert.equal(events.some(e => e.shipment_id === 'S4'), false);
  assert.equal(events.some(e => e.event_type === 'PO_VALID_UNTIL'), false);

  // S2 has planned === actual === 2026-11-12 -> only LOADING_ACTUAL emitted for S2
  const s2Loading = events.filter(e => e.shipment_id === 'S2' && e.event_type.startsWith('LOADING_'));
  assert.equal(s2Loading.length, 1);
  assert.equal(s2Loading[0].event_type, 'LOADING_ACTUAL');
  assert.equal(s2Loading[0].actual_container_count, 1);
  assert.equal(s2Loading[0].containers.length, 1);
  assert.equal(s2Loading[0].containers[0].container_no, 'MSKU1234567');

  // S3 has planned 2026-11-14 and actual 2026-11-17 -> BOTH emitted
  const s3Loading = events.filter(e => e.shipment_id === 'S3' && e.event_type.startsWith('LOADING_'));
  assert.deepEqual(
    s3Loading.map(e => [e.event_type, e.event_date]),
    [['LOADING_PLANNED', '2026-11-14'], ['LOADING_ACTUAL', '2026-11-17']]
  );

  // S1 has ETA in Dec (outside Nov range), ETD in Nov, planned loading in Nov with audit history
  const s1Events = events.filter(e => e.shipment_id === 'S1');
  assert.deepEqual(
    s1Events.map(e => [e.event_type, e.event_date]),
    [['LOADING_PLANNED', '2026-11-12'], ['ETD', '2026-11-15']]
  );
  assert.equal(s1Events[0].loading_date_history.length, 1);
  assert.equal(s1Events[0].loading_date_history[0].old_date, '2026-11-10');
  assert.equal(s1Events[0].loading_date_history[0].new_date, '2026-11-12');

  // S2 ETA is 2026-11-29 (inside Nov range)
  assert.equal(events.some(e => e.shipment_id === 'S2' && e.event_type === 'ETA' && e.event_date === '2026-11-29'), true);

  // PO1 & PO2 delivery start/end present
  assert.equal(events.some(e => e.po_id === 'PO1' && e.event_type === 'PO_DELIVERY_START' && e.event_date === '2026-11-05'), true);
  assert.equal(events.some(e => e.po_id === 'PO1' && e.event_type === 'PO_DELIVERY_END' && e.event_date === '2026-11-25'), true);
  assert.equal(events.some(e => e.po_id === 'PO2' && e.event_type === 'PO_DELIVERY_START' && e.event_date === '2026-11-10'), true);
  assert.equal(events.some(e => e.po_id === 'PO2' && e.event_type === 'PO_DELIVERY_END' && e.event_date === '2026-11-29'), true);

  // Daily loading summary on 2026-11-12 combines S1 (planned 34 MT, 0 actual containers) + S2 (actual 27 MT, 1 actual container)
  const nov12 = dailyLoadingSummary.find(d => d.date === '2026-11-12');
  assert.deepEqual(nov12, {
    date: '2026-11-12',
    shipment_count: 2,
    actual_container_count: 1,
    planned_qty_mt: 61
  });
});

test('repository supports loadingOnly, ownedByUserId, customerId, salesOwnerId, productId, eventType, and status filters', async () => {
  const { repo } = await setupCalendarFixture();

  const warehouse = await repo.listCalendarData({
    from: '2026-11-01',
    to: '2026-11-30',
    loadingOnly: true
  });
  assert.ok(warehouse.events.length > 0);
  assert.equal(warehouse.events.every(e => e.event_type === 'LOADING_PLANNED' || e.event_type === 'LOADING_ACTUAL'), true);

  const owned = await repo.listCalendarData({
    from: '2026-11-01',
    to: '2026-11-30',
    ownedByUserId: 'U_SALES_1'
  });
  assert.ok(owned.events.length > 0);
  assert.equal(owned.events.every(e => e.customer_id === 'C1'), true);

  const byProduct = await repo.listCalendarData({
    from: '2026-11-01',
    to: '2026-11-30',
    productId: 'P2'
  });
  assert.ok(byProduct.events.length > 0);
  assert.equal(byProduct.events.every(e => e.products.some(p => p.product_id === 'P2')), true);

  const byStatus = await repo.listCalendarData({
    from: '2026-11-01',
    to: '2026-11-30',
    status: 'BOOKED'
  });
  assert.ok(byStatus.events.length > 0);
  assert.equal(byStatus.events.every(e => e.shipment_status === 'BOOKED'), true);
});

test('operations calendar expands a three-day plan and counts its tonnage once', async () => {
  const { db, repo } = await setupCalendarFixture();
  db.exec("UPDATE phase6_shipments SET planned_loading_date='2026-09-22', planned_loading_end_date='2026-09-24', actual_loading_date=NULL");
  const {events,dailyLoadingSummary} = await repo.listCalendarData({from:'2026-09-22',to:'2026-09-24',eventType:'LOADING_PLANNED'});
  const shipment = events[0];
  assert.ok(shipment);
  assert.deepEqual(events.filter(event=>event.shipment_id===shipment.shipment_id).map(event=>event.loading_day),[1,2,3]);
  assert.equal(Math.round(dailyLoadingSummary.reduce((sum,day)=>sum+day.planned_qty_mt,0)*1000), Math.round(events.filter(event=>event.loading_day===1).reduce((sum,event)=>sum+event.planned_qty_mt,0)*1000));
});

test('calendar attaches ordered invoice references and suppresses them for warehouse', async () => {
  const {db,repo}=await setupCalendarFixture();
  const insert=db.prepare("INSERT INTO shipment_invoices (invoice_id,shipment_id,invoice_no,invoice_date,currency,version,invoice_write_token,final_container_version,created_by) VALUES (?, 'S1', ?, '2026-11-12', 'USD', ?, ?, ?, 'U_EXPORT')");
  insert.run('INV1','WCAT014','PRELIMINARY','token1',null);
  insert.run('INV2','WCAT015','FINAL','token2',0);
  const filters={from:'2026-11-12',to:'2026-11-15'};
  const {events}=await repo.listCalendarData(filters);
  const event=events.find(row=>row.shipment_id==='S1');
  assert.deepEqual(event.invoices,[{invoice_no:'WCAT015',invoice_type:'FINAL'},{invoice_no:'WCAT014',invoice_type:'PRELIMINARY'}]);
  const {projectCalendarEventForRole}=await import('../src/calendar/routes.js');
  for(const role of ['ADMIN','MANAGER','EXPORT','SALES_SUPPORT','EXTERNAL_SALES']) {
    const projected=await projectCalendarEventForRole(event,{role,user_id:'U_SALES_1'});
    assert.deepEqual(projected.invoices,event.invoices);
  }
  const warehouse=await projectCalendarEventForRole(event,{role:'PRODUCTION_WAREHOUSE',user_id:'U_WH'});
  assert.equal(warehouse.invoices,undefined);
});
