import crypto from 'node:crypto';
import {
  codedError,
  validateDeliveryInstruction,
  validateDeliveryInstructionAvailabilityLines,
  validateDeliveryInstructionUpdate,
  validateCancellationNote,
  validateServicePartner
} from './validation.js';

async function nextId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(partner_id, 4) AS INTEGER)), 0) AS max_id
    FROM service_partners
    WHERE partner_id GLOB 'SP-[0-9]*'
  `).first();
  return `SP-${String(Number(row?.max_id || 0) + 1).padStart(3, '0')}`;
}

async function findServicePartner(db, partnerId) {
  return db.prepare(`
    SELECT partner_id, partner_name, partner_type, status, created_by, created_at, updated_by, updated_at
    FROM service_partners
    WHERE partner_id = ?
  `).bind(partnerId).first();
}

async function nextInternalDiNo(db, poId) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(di_no, LENGTH(?) + 2) AS INTEGER)), 0) AS n
    FROM delivery_instructions
    WHERE po_id = ? AND di_no GLOB ?
  `).bind(poId, poId, `${poId}_[0-9]*`).first();
  return `${poId}_${String(Number(row?.n || 0) + 1).padStart(3, '0')}`;
}

function isInternalDiNoUniqueCollision(error) {
  return String(error?.message || '').includes(
    'UNIQUE constraint failed: delivery_instructions.customer_id, delivery_instructions.di_no'
  );
}

function isAvailabilityReservationFailure(error) {
  return String(error?.message || '').includes('CHECK constraint failed: planned_qty_mt > 0');
}

async function findDeliveryInstruction(db, diId) {
  const deliveryInstruction = await db.prepare(`
    SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
           status, note, cancellation_note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
           created_by, created_at, updated_by, updated_at
    FROM delivery_instructions
    WHERE di_id = ?
  `).bind(diId).first();
  if (!deliveryInstruction) return null;

  const { results: lines } = await db.prepare(`
    SELECT dil.di_line_id, dil.di_id, dil.po_id, dil.po_revision_id, dil.po_revision_line_id,
           dil.product_id, dil.planned_qty_mt, dil.packing_snapshot, dil.created_by,
           dil.created_at, dil.updated_by, dil.updated_at
    FROM delivery_instruction_lines dil
    JOIN po_revision_lines prl ON prl.line_id = dil.po_revision_line_id
    WHERE dil.di_id = ?
    ORDER BY prl.line_no ASC
  `).bind(diId).all();
  return { ...deliveryInstruction, lines: lines || [] };
}

async function validateSelectedPartner(db, partnerId, partnerType, code) {
  if (!partnerId) return;
  const partner = await db.prepare(`
    SELECT partner_type
    FROM service_partners
    WHERE partner_id = ?
  `).bind(partnerId).first();
  if (!partner || partner.partner_type !== partnerType) throw codedError(code);
}

function deliveryInstructionSnapshot(deliveryInstruction) {
  const value = (camelCase, snakeCase) => Object.hasOwn(deliveryInstruction, camelCase)
    ? deliveryInstruction[camelCase]
    : deliveryInstruction[snakeCase];
  return {
    customerId: value('customerId', 'customer_id'),
    poId: value('poId', 'po_id'),
    poRevisionId: value('poRevisionId', 'po_revision_id'),
    diNo: value('diNo', 'di_no'),
    shippingMonth: value('shippingMonth', 'shipping_month'),
    shippingPeriod: value('shippingPeriod', 'shipping_period'),
    note: deliveryInstruction.note,
    googleDriveUrl: value('googleDriveUrl', 'di_drive_url'),
    surveyorPartnerId: value('surveyorPartnerId', 'surveyor_partner_id'),
    forwarderPartnerId: value('forwarderPartnerId', 'forwarder_partner_id'),
    lines: (deliveryInstruction.lines || []).map((line) => ({
      poRevisionLineId: line.poRevisionLineId ?? line.po_revision_line_id,
      plannedQtyMt: line.plannedQtyMt ?? line.planned_qty_mt,
      packingSnapshot: line.packingSnapshot ?? line.packing_snapshot
    }))
  };
}

