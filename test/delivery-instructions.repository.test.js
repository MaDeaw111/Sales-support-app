import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';

async function setupTestDb({ collisionDiNo = null, failLineId = null } = {}) {
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
  db.prepare("INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_SALES', 'sales@example.com', 'hash', 'salt', 'EXTERNAL_SALES', 'ACTIVE', 'Sales User')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer One', 'U_SALES')").run();
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C2', 'CUST2', 'Customer Two', 'U_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FORM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FORM1')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO-2026-015', 'C1', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO-2026-016', 'C2', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV-1', 'PO-2026-015', 0, 'ACTIVE', 'ASSIGNED_SALES', 'U_SALES', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-12-31', 'U_EXPORT')").run();
  db.prepare("INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV-2', 'PO-2026-016', 0, 'ACTIVE', 'ASSIGNED_SALES', 'U_SALES', 'USD', 'FOB', '2026-09-01', '2026-09-30', '2026-12-31', 'U_EXPORT')").run();
  for (const [lineId, revisionId, lineNo] of [['LINE-10', 'REV-1', 10], ['LINE-20', 'REV-1', 20], ['LINE-30', 'REV-2', 10]]) {
    db.prepare('INSERT INTO po_revision_lines (line_id, po_revision_id, line_no, product_id, spec_source, spec_revision_id, contract_qty_mt, tolerance_pct, min_qty_mt, max_qty_mt, unit_price, packaging, container_type, loading_pattern) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(lineId, revisionId, lineNo, 'P1', 'STANDARD', 'SPEC-1', 100, 0, 100, 100, 300, 'Jumbo Bag', '20GP', 'PALLETIZED');
  }

  let collisionTriggered = false;
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
          if (
            !collisionTriggered &&
            collisionDiNo &&
            sql.includes('INSERT INTO delivery_instructions') &&
            this.params[4] === collisionDiNo
          ) {
            collisionTriggered = true;
            throw new Error('UNIQUE constraint failed: delivery_instructions.customer_id, delivery_instructions.di_no');
          }
          if (failLineId && sql.includes('INSERT INTO delivery_instruction_lines') && this.params[4] === failLineId) {
            throw new Error('SIMULATED_DI_LINE_WRITE_FAILURE');
          }
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

function diPayload(overrides = {}) {
  return {
    customerId: 'C1',
    poId: 'PO-2026-015',
    poRevisionId: 'REV-1',
    diNo: null,
    shippingMonth: '2026-09',
    shippingPeriod: 'FIRST_HALF',
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }],
    ...overrides
  };
}

test('internal DI number increments only within its PO and every line is an exact Phase 5F line', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  const first = await repo.createDeliveryInstruction(diPayload(), 'U_EXPORT');
  const second = await repo.createDeliveryInstruction(diPayload({
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
  }), 'U_EXPORT');

  assert.equal(first.di_no, 'PO-2026-015_001');
  assert.equal(second.di_no, 'PO-2026-015_002');
  assert.deepEqual(first.lines.map((line) => ({
    po_id: line.po_id,
    po_revision_id: line.po_revision_id,
    po_revision_line_id: line.po_revision_line_id,
    planned_qty_mt: line.planned_qty_mt,
    packing_snapshot: line.packing_snapshot
  })), [{
    po_id: 'PO-2026-015',
    po_revision_id: 'REV-1',
    po_revision_line_id: 'LINE-10',
    planned_qty_mt: 25,
    packing_snapshot: 'Jumbo Bag'
  }]);
});

test('DI creation rejects a line from another PO revision and an invalid optional Drive URL', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  await assert.rejects(
    () => repo.createDeliveryInstruction(diPayload({
      lines: [{ poId: 'PO-2026-016', poRevisionId: 'REV-2', poRevisionLineId: 'LINE-30', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
    }), 'U_EXPORT'),
    /DI_LINE_PO_LINEAGE_INVALID/
  );
  await assert.rejects(
    () => repo.createDeliveryInstruction(diPayload({ googleDriveUrl: 'https://example.com/not-drive' }), 'U_EXPORT'),
    /DI_GOOGLE_DRIVE_URL_INVALID/
  );
});

test('supplied customer DI number is retained exactly and DI reads can be filtered by customer', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  const created = await repo.createDeliveryInstruction(diPayload({ diNo: 'CUSTOMER-DI- 07 ' }), 'U_EXPORT');

  assert.equal(created.di_no, 'CUSTOMER-DI- 07 ');
  assert.deepEqual((await repo.listDeliveryInstructions({ customerId: 'C1' })).map((di) => di.di_id), [created.di_id]);
  assert.equal((await repo.getDeliveryInstruction(created.di_id)).di_no, 'CUSTOMER-DI- 07 ');
});

