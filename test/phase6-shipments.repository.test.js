import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';
import { calculateScheduleResult, isDocumentRequirementSatisfied } from '../src/shipping-di/validation.js';

async function setupTestDb({ pauseFirstBatch, pauseQueuedFirstBatch } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_EXPORT', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Customer One')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'HOUSE_ACCOUNT', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-12-31', 'U_EXPORT')").run();
  for (const [lineId, lineNo] of [['LINE-1', 10], ['LINE-2', 20]]) {
    db.prepare(`
      INSERT INTO po_revision_lines (
        line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id,
        contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price,
        packaging, container_type, loading_pattern
      ) VALUES (?, 'REV1', ?, 'P1', 'STANDARD', 'SPEC-REV-1', 100, 0, 100, 100, 350, 'Jumbo Bag', '40HC', 'Floor loaded')
    `).run(lineId, lineNo);
  }
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI-DRAFT', 'C1', 'PO1', 'REV1', 'DRAFT-1', '2026-09', 'FIRST_HALF', 'DRAFT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI-CONFIRMED', 'C1', 'PO1', 'REV1', 'CONFIRMED-1', '2026-09', 'FIRST_HALF', 'CONFIRMED', 'U_EXPORT')").run();
  for (const [partnerId, partnerType] of [
    ['SP-FWD', 'FORWARDER'],
    ['SP-LINE', 'SHIPPING_LINE'],
    ['SP-TRUCK', 'TRUCKING'],
    ['SP-SURVEY', 'SURVEYOR']
  ]) {
    db.prepare('INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES (?, ?, ?, ?)')
      .run(partnerId, partnerType, partnerId, 'U_EXPORT');
  }

  let releasePreviousBatch = Promise.resolve();
  let firstBatch = true;
  const wrappedDb = {
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
      if (firstBatch && pauseFirstBatch && !pauseQueuedFirstBatch) {
        const pause = await pauseFirstBatch();
        if (pause) {
          firstBatch = false;
          await pause;
        }
      }
      const previousBatch = releasePreviousBatch;
      let releaseBatch;
      releasePreviousBatch = new Promise((resolve) => {
        releaseBatch = resolve;
      });
      if (firstBatch && pauseQueuedFirstBatch) {
        const pause = await pauseQueuedFirstBatch();
        if (pause) {
          firstBatch = false;
          await pause;
        }
      }
      await previousBatch;
      db.exec('BEGIN');
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        db.exec('COMMIT');
        return results;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      } finally {
        releaseBatch();
      }
    }
  };

  return { db, wrappedDb };
}

function seedShipmentContainerLines(db, diId = 'DI-CONFIRMED') {
  for (const [diLineId, poRevisionLineId, plannedQtyMt] of [
    ['DIL-1', 'LINE-1', 10],
    ['DIL-2', 'LINE-2', 10]
  ]) {
    db.prepare(`
      INSERT INTO delivery_instruction_lines (
        di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
        planned_qty_mt, packing_snapshot, created_by
      ) VALUES (?, ?, 'PO1', 'REV1', ?, 'P1', ?, 'Jumbo Bag', 'U_EXPORT')
    `).run(diLineId, diId, poRevisionLineId, plannedQtyMt);
  }
}

async function bookedShipmentWithActualLoadingDate(repo) {
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-CONTAINER' }, 'U_EXPORT');
  await repo.updateShipmentSchedule(shipment.shipment_id, { actualLoadingDate: '2026-09-15' }, 'U_EXPORT');
  return shipment;
}

async function loadedShipmentForDocuments(repo, db) {
  seedShipmentContainerLines(db);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');
  return shipment;
}

async function loadedShipmentWithFinalInvoice(repo, db) {
  const shipment = await loadedShipmentForDocuments(repo, db);
  await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: `WCAT-PAY-${shipment.shipment_id}`,
    version: 'FINAL',
    invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }]
  }, 'U_EXPORT');
  return shipment;
}

function seedSecondFinalPaymentShipment(db) {
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI-PAY-2', 'C1', 'PO1', 'REV1', 'PAY-2', '2026-09', 'FIRST_HALF', 'IN_PROGRESS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instruction_lines (di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by) VALUES ('DIL-PAY-2', 'DI-PAY-2', 'PO1', 'REV1', 'LINE-2', 'P1', 1, 'Jumbo Bag', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, actual_loading_date, created_by, updated_by) VALUES ('S_FOR_C1_2', 'DI-PAY-2', 'LOADED', '2026-09-15', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, created_by, updated_by) VALUES ('CONT-PAY-2', 'S_FOR_C1_2', 'PAY-CONT-2', 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by, updated_by) VALUES ('CONTL-PAY-2', 'CONT-PAY-2', 'DIL-PAY-2', 1, 1, 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoices (invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_write_token, final_container_version, created_by, updated_by) VALUES ('INV-PAY-2', 'S_FOR_C1_2', 'WCAT-PAY-2', '2026-09-15', 'USD', 'FINAL', 'TOKEN-PAY-2', 0, 'U_EXPORT', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_invoice_lines (invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by, updated_by) VALUES ('INVL-PAY-2', 'INV-PAY-2', 'LINE-2', 1, 350, 'USD', 350, 'U_EXPORT', 'U_EXPORT')").run();
}

test('a confirmed DI creates exactly one separate rich Shipment in PLANNING', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  await assert.rejects(
    () => repo.createShipmentForDeliveryInstruction('DI-DRAFT', 'U_EXPORT'),
    /DI_NOT_CONFIRMED/
  );
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');

  assert.match(shipment.shipment_id, /^SHP-/);
  assert.equal(shipment.di_id, 'DI-CONFIRMED');
  assert.equal(shipment.status, 'PLANNING');
  assert.equal((await repo.getPhase6Shipment(shipment.shipment_id)).di_id, 'DI-CONFIRMED');
  assert.equal((await repo.getPhase6Shipment('DI-CONFIRMED')).shipment_id, shipment.shipment_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phase6_shipments WHERE di_id = ?').get('DI-CONFIRMED').n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipments').get().n, 0);
  await assert.rejects(
    () => repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT'),
    /SHIPMENT_ALREADY_EXISTS/
  );
});