function auditStatement(db, entityType, entityId, eventType, actorId, metadata = {}) {
  return db.prepare(`
    INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(`EVT-${crypto.randomUUID()}`, entityType, entityId, eventType, actorId, JSON.stringify(metadata));
}

function auditAfterMutationStatement(db, entityType, entityId, eventType, actorId, metadata = {}) {
  return db.prepare(`
    INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE changes() = 1
  `).bind(`EVT-${crypto.randomUUID()}`, entityType, entityId, eventType, actorId, JSON.stringify(metadata));
}

function mutationApplied(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}

function deliveryInstructionUpdateDto(existing, dto) {
  const patch = validateDeliveryInstructionUpdate(dto);
  const existingDto = {
    customerId: existing.customer_id,
    poId: existing.po_id,
    poRevisionId: existing.po_revision_id,
    diNo: existing.di_no,
    shippingMonth: existing.shipping_month,
    shippingPeriod: existing.shipping_period,
    note: existing.note,
    googleDriveUrl: existing.di_drive_url,
    surveyorPartnerId: existing.surveyor_partner_id,
    forwarderPartnerId: existing.forwarder_partner_id,
    lines: existing.lines.map((line) => ({
      poId: line.po_id,
      poRevisionId: line.po_revision_id,
      poRevisionLineId: line.po_revision_line_id,
      plannedQtyMt: line.planned_qty_mt,
      packingSnapshot: line.packing_snapshot
    }))
  };
  return validateDeliveryInstruction({ ...existingDto, ...patch });
}

async function validateDeliveryInstructionReferences(db, deliveryInstruction) {
  const header = await db.prepare(`
    SELECT customer_id
    FROM po_headers
    WHERE po_id = ?
  `).bind(deliveryInstruction.poId).first();
  if (!header || header.customer_id !== deliveryInstruction.customerId) throw codedError('DI_PO_LINEAGE_INVALID');

  const revision = await db.prepare(`
    SELECT revision_id
    FROM po_revisions
    WHERE revision_id = ? AND po_id = ?
  `).bind(deliveryInstruction.poRevisionId, deliveryInstruction.poId).first();
  if (!revision) throw codedError('DI_PO_REVISION_LINEAGE_INVALID');

  const seenLineIds = new Set();
  for (const line of deliveryInstruction.lines) {
    if (
      line.poId !== deliveryInstruction.poId ||
      line.poRevisionId !== deliveryInstruction.poRevisionId ||
      seenLineIds.has(line.poRevisionLineId)
    ) throw codedError('DI_LINE_PO_LINEAGE_INVALID');
    seenLineIds.add(line.poRevisionLineId);

    const exactLine = await db.prepare(`
      SELECT l.product_id
      FROM po_headers h
      JOIN po_revisions r ON r.po_id = h.po_id
      JOIN po_revision_lines l ON l.po_revision_id = r.revision_id
      WHERE h.po_id = ? AND h.customer_id = ? AND r.revision_id = ? AND l.line_id = ?
    `).bind(
      deliveryInstruction.poId,
      deliveryInstruction.customerId,
      deliveryInstruction.poRevisionId,
      line.poRevisionLineId
    ).first();
    if (!exactLine) throw codedError('DI_LINE_PO_LINEAGE_INVALID');
    line.productId = exactLine.product_id;
  }
}

function deliveryInstructionLineReservationStatement(db, diId, deliveryInstruction, line, actorId) {
  return db.prepare(`
    WITH requested_line (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
      planned_qty_mt, packing_snapshot, created_by, updated_by
    ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
    INSERT INTO delivery_instruction_lines (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
      planned_qty_mt, packing_snapshot, created_by, updated_by
    )
    SELECT requested.di_line_id, requested.di_id, requested.po_id, requested.po_revision_id,
           requested.po_revision_line_id, requested.product_id,
           CASE
             WHEN requested.planned_qty_mt <= COALESCE((
               SELECT line.max_qty_mt
                 - COALESCE((
                   SELECT SUM(container_line.qty_mt)
                   FROM delivery_instruction_lines actual_di_line
                   JOIN shipment_container_lines container_line
                     ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                   JOIN shipment_containers container
                     ON container.container_id = container_line.container_id
                   JOIN phase6_shipments shipment
                     ON shipment.shipment_id = container.shipment_id
                   WHERE actual_di_line.po_revision_line_id = requested.po_revision_line_id
                     AND shipment.status <> 'CANCELLED'
                     AND container.status <> 'CANCELLED'
                 ), 0)
                 - COALESCE((
                   SELECT SUM(planned_di_line.planned_qty_mt)
                   FROM delivery_instruction_lines planned_di_line
                   JOIN delivery_instructions planned_di
                     ON planned_di.di_id = planned_di_line.di_id
                   WHERE planned_di_line.po_revision_line_id = requested.po_revision_line_id
                     AND planned_di.status <> 'CANCELLED'
                     AND NOT EXISTS (
                       SELECT 1
                       FROM delivery_instruction_lines actual_di_line
                       JOIN shipment_container_lines container_line
                         ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                       JOIN shipment_containers container
                         ON container.container_id = container_line.container_id
                       JOIN phase6_shipments shipment
                         ON shipment.shipment_id = container.shipment_id
                       WHERE actual_di_line.di_id = planned_di.di_id
                         AND shipment.status <> 'CANCELLED'
                         AND container.status <> 'CANCELLED'
                     )
                 ), 0)
               FROM po_revision_lines line
               WHERE line.line_id = requested.po_revision_line_id
             ), -1) + 0.000001
             THEN requested.planned_qty_mt
             ELSE -1
           END,
           requested.packing_snapshot, requested.created_by, requested.updated_by
    FROM requested_line requested
    WHERE EXISTS (
      SELECT 1
      FROM delivery_instructions current_di
      WHERE current_di.di_id = requested.di_id AND current_di.status = 'DRAFT'
    )
  `).bind(
    `DIL-${crypto.randomUUID()}`,
    diId,
    deliveryInstruction.poId,
    deliveryInstruction.poRevisionId,
    line.poRevisionLineId,
    line.productId,
    line.plannedQtyMt,
    line.packingSnapshot,
    actorId,
    actorId
  );
}

export function createShippingDiRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listServicePartners(filters = {}) {
      let query = `
        SELECT partner_id, partner_name, partner_type, status, created_by, created_at, updated_by, updated_at
        FROM service_partners
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }
      if (filters.partnerType) {
        query += ' AND partner_type = ?';
        params.push(filters.partnerType);
      }
      query += ' ORDER BY partner_name COLLATE NOCASE ASC';
      const { results } = await db.prepare(query).bind(...params).all();
      return results || [];
    },

    async createServicePartner(dto, actorId) {
      const partner = validateServicePartner(dto);
      const partnerId = await nextId(db);
      await db.prepare(`
        INSERT INTO service_partners (partner_id, partner_type, partner_name, status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(partnerId, partner.partnerType, partner.companyName, partner.status, actorId, actorId).run();
      return findServicePartner(db, partnerId);
    },

    async updateServicePartner(partnerId, dto, actorId) {
      if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
      if (Object.keys(dto).length === 0) throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
      const existing = await findServicePartner(db, partnerId);
      if (!existing) throw codedError('SERVICE_PARTNER_NOT_FOUND');
      const partner = validateServicePartner({
        companyName: dto.companyName === undefined ? existing.partner_name : dto.companyName,
        partnerType: dto.partnerType === undefined ? existing.partner_type : dto.partnerType,
        status: dto.status === undefined ? existing.status : dto.status,
        ...dto
      });
      await db.prepare(`
        UPDATE service_partners
        SET partner_name = ?, partner_type = ?, status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = ?
      `).bind(partner.companyName, partner.partnerType, partner.status, actorId, partnerId).run();
      return findServicePartner(db, partnerId);
    },

    async createDeliveryInstruction(dto, actorId) {
      const deliveryInstruction = validateDeliveryInstruction(dto);
      await validateDeliveryInstructionReferences(db, deliveryInstruction);

      await this.assertDeliveryInstructionAvailability(deliveryInstruction.lines);

      await validateSelectedPartner(db, deliveryInstruction.surveyorPartnerId, 'SURVEYOR', 'DI_SURVEYOR_INVALID');
      await validateSelectedPartner(db, deliveryInstruction.forwarderPartnerId, 'FORWARDER', 'DI_FORWARDER_INVALID');

      const maxInternalNumberAttempts = 3;
      const hasCustomerDiNo = deliveryInstruction.diNo !== null;
      for (let attempt = 0; attempt < (hasCustomerDiNo ? 1 : maxInternalNumberAttempts); attempt += 1) {
        const diId = `DI-${crypto.randomUUID()}`;
        const diNo = hasCustomerDiNo
          ? deliveryInstruction.diNo
          : await nextInternalDiNo(db, deliveryInstruction.poId);
        const statements = [db.prepare(`
          INSERT INTO delivery_instructions (
            di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
            status, note, di_drive_url, surveyor_partner_id, forwarder_partner_id, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
        `).bind(
          diId,
          deliveryInstruction.customerId,
          deliveryInstruction.poId,
          deliveryInstruction.poRevisionId,
          diNo,
          deliveryInstruction.shippingMonth,
          deliveryInstruction.shippingPeriod,
          deliveryInstruction.note,
          deliveryInstruction.googleDriveUrl,
          deliveryInstruction.surveyorPartnerId,
          deliveryInstruction.forwarderPartnerId,
          actorId,
          actorId
        )];

        statements.push(auditStatement(db, 'DI', diId, 'DI_CREATED', actorId, {
          new: { ...deliveryInstructionSnapshot(deliveryInstruction), status: 'DRAFT', diNo }
        }));

        for (const line of deliveryInstruction.lines) {
          statements.push(db.prepare(`
            WITH requested_line (
              di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
              planned_qty_mt, packing_snapshot, created_by, updated_by
            ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
            INSERT INTO delivery_instruction_lines (
              di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
              planned_qty_mt, packing_snapshot, created_by, updated_by
            )
            SELECT requested.di_line_id, requested.di_id, requested.po_id, requested.po_revision_id,
                   requested.po_revision_line_id, requested.product_id,
                   CASE
                     WHEN requested.planned_qty_mt <= COALESCE((
                       SELECT line.max_qty_mt
                         - COALESCE((
                           SELECT SUM(container_line.qty_mt)
                           FROM delivery_instruction_lines actual_di_line
                           JOIN shipment_container_lines container_line
                             ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                           JOIN shipment_containers container
                             ON container.container_id = container_line.container_id
                           JOIN phase6_shipments shipment
                             ON shipment.shipment_id = container.shipment_id
                           WHERE actual_di_line.po_revision_line_id = requested.po_revision_line_id
                             AND shipment.status <> 'CANCELLED'
                             AND container.status <> 'CANCELLED'
                         ), 0)
                         - COALESCE((
                           SELECT SUM(planned_di_line.planned_qty_mt)
                           FROM delivery_instruction_lines planned_di_line
                           JOIN delivery_instructions planned_di
                             ON planned_di.di_id = planned_di_line.di_id
                           WHERE planned_di_line.po_revision_line_id = requested.po_revision_line_id
                             AND planned_di.status <> 'CANCELLED'
                             AND NOT EXISTS (
                               SELECT 1
                               FROM delivery_instruction_lines actual_di_line
                               JOIN shipment_container_lines container_line
                                 ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                               JOIN shipment_containers container
                                 ON container.container_id = container_line.container_id
                               JOIN phase6_shipments shipment
                                 ON shipment.shipment_id = container.shipment_id
                               WHERE actual_di_line.di_id = planned_di.di_id
                                 AND shipment.status <> 'CANCELLED'
                                 AND container.status <> 'CANCELLED'
                             )
                         ), 0)
                       FROM po_revision_lines line
                       WHERE line.line_id = requested.po_revision_line_id
                     ), -1) + 0.000001
                     THEN requested.planned_qty_mt
                     ELSE -1
                   END,
                   requested.packing_snapshot, requested.created_by, requested.updated_by
            FROM requested_line requested
          `).bind(
            `DIL-${crypto.randomUUID()}`,
            diId,
            deliveryInstruction.poId,
            deliveryInstruction.poRevisionId,
            line.poRevisionLineId,
            line.productId,
            line.plannedQtyMt,
            line.packingSnapshot,
            actorId,
            actorId
          ));
        }

        try {
          await db.batch(statements);
          return findDeliveryInstruction(db, diId);
        } catch (error) {
          if (isAvailabilityReservationFailure(error)) {
            throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
          }
          if (!hasCustomerDiNo && attempt + 1 < maxInternalNumberAttempts && isInternalDiNoUniqueCollision(error)) {
            continue;
          }
          throw error;
        }
      }
    },

    async updateDraftDeliveryInstruction(diId, dto, actorId) {
      const existing = await findDeliveryInstruction(db, diId);
      if (!existing) throw codedError('DI_NOT_FOUND');
      if (existing.status !== 'DRAFT') throw codedError('DI_NOT_DRAFT');

      const deliveryInstruction = deliveryInstructionUpdateDto(existing, dto);
      await validateDeliveryInstructionReferences(db, deliveryInstruction);
      await this.assertDeliveryInstructionAvailability(deliveryInstruction.lines, diId);
      await validateSelectedPartner(db, deliveryInstruction.surveyorPartnerId, 'SURVEYOR', 'DI_SURVEYOR_INVALID');
      await validateSelectedPartner(db, deliveryInstruction.forwarderPartnerId, 'FORWARDER', 'DI_FORWARDER_INVALID');

      const statements = [
        db.prepare(`
          UPDATE delivery_instructions
          SET customer_id = ?, po_id = ?, po_revision_id = ?, di_no = ?, shipping_month = ?, shipping_period = ?,
              note = ?, di_drive_url = ?, surveyor_partner_id = ?, forwarder_partner_id = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'DRAFT'
        `).bind(
          deliveryInstruction.customerId,
          deliveryInstruction.poId,
          deliveryInstruction.poRevisionId,
          deliveryInstruction.diNo,
          deliveryInstruction.shippingMonth,
          deliveryInstruction.shippingPeriod,
          deliveryInstruction.note,
          deliveryInstruction.googleDriveUrl,
          deliveryInstruction.surveyorPartnerId,
          deliveryInstruction.forwarderPartnerId,
          actorId,
          diId
        ),
        auditAfterMutationStatement(db, 'DI', diId, 'DI_UPDATED', actorId, {
          old: deliveryInstructionSnapshot(existing),
          new: deliveryInstructionSnapshot(deliveryInstruction)
        }),
        db.prepare(`
          DELETE FROM delivery_instruction_lines
          WHERE di_id = ?
            AND EXISTS (
              SELECT 1 FROM delivery_instructions WHERE di_id = ? AND status = 'DRAFT'
            )
        `).bind(diId, diId)
      ];
      for (const line of deliveryInstruction.lines) {
        statements.push(deliveryInstructionLineReservationStatement(db, diId, deliveryInstruction, line, actorId));
      }
      try {
        const results = await db.batch(statements);
        if (!mutationApplied(results[0])) throw codedError('DI_NOT_DRAFT');
      } catch (error) {
        if (isAvailabilityReservationFailure(error)) throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
        throw error;
      }
      return findDeliveryInstruction(db, diId);
    },

    async confirmDeliveryInstruction(diId, actorId) {
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'DRAFT') throw codedError('DI_NOT_DRAFT');

      const results = await db.batch([
        db.prepare(`
          UPDATE delivery_instructions
          SET status = 'CONFIRMED', updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'DRAFT'
        `).bind(actorId, diId),
        auditAfterMutationStatement(db, 'DI', diId, 'DI_CONFIRMED', actorId, {
          oldStatus: deliveryInstruction.status,
          newStatus: 'CONFIRMED'
        })
      ]);
      if (!mutationApplied(results[0])) throw codedError('DI_NOT_DRAFT');
      return findDeliveryInstruction(db, diId);
    },

    async cancelDeliveryInstruction(diId, note, actorId) {
      const cancellationNote = validateCancellationNote(note);
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'CONFIRMED') throw codedError('DI_NOT_CONFIRMED');

      const results = await db.batch([
        db.prepare(`
          UPDATE delivery_instructions
          SET status = 'CANCELLED', cancellation_note = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'CONFIRMED'
        `).bind(cancellationNote, actorId, diId),
        auditAfterMutationStatement(db, 'DI', diId, 'DI_CANCELLED', actorId, {
          oldStatus: deliveryInstruction.status,
          newStatus: 'CANCELLED',
          cancellationNote
        })
      ]);
      if (!mutationApplied(results[0])) throw codedError('DI_NOT_CONFIRMED');
      return findDeliveryInstruction(db, diId);
    },

    async deleteDraftDeliveryInstruction(diId) {
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'DRAFT') throw codedError('DI_HARD_DELETE_FORBIDDEN');
      const result = await db.prepare(`
        DELETE FROM delivery_instructions
        WHERE di_id = ? AND status = 'DRAFT'
      `).bind(diId).run();
      if (!mutationApplied(result)) {
        const current = await findDeliveryInstruction(db, diId);
        if (!current) throw codedError('DI_NOT_FOUND');
        throw codedError('DI_HARD_DELETE_FORBIDDEN');
      }
    },

    async getShippingDiHistory(diId) {
      const { results } = await db.prepare(`
        SELECT event_id, entity_type, entity_id, event_type, actor_id, metadata_json, created_at
        FROM shipment_audit_events
        WHERE entity_type = 'DI' AND entity_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).bind(diId).all();
      return results || [];
    },

    async getDeliveryInstruction(diId) {
      return findDeliveryInstruction(db, diId);
    },

    async listDeliveryInstructions(filters = {}) {
      let query = `
        SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
               status, note, cancellation_note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
               created_by, created_at, updated_by, updated_at
        FROM delivery_instructions
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.customerId) {
        query += ' AND customer_id = ?';
        params.push(filters.customerId);
      }
      if (filters.poId) {
        query += ' AND po_id = ?';
        params.push(filters.poId);
      }
      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }
      query += ' ORDER BY created_at DESC, di_id DESC';
      const { results } = await db.prepare(query).bind(...params).all();
      return results || [];
    },

    async suggestPartnersForCustomer(customerId) {
      const latest = await db.prepare(`
        SELECT surveyor_partner_id, forwarder_partner_id
        FROM delivery_instructions
        WHERE customer_id = ? AND status <> 'CANCELLED'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).bind(customerId).first();
      return {
        surveyor_partner_id: latest?.surveyor_partner_id || null,
        forwarder_partner_id: latest?.forwarder_partner_id || null
      };
    },

    async getPoLineBalances(poId) {
      const { results } = await db.prepare(`
        WITH actual_by_line AS (
          SELECT dil.po_revision_line_id, SUM(scl.qty_mt) AS actual_qty_mt
          FROM delivery_instruction_lines dil
          JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = dil.di_line_id
          JOIN shipment_containers sc ON sc.container_id = scl.container_id
          JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
          WHERE s.status <> 'CANCELLED' AND sc.status <> 'CANCELLED'
          GROUP BY dil.po_revision_line_id
        ),
        unrepresented_planned_by_line AS (
          SELECT dil.po_revision_line_id, SUM(dil.planned_qty_mt) AS unrepresented_planned_qty_mt
          FROM delivery_instruction_lines dil
          JOIN delivery_instructions di ON di.di_id = dil.di_id
          WHERE di.po_id = ?
            AND di.status <> 'CANCELLED'
            AND NOT EXISTS (
              SELECT 1
              FROM delivery_instruction_lines actual_dil
              JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = actual_dil.di_line_id
              JOIN shipment_containers sc ON sc.container_id = scl.container_id
              JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
              WHERE actual_dil.di_id = di.di_id
                AND s.status <> 'CANCELLED'
                AND sc.status <> 'CANCELLED'
            )
          GROUP BY dil.po_revision_line_id
        )
        SELECT l.line_id AS po_revision_line_id, l.po_revision_id, l.line_no, l.product_id,
               l.contract_qty_mt, l.max_qty_mt,
               COALESCE(a.actual_qty_mt, 0) AS actual_qty_mt,
               COALESCE(p.unrepresented_planned_qty_mt, 0) AS unrepresented_planned_qty_mt,
               l.max_qty_mt - COALESCE(a.actual_qty_mt, 0) - COALESCE(p.unrepresented_planned_qty_mt, 0) AS available_qty_mt
        FROM po_revision_lines l
        JOIN po_revisions r ON r.revision_id = l.po_revision_id
        LEFT JOIN actual_by_line a ON a.po_revision_line_id = l.line_id
        LEFT JOIN unrepresented_planned_by_line p ON p.po_revision_line_id = l.line_id
        WHERE r.po_id = ?
        ORDER BY l.line_no ASC
      `).bind(poId, poId).all();
      return results || [];
    },

    async assertDeliveryInstructionAvailability(lines, excludedDiId = null) {
      const requestedLines = validateDeliveryInstructionAvailabilityLines(lines);
      const balancesByPoId = new Map();
      const priorAllocationByLineId = new Map();

      if (excludedDiId) {
        const { results } = await db.prepare(`
          SELECT dil.po_revision_line_id, SUM(dil.planned_qty_mt) AS planned_qty_mt
          FROM delivery_instruction_lines dil
          JOIN delivery_instructions di ON di.di_id = dil.di_id
          WHERE dil.di_id = ?
            AND di.status <> 'CANCELLED'
            AND NOT EXISTS (
              SELECT 1
              FROM delivery_instruction_lines actual_dil
              JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = actual_dil.di_line_id
              JOIN shipment_containers sc ON sc.container_id = scl.container_id
              JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
              WHERE actual_dil.di_id = dil.di_id
                AND s.status <> 'CANCELLED'
                AND sc.status <> 'CANCELLED'
            )
          GROUP BY dil.po_revision_line_id
        `).bind(excludedDiId).all();
        for (const allocation of results || []) {
          priorAllocationByLineId.set(allocation.po_revision_line_id, allocation.planned_qty_mt);
        }
      }

      for (const line of requestedLines) {
        if (!balancesByPoId.has(line.poId)) {
          balancesByPoId.set(line.poId, await this.getPoLineBalances(line.poId));
        }
        const balance = balancesByPoId.get(line.poId)
          .find((candidate) => candidate.po_revision_line_id === line.poRevisionLineId);
        if (!balance || balance.po_revision_id !== line.poRevisionId) throw codedError('DI_LINE_PO_LINEAGE_INVALID');

        const priorAllocation = Number(priorAllocationByLineId.get(line.poRevisionLineId) || 0);
        if (line.plannedQtyMt > balance.available_qty_mt + priorAllocation + 0.000001) {
          throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
        }
      }
    }
  };
}
