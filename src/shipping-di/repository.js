import { codedError, validateServicePartner } from './validation.js';

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
    }
  };
}