test('combined DI keeps each exact PO line and offers latest non-cancelled partner selections as suggestions', async () => {
  const { db, wrappedDb } = await setupTestDb();
  db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES ('SP-SURVEYOR', 'SURVEYOR', 'SGS', 'U_EXPORT')").run();
  db.prepare("INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES ('SP-FORWARDER', 'FORWARDER', 'Kuehne + Nagel', 'U_EXPORT')").run();
  const repo = createShippingDiRepository(wrappedDb);

  const created = await repo.createDeliveryInstruction(diPayload({
    googleDriveUrl: 'https://drive.google.com/file/d/DI-1/view',
    surveyorPartnerId: 'SP-SURVEYOR',
    forwarderPartnerId: 'SP-FORWARDER',
    lines: [
      { poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 10, packingSnapshot: 'Jumbo Bag' },
      { poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 15, packingSnapshot: 'Jumbo Bag' }
    ]
  }), 'U_EXPORT');

  assert.equal(created.di_drive_url, 'https://drive.google.com/file/d/DI-1/view');
  assert.deepEqual(created.lines.map((line) => line.po_revision_line_id), ['LINE-10', 'LINE-20']);
  assert.deepEqual(await repo.suggestPartnersForCustomer('C1'), {
    surveyor_partner_id: 'SP-SURVEYOR',
    forwarder_partner_id: 'SP-FORWARDER'
  });
});

test('rolls back the DI header and every line when a later combined-line write fails', async () => {
  const { db, wrappedDb } = await setupTestDb({ failLineId: 'LINE-20' });
  const repo = createShippingDiRepository(wrappedDb);

  await assert.rejects(
    () => repo.createDeliveryInstruction(diPayload({
      lines: [
        { poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 10, packingSnapshot: 'Jumbo Bag' },
        { poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 15, packingSnapshot: 'Jumbo Bag' }
      ]
    }), 'U_EXPORT'),
    /SIMULATED_DI_LINE_WRITE_FAILURE/
  );

  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_instructions').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_instruction_lines').get().n, 0);
});

test('retries a PO-local automatic DI number after an exact unique allocation collision', async () => {
  const { wrappedDb } = await setupTestDb({ collisionDiNo: 'PO-2026-015_002' });
  const repo = createShippingDiRepository(wrappedDb);

  await repo.createDeliveryInstruction(diPayload(), 'U_EXPORT');
  const retried = await repo.createDeliveryInstruction(diPayload({
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
  }), 'U_EXPORT');

  assert.equal(retried.di_no, 'PO-2026-015_002');
});

test('partner suggestions use insertion chronology when historical DIs share a timestamp', async () => {
  const { db, wrappedDb } = await setupTestDb();
  for (const [partnerId, partnerType] of [
    ['SP-SURVEYOR-OLD', 'SURVEYOR'], ['SP-FORWARDER-OLD', 'FORWARDER'],
    ['SP-SURVEYOR-NEW', 'SURVEYOR'], ['SP-FORWARDER-NEW', 'FORWARDER']
  ]) {
    db.prepare('INSERT INTO service_partners (partner_id, partner_type, partner_name, created_by) VALUES (?, ?, ?, ?)')
      .run(partnerId, partnerType, partnerId, 'U_EXPORT');
  }
  for (const [diId, diNo, surveyorId, forwarderId] of [
    ['DI-Z', 'HISTORY-OLD', 'SP-SURVEYOR-OLD', 'SP-FORWARDER-OLD'],
    ['DI-A', 'HISTORY-NEW', 'SP-SURVEYOR-NEW', 'SP-FORWARDER-NEW']
  ]) {
    db.prepare(`
      INSERT INTO delivery_instructions (
        di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
        status, surveyor_partner_id, forwarder_partner_id, created_by, created_at
      ) VALUES (?, 'C1', 'PO-2026-015', 'REV-1', ?, '2026-09', 'FIRST_HALF', 'DRAFT', ?, ?, 'U_EXPORT', '2026-09-01 00:00:00')
    `).run(diId, diNo, surveyorId, forwarderId);
  }

  const repo = createShippingDiRepository(wrappedDb);
  assert.deepEqual(await repo.suggestPartnersForCustomer('C1'), {
    surveyor_partner_id: 'SP-SURVEYOR-NEW',
    forwarder_partner_id: 'SP-FORWARDER-NEW'
  });
});

