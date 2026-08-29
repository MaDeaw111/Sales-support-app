import crypto from 'node:crypto';
import { codedError, validateDeliveryInstruction, validateServicePartner } from './validation.js';

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

async function findDeliveryInstruction(db, diId) {
  const deliveryInstruction = await db.prepare(`
    SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
           status, note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
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
      const header = await db.prepare(`
        SELECT customer_id
        FROM po_headers
        WHERE po_id = ?
      `).bind(deliveryInstruction.poId).first();
      if (!header || header.customer_id !== deliveryInstruction.customerId) {
        throw codedError('DI_PO_LINEAGE_INVALID');
      }

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
        ) {
          throw codedError('DI_LINE_PO_LINEAGE_INVALID');
        }
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

        for (const line of deliveryInstruction.lines) {
          statements.push(db.prepare(`
            INSERT INTO delivery_instruction_lines (
              di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
              planned_qty_mt, packing_snapshot, created_by, updated_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          if (!hasCustomerDiNo && attempt + 1 < maxInternalNumberAttempts && isInternalDiNoUniqueCollision(error)) {
            continue;
          }
          throw error;
        }
      }
    },

    async getDeliveryInstruction(diId) {
      return findDeliveryInstruction(db, diId);
    },

    async listDeliveryInstructions(filters = {}) {
      let query = `
        SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
               status, note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
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
    }
  };
}
