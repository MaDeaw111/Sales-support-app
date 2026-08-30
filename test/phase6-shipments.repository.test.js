import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';
import { calculateScheduleResult } from '../src/shipping-di/validation.js';

async function setupTestDb() {
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
      const previousBatch = releasePreviousBatch;
      let releaseBatch;
      releasePreviousBatch = new Promise((resolve) => {
        releaseBatch = resolve;
      });
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