test('PO line balance subtracts planned only until that DI has actual container quantity', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by
    ) VALUES ('DI-1', 'C1', 'PO-2026-015', 'REV-1', 'BALANCE-1', '2026-09', 'FIRST_HALF', 'DRAFT', 'U_EXPORT')
  `).run();
  db.prepare(`
    INSERT INTO delivery_instruction_lines (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by
    ) VALUES ('DIL-1', 'DI-1', 'PO-2026-015', 'REV-1', 'LINE-10', 'P1', 10, 'Jumbo Bag', 'U_EXPORT')
  `).run();
  db.prepare("INSERT INTO phase6_shipments (shipment_id, di_id, status, created_by) VALUES ('SHIP-1', 'DI-1', 'LOADED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by) VALUES ('CONT-1', 'SHIP-1', 'TGHU1234567', '20GP', 'LOADED', 'U_EXPORT')").run();
  db.prepare("INSERT INTO shipment_container_lines (container_line_id, container_id, delivery_instruction_line_id, qty_mt, created_by) VALUES ('CL-1', 'CONT-1', 'DIL-1', 8, 'U_EXPORT')").run();

  const [balance] = await repo.getPoLineBalances('PO-2026-015');

  assert.equal(balance.available_qty_mt, 92); // 100 max - 8 actual; not 100 - 10 - 8
});

test('DI creation rejects planned quantity above the exact PO line maximum', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  await repo.createDeliveryInstruction(diPayload({
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 75, packingSnapshot: 'Jumbo Bag' }]
  }), 'U_EXPORT');

  await assert.rejects(
    () => repo.createDeliveryInstruction(diPayload({
      lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 26, packingSnapshot: 'Jumbo Bag' }]
    }), 'U_EXPORT'),
    /DI_QTY_EXCEEDS_MAX_ALLOWED/
  );
});

test('concurrent DI creates reserve the exact PO line quantity only once', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const attempt = (diNo) => repo.createDeliveryInstruction(diPayload({
    diNo,
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 75, packingSnapshot: 'Jumbo Bag' }]
  }), 'U_EXPORT');

  const results = await Promise.allSettled([attempt('RACE-1'), attempt('RACE-2')]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /DI_QTY_EXCEEDS_MAX_ALLOWED/);
  assert.equal(db.prepare("SELECT SUM(planned_qty_mt) AS total FROM delivery_instruction_lines WHERE po_revision_line_id = 'LINE-10'").get().total, 75);
});

test('cancelled DI planned quantity is released from the PO line balance', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by
    ) VALUES ('DI-CANCELLED', 'C1', 'PO-2026-015', 'REV-1', 'CANCELLED-1', '2026-09', 'FIRST_HALF', 'CANCELLED', 'U_EXPORT')
  `).run();
  db.prepare(`
    INSERT INTO delivery_instruction_lines (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by
    ) VALUES ('DIL-CANCELLED', 'DI-CANCELLED', 'PO-2026-015', 'REV-1', 'LINE-10', 'P1', 100, 'Jumbo Bag', 'U_EXPORT')
  `).run();

  const [balance] = await repo.getPoLineBalances('PO-2026-015');

  assert.equal(balance.unrepresented_planned_qty_mt, 0);
  assert.equal(balance.available_qty_mt, 100);
});