test('confirming a DI materializes its single PLANNING Shipment', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  const confirmed = await repo.confirmDeliveryInstruction('DI-DRAFT', 'U_EXPORT');
  const shipment = await repo.getPhase6Shipment('DI-DRAFT');

  assert.equal(confirmed.status, 'CONFIRMED');
  assert.equal(shipment.di_id, 'DI-DRAFT');
  assert.equal(shipment.status, 'PLANNING');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM phase6_shipments WHERE di_id = ?').get('DI-DRAFT').n, 1);
});

test('recording focused Booking fields moves the Shipment to BOOKED and its DI to IN_PROGRESS', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');

  const booked = await repo.recordShipmentBooking(shipment.shipment_id, {
    bookingNo: 'BK-01',
    forwarderPartnerId: 'SP-FWD',
    shippingLinePartnerId: 'SP-LINE',
    truckingPartnerId: 'SP-TRUCK',
    vessel: 'MV A',
    etd: '2026-09-12',
    eta: '2026-10-03',
    plannedLoadingDate: '2026-09-08'
  }, 'U_EXPORT');

  assert.deepEqual({
    status: booked.status,
    booking_no: booked.booking_no,
    forwarder_partner_id: booked.forwarder_partner_id,
    shipping_line_partner_id: booked.shipping_line_partner_id,
    trucking_partner_id: booked.trucking_partner_id,
    vessel: booked.vessel,
    etd: booked.etd,
    eta: booked.eta,
    planned_loading_date: booked.planned_loading_date,
    schedule_result: booked.schedule_result
  }, {
    status: 'BOOKED',
    booking_no: 'BK-01',
    forwarder_partner_id: 'SP-FWD',
    shipping_line_partner_id: 'SP-LINE',
    trucking_partner_id: 'SP-TRUCK',
    vessel: 'MV A',
    etd: '2026-09-12',
    eta: '2026-10-03',
    planned_loading_date: '2026-09-08',
    schedule_result: null
  });
  assert.equal((await repo.getDeliveryInstruction('DI-CONFIRMED')).status, 'IN_PROGRESS');
  const audit = db.prepare("SELECT entity_type, entity_id, event_type, actor_id, metadata_json FROM shipment_audit_events WHERE event_type = 'BOOKING_RECORDED'").get();
  assert.deepEqual({
    entity_type: audit.entity_type,
    entity_id: audit.entity_id,
    event_type: audit.event_type,
    actor_id: audit.actor_id
  }, {
    entity_type: 'SHIPMENT',
    entity_id: shipment.shipment_id,
    event_type: 'BOOKING_RECORDED',
    actor_id: 'U_EXPORT'
  });
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    bookingNo: 'BK-01',
    forwarderPartnerId: 'SP-FWD',
    shippingLinePartnerId: 'SP-LINE',
    truckingPartnerId: 'SP-TRUCK',
    vessel: 'MV A',
    etd: '2026-09-12',
    eta: '2026-10-03',
    plannedLoadingDate: '2026-09-08'
  });
});

test('Booking rejects fields outside its focused contract and mismatched partner types without state changes', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');

  await assert.rejects(
    () => repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', freightRate: 100 }, 'U_EXPORT'),
    /SHIPMENT_BOOKING_PROPERTY_INVALID/
  );
  await assert.rejects(
    () => repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', forwarderPartnerId: 'SP-SURVEY' }, 'U_EXPORT'),
    /SHIPMENT_FORWARDER_INVALID/
  );
  await assert.rejects(
    () => repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', shippingLinePartnerId: 'SP-SURVEY' }, 'U_EXPORT'),
    /SHIPMENT_SHIPPING_LINE_INVALID/
  );
  await assert.rejects(
    () => repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', truckingPartnerId: 'SP-SURVEY' }, 'U_EXPORT'),
    /SHIPMENT_TRUCKING_INVALID/
  );
  await assert.rejects(
    () => repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-01', etd: '09\/12\/2026' }, 'U_EXPORT'),
    /SHIPMENT_BOOKING_DATE_INVALID/
  );

  const unchanged = await repo.getPhase6Shipment(shipment.shipment_id);
  assert.equal(unchanged.status, 'PLANNING');
  assert.equal(unchanged.booking_no, null);
  assert.equal((await repo.getDeliveryInstruction('DI-CONFIRMED')).status, 'CONFIRMED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'BOOKING_RECORDED'").get().n, 0);
});

test('schedule result compares Actual Loading Date to the Customer shipping half-month', () => {
  assert.equal(calculateScheduleResult('2026-09', 'FIRST_HALF', '2026-09-15'), 'ON_PLAN');
  assert.equal(calculateScheduleResult('2026-09', 'FIRST_HALF', '2026-09-16'), 'OUT_OF_PLAN');
  assert.equal(calculateScheduleResult('2026-09', 'SECOND_HALF', '2026-09-16'), 'ON_PLAN');
  assert.equal(calculateScheduleResult('2026-02', 'SECOND_HALF', '2026-02-28'), 'ON_PLAN');
  assert.equal(calculateScheduleResult('2026-09', 'SECOND_HALF', '2026-10-01'), 'OUT_OF_PLAN');
});