test('availability assertion permits a DRAFT line to retain its own allocation only', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);

  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, status, created_by
    ) VALUES ('DI-DRAFT', 'C1', 'PO-2026-015', 'REV-1', 'DRAFT-1', '2026-09', 'FIRST_HALF', 'DRAFT', 'U_EXPORT')
  `).run();
  db.prepare(`
    INSERT INTO delivery_instruction_lines (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id, planned_qty_mt, packing_snapshot, created_by
    ) VALUES ('DIL-DRAFT', 'DI-DRAFT', 'PO-2026-015', 'REV-1', 'LINE-10', 'P1', 100, 'Jumbo Bag', 'U_EXPORT')
  `).run();

  const line = {
    poId: 'PO-2026-015',
    poRevisionId: 'REV-1',
    poRevisionLineId: 'LINE-10',
    plannedQtyMt: 100,
    packingSnapshot: 'Jumbo Bag'
  };
  await assert.doesNotReject(() => repo.assertDeliveryInstructionAvailability([line], 'DI-DRAFT'));
  await assert.rejects(
    () => repo.assertDeliveryInstructionAvailability([{ ...line, plannedQtyMt: 100.01 }], 'DI-DRAFT'),
    /DI_QTY_EXCEEDS_MAX_ALLOWED/
  );
});

test('DI lifecycle only permits DRAFT editing, confirmation, and never-confirmed DRAFT deletion', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const created = await repo.createDeliveryInstruction(diPayload({ note: 'Initial instruction' }), 'U_EXPORT');

  const updated = await repo.updateDraftDeliveryInstruction(created.di_id, { note: 'Updated instruction' }, 'U_EXPORT');
  assert.equal(updated.note, 'Updated instruction');
  const updatedEvent = (await repo.getShippingDiHistory(created.di_id)).at(-1);
  assert.equal(updatedEvent.event_type, 'DI_UPDATED');
  assert.deepEqual(JSON.parse(updatedEvent.metadata_json), {
    old: {
      customerId: 'C1',
      poId: 'PO-2026-015',
      poRevisionId: 'REV-1',
      diNo: created.di_no,
      shippingMonth: '2026-09',
      shippingPeriod: 'FIRST_HALF',
      note: 'Initial instruction',
      googleDriveUrl: null,
      surveyorPartnerId: null,
      forwarderPartnerId: null,
      lines: [{ poRevisionLineId: 'LINE-10', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
    },
    new: {
      customerId: 'C1',
      poId: 'PO-2026-015',
      poRevisionId: 'REV-1',
      diNo: created.di_no,
      shippingMonth: '2026-09',
      shippingPeriod: 'FIRST_HALF',
      note: 'Updated instruction',
      googleDriveUrl: null,
      surveyorPartnerId: null,
      forwarderPartnerId: null,
      lines: [{ poRevisionLineId: 'LINE-10', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
    }
  });

  const confirmed = await repo.confirmDeliveryInstruction(created.di_id, 'U_EXPORT');
  assert.equal(confirmed.status, 'CONFIRMED');
  await assert.rejects(
    () => repo.updateDraftDeliveryInstruction(created.di_id, { note: 'No longer editable' }, 'U_EXPORT'),
    /DI_NOT_DRAFT/
  );
  await assert.rejects(
    () => repo.deleteDraftDeliveryInstruction(created.di_id),
    /DI_HARD_DELETE_FORBIDDEN/
  );

  const draft = await repo.createDeliveryInstruction(diPayload({
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 25, packingSnapshot: 'Jumbo Bag' }]
  }), 'U_EXPORT');
  await repo.deleteDraftDeliveryInstruction(draft.di_id);
  assert.equal(await repo.getDeliveryInstruction(draft.di_id), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM delivery_instruction_lines WHERE di_id = ?').get(draft.di_id).n, 0);
});

test('cancelling a DI requires a note, releases planned availability, and records DI audit history', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const created = await repo.createDeliveryInstruction(diPayload(), 'U_EXPORT');

  await assert.rejects(() => repo.cancelDeliveryInstruction(created.di_id, '', 'U_EXPORT'), /CANCEL_NOTE_REQUIRED/);
  await assert.rejects(() => repo.cancelDeliveryInstruction(created.di_id, 'Customer changed schedule', 'U_EXPORT'), /DI_NOT_CONFIRMED/);
  for (const status of ['IN_PROGRESS', 'COMPLETED']) {
    const nonCancellable = await repo.createDeliveryInstruction(diPayload({
      diNo: `CANCEL-${status}`,
      lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-20', plannedQtyMt: 1, packingSnapshot: 'Jumbo Bag' }]
    }), 'U_EXPORT');
    db.prepare('UPDATE delivery_instructions SET status = ? WHERE di_id = ?').run(status, nonCancellable.di_id);
    await assert.rejects(() => repo.cancelDeliveryInstruction(nonCancellable.di_id, 'No approved cancellation rule', 'U_EXPORT'), /DI_NOT_CONFIRMED/);
  }
  await repo.confirmDeliveryInstruction(created.di_id, 'U_EXPORT');
  const cancelled = await repo.cancelDeliveryInstruction(created.di_id, 'Customer changed schedule', 'U_EXPORT');

  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.cancellation_note, 'Customer changed schedule');
  const [balance] = await repo.getPoLineBalances('PO-2026-015');
  assert.equal(balance.available_qty_mt, 100);
  const history = await repo.getShippingDiHistory(created.di_id);
  assert.deepEqual(history.map((event) => event.event_type), ['DI_CREATED', 'DI_CONFIRMED', 'DI_CANCELLED']);
  assert.ok(history.every((event) => event.entity_type === 'DI' && event.entity_id === created.di_id && event.actor_id === 'U_EXPORT' && event.created_at));
  assert.equal(JSON.parse(history.at(-1).metadata_json).cancellationNote, 'Customer changed schedule');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_type = 'DI' AND entity_id = ?").get(created.di_id).n, 3);
});

test('PATCH and confirmation conflicts apply only one DRAFT transition and audit event', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const created = await repo.createDeliveryInstruction(diPayload({ note: 'Before confirmation' }), 'U_EXPORT');

  const results = await Promise.allSettled([
    repo.updateDraftDeliveryInstruction(created.di_id, { note: 'Must not apply after confirmation' }, 'U_EXPORT'),
    repo.confirmDeliveryInstruction(created.di_id, 'U_EXPORT')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /DI_NOT_DRAFT/);
  assert.equal((await repo.getDeliveryInstruction(created.di_id)).status, 'CONFIRMED');
  assert.equal((await repo.getDeliveryInstruction(created.di_id)).note, 'Before confirmation');
  assert.deepEqual((await repo.getShippingDiHistory(created.di_id)).map((event) => event.event_type), ['DI_CREATED', 'DI_CONFIRMED']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM shipment_audit_events WHERE entity_id = ? AND event_type = 'DI_UPDATED'").get(created.di_id).n, 0);
});

test('DELETE and confirmation conflicts preserve exactly one winning DRAFT transition', async () => {
  const { wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const created = await repo.createDeliveryInstruction(diPayload(), 'U_EXPORT');

  const results = await Promise.allSettled([
    repo.deleteDraftDeliveryInstruction(created.di_id),
    repo.confirmDeliveryInstruction(created.di_id, 'U_EXPORT')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  const deliveryInstruction = await repo.getDeliveryInstruction(created.di_id);
  const history = await repo.getShippingDiHistory(created.di_id);
  if (deliveryInstruction) {
    assert.equal(deliveryInstruction.status, 'CONFIRMED');
    assert.deepEqual(history.map((event) => event.event_type), ['DI_CREATED', 'DI_CONFIRMED']);
  } else {
    assert.deepEqual(history.map((event) => event.event_type), ['DI_CREATED']);
  }
});

test('concurrent DRAFT DI edits reserve the revised quantity only once', async () => {
  const { db, wrappedDb } = await setupTestDb();
  const repo = createShippingDiRepository(wrappedDb);
  const first = await repo.createDeliveryInstruction(diPayload({ diNo: 'EDIT-RACE-1' }), 'U_EXPORT');
  const second = await repo.createDeliveryInstruction(diPayload({ diNo: 'EDIT-RACE-2' }), 'U_EXPORT');
  const patch = {
    lines: [{ poId: 'PO-2026-015', poRevisionId: 'REV-1', poRevisionLineId: 'LINE-10', plannedQtyMt: 75, packingSnapshot: 'Jumbo Bag' }]
  };

  const results = await Promise.allSettled([
    repo.updateDraftDeliveryInstruction(first.di_id, patch, 'U_EXPORT'),
    repo.updateDraftDeliveryInstruction(second.di_id, patch, 'U_EXPORT')
  ]);

  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.match(results.find((result) => result.status === 'rejected').reason.message, /DI_QTY_EXCEEDS_MAX_ALLOWED/);
  assert.equal(db.prepare("SELECT SUM(planned_qty_mt) AS total FROM delivery_instruction_lines WHERE po_revision_line_id = 'LINE-10'").get().total, 100);
});