test('document requirement satisfaction accepts persisted Phase 6 Shipment rows', () => {
  assert.equal(isDocumentRequirementSatisfied({
    all_ship_docs_drive_url: 'https://drive.google.com/drive/folders/digital-docs',
    digital_docs_sent_date: '2026-09-01',
    original_docs_required: 0,
    dhl_sent_date: null,
    dhl_tracking_no: null
  }), true);
  assert.equal(isDocumentRequirementSatisfied({
    all_ship_docs_drive_url: 'https://drive.google.com/drive/folders/original-docs',
    digital_docs_sent_date: '2026-09-01',
    original_docs_required: 1,
    dhl_sent_date: '2026-09-02',
    dhl_tracking_no: 'DHL-123'
  }), true);
});

test('schedule updates retain only the latest planned date and audit its old and new values', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, {
    bookingNo: 'BK-01',
    etd: '2026-10-01',
    plannedLoadingDate: '2026-09-08'
  }, 'U_EXPORT');

  const updated = await repo.updateShipmentSchedule(shipment.shipment_id, {
    plannedLoadingDate: '2026-09-14'
  }, 'U_EXPORT');

  assert.equal(updated.status, 'BOOKED');
  assert.equal(updated.planned_loading_date, '2026-09-14');
  assert.equal(updated.actual_loading_date, null);
  assert.equal(updated.schedule_result, null);
  const audit = db.prepare("SELECT event_type, metadata_json FROM shipment_audit_events WHERE event_type = 'PLANNED_LOADING_DATE_UPDATED'").get();
  assert.equal(audit.event_type, 'PLANNED_LOADING_DATE_UPDATED');
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    old: '2026-09-08',
    new: '2026-09-14'
  });
});

test('actual loading records its date, result, and audit but stays BOOKED until containers exist', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, {
    bookingNo: 'BK-01',
    etd: '2026-10-01'
  }, 'U_EXPORT');

  const updated = await repo.updateShipmentSchedule(shipment.shipment_id, {
    actualLoadingDate: '2026-09-15',
    scheduleNote: 'Loaded within the agreed period.'
  }, 'U_EXPORT');

  assert.deepEqual({
    status: updated.status,
    actualLoadingDate: updated.actual_loading_date,
    scheduleResult: updated.schedule_result,
    scheduleNote: updated.schedule_note
  }, {
    status: 'BOOKED',
    actualLoadingDate: '2026-09-15',
    scheduleResult: 'ON_PLAN',
    scheduleNote: 'Loaded within the agreed period.'
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipment_containers WHERE shipment_id = ?').get(shipment.shipment_id).n, 0);
  const audit = db.prepare("SELECT event_type, metadata_json FROM shipment_audit_events WHERE event_type = 'ACTUAL_LOADING_DATE_RECORDED'").get();
  assert.equal(audit.event_type, 'ACTUAL_LOADING_DATE_RECORDED');
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    actualLoadingDate: '2026-09-15',
    scheduleResult: 'ON_PLAN',
    scheduleNote: 'Loaded within the agreed period.'
  });
});

test('simultaneous planned-date updates reject the stale writer without a false audit', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, {
    bookingNo: 'BK-01',
    plannedLoadingDate: '2026-09-08'
  }, 'U_EXPORT');

  const results = await Promise.allSettled([
    repo.updateShipmentSchedule(shipment.shipment_id, { plannedLoadingDate: '2026-09-14' }, 'U_EXPORT'),
    repo.updateShipmentSchedule(shipment.shipment_id, { plannedLoadingDate: '2026-09-20' }, 'U_EXPORT')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /SHIPMENT_SCHEDULE_STALE/);
  const finalShipment = await repo.getPhase6Shipment(shipment.shipment_id);
  assert.ok(['2026-09-14', '2026-09-20'].includes(finalShipment.planned_loading_date));
  const plannedDateAudits = db.prepare(`
    SELECT metadata_json
    FROM shipment_audit_events
    WHERE entity_id = ? AND event_type = 'PLANNED_LOADING_DATE_UPDATED'
  `).all(shipment.shipment_id);
  assert.equal(plannedDateAudits.length, 1);
  assert.deepEqual(JSON.parse(plannedDateAudits[0].metadata_json), {
    old: '2026-09-08',
    new: finalShipment.planned_loading_date
  });
});

test('replacing actual containers records mixed-product net weight, bag counts, and promotes only a dated Shipment to LOADED', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);

  const result = await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    sealNo: 'SEAL1',
    lines: [
      { poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 },
      { poRevisionLineId: 'LINE-2', numberOfBags: 10, netWeightMt: 9.5 }
    ]
  }], 'U_EXPORT');

  assert.equal(result.actual_qty_mt, 19);
  assert.equal(result.shipment.status, 'LOADED');
  assert.equal(await repo.getShipmentActualQty(shipment.shipment_id), 19);
  assert.deepEqual(await repo.listShipmentContainers(shipment.shipment_id), [{
    container_no: 'EGSU2548896',
    seal_no: 'SEAL1',
    total_net_weight_mt: 19,
    lines: [
      { po_revision_line_id: 'LINE-1', number_of_bags: 10, net_weight_mt: 9.5 },
      { po_revision_line_id: 'LINE-2', number_of_bags: 10, net_weight_mt: 9.5 }
    ]
  }]);
  assert.equal(db.prepare("SELECT SUM(qty_mt) AS total FROM shipment_container_lines").get().total, result.actual_qty_mt);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CONTAINER_ADDED'").get().n, 1);
});

test('recording the actual date promotes an already-containerized Shipment to LOADED', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-DATE-AFTER-CONTAINER' }, 'U_EXPORT');

  const containerResult = await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'TGHU1234567',
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');
  assert.equal(containerResult.shipment.status, 'BOOKED');

  const scheduled = await repo.updateShipmentSchedule(
    shipment.shipment_id,
    { actualLoadingDate: '2026-09-15' },
    'U_EXPORT'
  );
  assert.equal(scheduled.status, 'LOADED');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'ACTUAL_LOADING_DATE_RECORDED'").get().n, 1);
});

test('container replacement validates every line before replacing actual data', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');

  await assert.rejects(
    () => repo.replaceShipmentContainers(shipment.shipment_id, [{
      containerNo: 'EGSU2548896',
      lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 10.01, grossWeightMt: 11 }]
    }], 'U_EXPORT'),
    /SHIPMENT_CONTAINER_LINE_PROPERTY_INVALID/
  );
  await assert.rejects(
    () => repo.replaceShipmentContainers(shipment.shipment_id, [{
      containerNo: 'EGSU2548896',
      lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 10.01 }]
    }], 'U_EXPORT'),
    /CONTAINER_LINE_QTY_EXCEEDS_PLANNED/
  );

  assert.equal(await repo.getShipmentActualQty(shipment.shipment_id), 9.5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CONTAINER_UPDATED'").get().n, 0);
});

test('concurrent container replacements preserve one truthful winning actual state and audit event', async () => {
  let armPause = false;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise((resolve) => {
    releaseFirstBatch = resolve;
  });
  let captureFirstBatch;
  const firstBatchCaptured = new Promise((resolve) => {
    captureFirstBatch = resolve;
  });
  const { db, wrappedDb } = await setupTestDb({
    pauseFirstBatch: () => {
      if (!armPause) return null;
      captureFirstBatch();
      return firstBatchReleased;
    }
  });
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  armPause = true;
  const replace = (containerNo) => repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo,
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');

  const first = replace('EGSU2548896');
  await firstBatchCaptured;
  const second = replace('TGHU1234567');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstBatch();
  const results = await Promise.allSettled([first, second]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /SHIPMENT_CONTAINERS_STALE/);
  const containers = await repo.listShipmentContainers(shipment.shipment_id);
  assert.equal(containers.length, 1);
  assert.ok(['EGSU2548896', 'TGHU1234567'].includes(containers[0].container_no));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CONTAINER_ADDED'").get().n, 1);
});

test('tolerance Invoice reuses its manual number and FINAL line quantities equal actual Container Net Weight', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5, max_qty_mt = 105 WHERE line_id = ?').run('LINE-1');
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');

  const preliminary = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT001/2026',
    version: 'PRELIMINARY',
    invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
  }, 'U_EXPORT');
  const final = await repo.finalizeShipmentInvoice(preliminary.invoice_id, [{
    poRevisionLineId: 'LINE-1', qtyMt: 9.5
  }], 'U_EXPORT');

  assert.deepEqual({
    invoice_no: final.invoice_no,
    version: final.version,
    invoice_date: final.invoice_date,
    currency: final.currency,
    total_amount: final.total_amount,
    lines: final.lines
  }, {
    invoice_no: 'WCAT001/2026',
    version: 'FINAL',
    invoice_date: '2026-09-15',
    currency: 'USD',
    total_amount: 3325,
    lines: [{
      po_revision_line_id: 'LINE-1',
      qty_mt: 9.5,
      unit_price_snapshot: 350,
      currency: 'USD',
      line_amount: 3325
    }]
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_invoices WHERE shipment_id = ? AND invoice_no = 'WCAT001/2026'").get(shipment.shipment_id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'INVOICE_RECORDED'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'INVOICE_FINALIZED'").get().n, 1);
  await assert.rejects(
    () => repo.replaceShipmentContainers(shipment.shipment_id, [{
      containerNo: 'EGSU2548896', lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 8.5 }]
    }], 'U_EXPORT'),
    /SHIPMENT_CONTAINERS_FINALIZED/
  );
});

test('Invoices permit independent manual numbers and aggregate FINAL quantities without duplicating actual container quantity', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [
      { poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 },
      { poRevisionLineId: 'LINE-2', numberOfBags: 10, netWeightMt: 8.5 }
    ]
  }], 'U_EXPORT');

  const first = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT001A/2026',
    version: 'FINAL',
    invoiceDate: '2026-09-15',
    lines: [
      { poRevisionLineId: 'LINE-1', qtyMt: 9.5 },
      { poRevisionLineId: 'LINE-2', qtyMt: 4 }
    ]
  }, 'U_EXPORT');
  const second = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT001B/2026', version: 'FINAL', invoiceDate: '2026-09-15', lines: [{ poRevisionLineId: 'LINE-2', qtyMt: 4.5 }]
  }, 'U_EXPORT');
  await assert.rejects(
    () => repo.createShipmentInvoice(shipment.shipment_id, {
      invoiceNo: 'WCAT001D/2026', version: 'FINAL', invoiceDate: '2026-09-15', lines: [{ poRevisionLineId: 'LINE-2', qtyMt: 0.1 }]
    }, 'U_EXPORT'),
    /INVOICE_FINAL_QTY_EXCEEDS_REMAINING_ACTUAL/
  );
  assert.equal((await repo.getShipmentInvoices(shipment.shipment_id)).length, 2);
  assert.equal(first.lines.length, 2);
  assert.equal(second.lines[0].qty_mt, 4.5);

  db.prepare('UPDATE po_revision_lines SET contract_qty_mt = 8, min_qty_mt = 8, max_qty_mt = 8, tolerance_pct = 5 WHERE line_id = ?').run('LINE-1');
  const preliminary = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT001C/2026', version: 'PRELIMINARY', invoiceDate: '2026-09-16', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 8 }]
  }, 'U_EXPORT');
  const updated = await repo.updateShipmentInvoice(preliminary.invoice_id, {
    invoiceNo: 'WCAT001C/2026',
    version: 'PRELIMINARY',
    invoiceDate: '2026-09-16',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 8 }]
  }, 'U_EXPORT');
  assert.equal(updated.invoice_date, '2026-09-16');
  await assert.rejects(
    () => repo.finalizeShipmentInvoice(preliminary.invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT'),
    /INVOICE_FINAL_QTY_EXCEEDS_PO_MAX/
  );
  await assert.rejects(
    () => repo.finalizeShipmentInvoice(preliminary.invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 8 }], 'U_EXPORT'),
    /INVOICE_FINAL_QTY_EXCEEDS_REMAINING_ACTUAL/
  );
});

test('concurrent FINAL invoice creation reserves the remaining actual quantity exactly once', async () => {
  let armPause = false;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise((resolve) => { releaseFirstBatch = resolve; });
  let captureFirstBatch;
  const firstBatchCaptured = new Promise((resolve) => { captureFirstBatch = resolve; });
  const { db, wrappedDb } = await setupTestDb({
    pauseQueuedFirstBatch: () => armPause ? (captureFirstBatch(), firstBatchReleased) : null
  });
  seedShipmentContainerLines(db);
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [{ poRevisionLineId: 'LINE-2', numberOfBags: 10, netWeightMt: 8.5 }]
  }], 'U_EXPORT');

  armPause = true;
  const first = repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-FINAL-RACE-1', version: 'FINAL', invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-2', qtyMt: 8.5 }]
  }, 'U_EXPORT');
  await firstBatchCaptured;
  const second = repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-FINAL-RACE-2', version: 'FINAL', invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-2', qtyMt: 8.5 }]
  }, 'U_EXPORT');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstBatch();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /INVOICE_FINAL_STALE/);
  assert.equal(db.prepare(`
    SELECT COALESCE(SUM(invoice_line.qty_mt), 0) AS total_qty_mt
    FROM shipment_invoice_lines invoice_line
    JOIN shipment_invoices invoice ON invoice.invoice_id = invoice_line.invoice_id
    WHERE invoice.shipment_id = ? AND invoice.version = 'FINAL' AND invoice_line.po_revision_line_id = 'LINE-2'
  `).get(shipment.shipment_id).total_qty_mt, 8.5);
});

test('concurrent preliminary finalizations reserve the remaining actual quantity exactly once', async () => {
  let armPause = false;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise((resolve) => { releaseFirstBatch = resolve; });
  let captureFirstBatch;
  const firstBatchCaptured = new Promise((resolve) => { captureFirstBatch = resolve; });
  const { db, wrappedDb } = await setupTestDb({
    pauseQueuedFirstBatch: () => armPause ? (captureFirstBatch(), firstBatchReleased) : null
  });
  seedShipmentContainerLines(db);
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5, max_qty_mt = 105 WHERE line_id = ?').run('LINE-1');
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896',
    lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');
  const preliminaryInvoices = await Promise.all(['WCAT-FINALIZE-RACE-1', 'WCAT-FINALIZE-RACE-2'].map((invoiceNo) => repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo, version: 'PRELIMINARY', invoiceDate: '2026-09-15', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
  }, 'U_EXPORT')));

  armPause = true;
  const first = repo.finalizeShipmentInvoice(preliminaryInvoices[0].invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT');
  await firstBatchCaptured;
  const second = repo.finalizeShipmentInvoice(preliminaryInvoices[1].invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstBatch();

  const results = await Promise.allSettled([first, second]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(db.prepare(`
    SELECT COALESCE(SUM(invoice_line.qty_mt), 0) AS total_qty_mt
    FROM shipment_invoice_lines invoice_line
    JOIN shipment_invoices invoice ON invoice.invoice_id = invoice_line.invoice_id
    WHERE invoice.shipment_id = ? AND invoice.version = 'FINAL' AND invoice_line.po_revision_line_id = 'LINE-1'
  `).get(shipment.shipment_id).total_qty_mt, 9.5);
});

test('Invoice Date is mandatory and unapproved invoice note and Drive URL inputs are rejected', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedShipmentContainerLines(db);
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5, max_qty_mt = 105 WHERE line_id = ?').run('LINE-1');
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await repo.createShipmentForDeliveryInstruction('DI-CONFIRMED', 'U_EXPORT');
  await repo.recordShipmentBooking(shipment.shipment_id, { bookingNo: 'BK-INVOICE-DATE' }, 'U_EXPORT');

  await assert.rejects(
    () => repo.createShipmentInvoice(shipment.shipment_id, {
      invoiceNo: 'WCAT-DATE-1', version: 'PRELIMINARY', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
    }, 'U_EXPORT'),
    /INVOICE_DATE_REQUIRED/
  );
  await assert.rejects(
    () => repo.createShipmentInvoice(shipment.shipment_id, {
      invoiceNo: 'WCAT-DATE-2', version: 'PRELIMINARY', invoiceDate: '2026-09-15', note: 'not approved', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
    }, 'U_EXPORT'),
    /INVOICE_PROPERTY_INVALID/
  );
  await assert.rejects(
    () => repo.createShipmentInvoice(shipment.shipment_id, {
      invoiceNo: 'WCAT-DATE-3', version: 'PRELIMINARY', invoiceDate: '2026-09-15', driveUrl: 'https://drive.google.com/drive/folders/x', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
    }, 'U_EXPORT'),
    /INVOICE_PROPERTY_INVALID/
  );
});

test('a stale preliminary update cannot replace FINAL lines after concurrent finalization', async () => {
  let armPause = false;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise((resolve) => { releaseFirstBatch = resolve; });
  let captureFirstBatch;
  const firstBatchCaptured = new Promise((resolve) => { captureFirstBatch = resolve; });
  const { db, wrappedDb } = await setupTestDb({
    pauseQueuedFirstBatch: () => armPause ? (captureFirstBatch(), firstBatchReleased) : null
  });
  seedShipmentContainerLines(db);
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5, max_qty_mt = 105 WHERE line_id = ?').run('LINE-1');
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896', lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');
  const preliminary = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-RACE-1', version: 'PRELIMINARY', invoiceDate: '2026-09-15', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
  }, 'U_EXPORT');

  armPause = true;
  const final = repo.finalizeShipmentInvoice(preliminary.invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT');
  await firstBatchCaptured;
  const update = repo.updateShipmentInvoice(preliminary.invoice_id, {
    invoiceNo: 'WCAT-RACE-1', version: 'PRELIMINARY', invoiceDate: '2026-09-16', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
  }, 'U_EXPORT');
  releaseFirstBatch();
  const finalized = await final;
  await assert.rejects(() => update, /INVOICE_NOT_PRELIMINARY/);

  assert.equal(finalized.version, 'FINAL');
  assert.equal((await repo.getShipmentInvoices(shipment.shipment_id))[0].lines[0].qty_mt, 9.5);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'INVOICE_FINALIZED'").get(preliminary.invoice_id).n, 1);
});

test('container replacement loses to concurrent finalization and cannot stale FINAL actual quantity', async () => {
  let armPause = false;
  let releaseFirstBatch;
  const firstBatchReleased = new Promise((resolve) => { releaseFirstBatch = resolve; });
  let captureFirstBatch;
  const firstBatchCaptured = new Promise((resolve) => { captureFirstBatch = resolve; });
  const { db, wrappedDb } = await setupTestDb({
    pauseQueuedFirstBatch: () => armPause ? (captureFirstBatch(), firstBatchReleased) : null
  });
  seedShipmentContainerLines(db);
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5, max_qty_mt = 105 WHERE line_id = ?').run('LINE-1');
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await bookedShipmentWithActualLoadingDate(repo);
  await repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896', lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }]
  }], 'U_EXPORT');
  const preliminary = await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-RACE-2', version: 'PRELIMINARY', invoiceDate: '2026-09-15', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }]
  }, 'U_EXPORT');

  armPause = true;
  const replacement = repo.replaceShipmentContainers(shipment.shipment_id, [{
    containerNo: 'EGSU2548896', lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 8.5 }]
  }], 'U_EXPORT');
  await firstBatchCaptured;
  const final = repo.finalizeShipmentInvoice(preliminary.invoice_id, [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT');
  await new Promise((resolve) => setImmediate(resolve));
  releaseFirstBatch();
  await replacement;
  await assert.rejects(() => final, /INVOICE_NOT_PRELIMINARY/);
  assert.equal(await repo.getShipmentActualQty(shipment.shipment_id), 8.5);
});

test('digital document delivery stores one shipment folder and marks a digital-only Shipment DOCS_SENT', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);

  const updated = await repo.updateShipmentDocuments(shipment.shipment_id, {
    allShipDocsDriveUrl: 'https://drive.google.com/drive/folders/all-ship-docs',
    digitalDocsSentDate: '2026-09-01',
    originalDocsRequired: false,
    docsNote: 'Email sent to Customer'
  }, 'U_EXPORT');

  assert.equal(updated.status, 'DOCS_SENT');
  assert.equal(updated.all_ship_docs_drive_url, 'https://drive.google.com/drive/folders/all-ship-docs');
  assert.equal(updated.digital_docs_sent_date, '2026-09-01');
  assert.equal(updated.original_docs_required, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'DOCS_EMAIL_SENT'").get(shipment.shipment_id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipment_document_links').get().n, 0);
});

test('DHL-required Shipment cannot become DOCS_SENT without date and tracking number', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);

  await assert.rejects(
    () => repo.updateShipmentDocuments(shipment.shipment_id, {
      allShipDocsDriveUrl: 'https://drive.google.com/folder/1',
      digitalDocsSentDate: '2026-09-01',
      originalDocsRequired: true
    }, 'U_EXPORT'),
    /DHL_DETAILS_REQUIRED/
  );
});

test('All Ship Docs accepts only Google Drive folder URLs', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);
  const base = { digitalDocsSentDate: '2026-09-01', originalDocsRequired: false };

  await assert.rejects(
    () => repo.updateShipmentDocuments(shipment.shipment_id, {
      ...base,
      allShipDocsDriveUrl: 'https://drive.google.com/file/d/file-id/view'
    }, 'U_EXPORT'),
    /ALL_SHIP_DOCS_DRIVE_URL_INVALID/
  );
  await assert.rejects(
    () => repo.updateShipmentDocuments(shipment.shipment_id, {
      ...base,
      allShipDocsDriveUrl: 'https://docs.google.com/document/d/document-id/edit'
    }, 'U_EXPORT'),
    /ALL_SHIP_DOCS_DRIVE_URL_INVALID/
  );
});

test('digital-only document delivery rejects DHL fields', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);

  await assert.rejects(
    () => repo.updateShipmentDocuments(shipment.shipment_id, {
      allShipDocsDriveUrl: 'https://drive.google.com/drive/folders/all-ship-docs',
      digitalDocsSentDate: '2026-09-01',
      originalDocsRequired: false,
      dhlSentDate: '2026-09-02',
      dhlTrackingNo: 'DHL-123'
    }, 'U_EXPORT'),
    /DHL_DETAILS_NOT_ALLOWED/
  );
});

test('DHL-required document delivery audits both email and DHL without individual document records', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);

  const updated = await repo.updateShipmentDocuments(shipment.shipment_id, {
    allShipDocsDriveUrl: 'https://drive.google.com/drive/folders/all-ship-docs',
    digitalDocsSentDate: '2026-09-01',
    originalDocsRequired: true,
    dhlSentDate: '2026-09-02',
    dhlTrackingNo: 'DHL-123',
    docsNote: 'Originals dispatched'
  }, 'U_EXPORT');

  assert.equal(updated.status, 'DOCS_SENT');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'DOCS_EMAIL_SENT'").get(shipment.shipment_id).n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'DOCS_DHL_SENT'").get(shipment.shipment_id).n, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM shipment_document_links').get().n, 0);
});

test('credit cannot cross Customers or exceed remaining balance', async () => {
  const { db, wrappedDb } = await setupTestDb();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C2', 'CUST2', 'Customer Two')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO2', 'C2', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV2', 'PO2', 0, 'ACTIVE', 'HOUSE_ACCOUNT', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-12-31', 'U_EXPORT')").run();
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by) VALUES ('DI-C2', 'C2', 'PO2', 'REV2', 'C2-1', '2026-09', 'FIRST_HALF', 'CONFIRMED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, created_by, updated_by) VALUES ('S_FOR_C2', 'DI-C2', 'U_EXPORT', 'U_EXPORT')").run();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentWithFinalInvoice(repo, db);
  seedSecondFinalPaymentShipment(db);

  const credit = await repo.createCustomerCredit({ customerId: 'C1', amount: 100, reason: 'Commercial adjustment', requestKey: 'cross-credit-create' }, 'U_EXPORT');
  await assert.rejects(
    () => repo.useCustomerCredit('S_FOR_C2', { creditId: credit.credit_id, amount: 1, requestKey: 'cross-customer-use' }, 'U_EXPORT'),
    /CREDIT_CUSTOMER_MISMATCH/
  );
  await assert.rejects(
    () => repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 101, requestKey: 'cross-over-credit' }, 'U_EXPORT'),
    /CREDIT_BALANCE_EXCEEDED/
  );
  await assert.rejects(
    () => repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 1, invoiceId: 'INV-PAY-2', requestKey: 'cross-invoice-use' }, 'U_EXPORT'),
    /CREDIT_INVOICE_SHIPMENT_MISMATCH/
  );

  const updated = await repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 40, requestKey: 'cross-first-use' }, 'U_EXPORT');
  assert.equal(updated.payment_status, 'PARTIAL');
  await repo.useCustomerCredit('S_FOR_C1_2', { creditId: credit.credit_id, amount: 60, invoiceId: 'INV-PAY-2', requestKey: 'cross-second-use' }, 'U_EXPORT');
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'CUSTOMER_CREDIT_USED'").get(credit.credit_id).n, 2);
});

test('concurrent credit usage cannot overdraw one Customer credit', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentWithFinalInvoice(repo, db);
  const credit = await repo.createCustomerCredit({ customerId: 'C1', amount: 100, reason: 'Commercial adjustment', requestKey: 'race-credit-create' }, 'U_EXPORT');

  const results = await Promise.allSettled([
    repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 60, requestKey: 'race-credit-use-1' }, 'U_EXPORT'),
    repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 60, requestKey: 'race-credit-use-2' }, 'U_EXPORT')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(String(results.find((result) => result.status === 'rejected').reason), /CREDIT_BALANCE_EXCEEDED/);
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 40);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credit_usages').get().n, 1);
});

test('payment uses only FINAL invoice totals and reports unpaid, partial, and paid coverage', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);

  const beforeFinal = await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 1, paymentNote: 'Advance' }, 'U_EXPORT');
  assert.equal(beforeFinal.payment_status, 'UNPAID');
  db.prepare('UPDATE po_revision_lines SET tolerance_pct = 5 WHERE line_id = ?').run('LINE-1');
  await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-PRELIM-PAY',
    version: 'PRELIMINARY',
    invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 100 }]
  }, 'U_EXPORT');
  await repo.finalizeShipmentInvoice((await repo.getShipmentInvoices(shipment.shipment_id))[0].invoice_id, [{
    poRevisionLineId: 'LINE-1', qtyMt: 9.5
  }], 'U_EXPORT');
  assert.equal((await repo.getPhase6Shipment(shipment.shipment_id)).payment_status, 'PARTIAL');
  const partial = await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 1000, paymentNote: 'Partial collection' }, 'U_EXPORT');
  assert.equal(partial.payment_status, 'PARTIAL');
  const paid = await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 3325, paymentNote: 'Settled' }, 'U_EXPORT');
  assert.equal(paid.payment_status, 'PAID');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'PAYMENT_UPDATED'").get(shipment.shipment_id).n, 3);
});

test('payment rounds monetary coverage to currency precision', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);
  db.prepare('UPDATE po_revision_lines SET unit_price = ? WHERE line_id = ?').run(0.1, 'LINE-1');
  await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-MONEY-ROUND', version: 'FINAL', invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 3 }]
  }, 'U_EXPORT');
  const rounded = await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 0.3 }, 'U_EXPORT');
  assert.equal(rounded.payment_status, 'PAID');
});

test('credit and cash values reject fractions below the supported currency precision', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentWithFinalInvoice(repo, db);
  await assert.rejects(
    () => repo.createCustomerCredit({ customerId: 'C1', amount: 0.001, reason: 'Precision', requestKey: 'precision-create' }, 'U_EXPORT'),
    /CREDIT_AMOUNT_INVALID/
  );
  const credit = await repo.createCustomerCredit({ customerId: 'C1', amount: 1, reason: 'Precision', requestKey: 'precision-credit' }, 'U_EXPORT');
  await assert.rejects(
    () => repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 0.001, requestKey: 'precision-use' }, 'U_EXPORT'),
    /CREDIT_USAGE_AMOUNT_INVALID/
  );
  await assert.rejects(
    () => repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 0.001 }, 'U_EXPORT'),
    /PAYMENT_CASH_RECEIVED_AMOUNT_INVALID/
  );
});

test('a zero FINAL total is paid without cash or credit', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);
  db.prepare('UPDATE po_revision_lines SET unit_price = ? WHERE line_id = ?').run(0, 'LINE-1');
  await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-MONEY-ZERO', version: 'FINAL', invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 1 }]
  }, 'U_EXPORT');
  assert.equal((await repo.getPhase6Shipment(shipment.shipment_id)).payment_status, 'PAID');
});

test('credit create and usage request keys are idempotent without duplicate balances or audits', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentWithFinalInvoice(repo, db);
  const payload = { customerId: 'C1', amount: 100, reason: 'Commercial adjustment', requestKey: 'credit-create-1' };

  const created = await repo.createCustomerCredit(payload, 'U_EXPORT');
  const createdAgain = await repo.createCustomerCredit(payload, 'U_EXPORT');
  assert.equal(createdAgain.credit_id, created.credit_id);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credits').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CUSTOMER_CREDIT_CREATED'").get().n, 1);

  const used = await repo.useCustomerCredit(shipment.shipment_id, { creditId: created.credit_id, amount: 40, requestKey: 'credit-use-1' }, 'U_EXPORT');
  const usedAgain = await repo.useCustomerCredit(shipment.shipment_id, { creditId: created.credit_id, amount: 40, requestKey: 'credit-use-1' }, 'U_EXPORT');
  assert.equal(usedAgain.shipment_id, used.shipment_id);
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 60);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credit_usages').get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CUSTOMER_CREDIT_USED'").get().n, 1);

  await repo.useCustomerCredit(shipment.shipment_id, { creditId: created.credit_id, amount: 20, requestKey: 'credit-use-2' }, 'U_EXPORT');
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 40);

  const concurrentCreates = await Promise.all([
    repo.createCustomerCredit({ customerId: 'C1', amount: 100, reason: 'Concurrent adjustment', requestKey: 'credit-create-race' }, 'U_EXPORT'),
    repo.createCustomerCredit({ customerId: 'C1', amount: 100, reason: 'Concurrent adjustment', requestKey: 'credit-create-race' }, 'U_EXPORT')
  ]);
  assert.equal(concurrentCreates[0].credit_id, concurrentCreates[1].credit_id);
  const concurrentUses = await Promise.all([
    repo.useCustomerCredit(shipment.shipment_id, { creditId: concurrentCreates[0].credit_id, amount: 40, requestKey: 'credit-use-race' }, 'U_EXPORT'),
    repo.useCustomerCredit(shipment.shipment_id, { creditId: concurrentCreates[0].credit_id, amount: 40, requestKey: 'credit-use-race' }, 'U_EXPORT')
  ]);
  assert.equal(concurrentUses[0].shipment_id, concurrentUses[1].shipment_id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CUSTOMER_CREDIT_CREATED'").get().n, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE event_type = 'CUSTOMER_CREDIT_USED'").get().n, 3);
});

test('credit allocation cannot exceed a Shipment FINAL obligation, including concurrent requests', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentWithFinalInvoice(repo, db);
  const credit = await repo.createCustomerCredit({ customerId: 'C1', amount: 200, reason: 'Commercial adjustment', requestKey: 'credit-limit-create' }, 'U_EXPORT');
  await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 3225 }, 'U_EXPORT');

  await assert.rejects(
    () => repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 101, requestKey: 'credit-limit-too-much' }, 'U_EXPORT'),
    /CREDIT_SHIPMENT_BALANCE_EXCEEDED/
  );
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credit_usages').get().n, 0);

  const results = await Promise.allSettled([
    repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 60, requestKey: 'credit-limit-race-1' }, 'U_EXPORT'),
    repo.useCustomerCredit(shipment.shipment_id, { creditId: credit.credit_id, amount: 60, requestKey: 'credit-limit-race-2' }, 'U_EXPORT')
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.match(String(results.find((result) => result.status === 'rejected').reason), /CREDIT_SHIPMENT_BALANCE_EXCEEDED/);
  assert.equal((await repo.listCustomerCredits({ customerId: 'C1' }))[0].remaining_amount, 140);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customer_credit_usages').get().n, 1);
});

test('FINAL invoice materializes payment recorded before FINAL invoice creation', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const shipment = await loadedShipmentForDocuments(repo, db);
  await repo.updateShipmentPayment(shipment.shipment_id, { cashReceivedAmount: 3324 }, 'U_EXPORT');
  db.prepare("INSERT INTO customer_credits (credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by) VALUES ('CR-LEGACY', 'C1', 1, 'Prior credit', 0, 'legacy-credit-create', 'U_EXPORT')").run();
  db.prepare("INSERT INTO customer_credit_usages (credit_usage_id, credit_id, shipment_id, amount, request_key, actor_id) VALUES ('CRU-LEGACY', 'CR-LEGACY', ?, 1, 'legacy-credit-use', 'U_EXPORT')").run(shipment.shipment_id);

  await repo.createShipmentInvoice(shipment.shipment_id, {
    invoiceNo: 'WCAT-FINAL-PREPAID', version: 'FINAL', invoiceDate: '2026-09-15',
    lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }]
  }, 'U_EXPORT');
  assert.equal((await repo.getPhase6Shipment(shipment.shipment_id)).payment_status, 'PAID');
});
