import {
  codedError,
  validatePartnerCreate,
  validatePartnerUpdate,
  validateRateCreate,
  validateRateUpdate
} from './validation.js';

const PARTNER_COLUMNS = `
  partner_id, partner_type, partner_name,
  contact_name, contact_phone, contact_email,
  address, tax_id, status, note,
  created_by, created_at, updated_by, updated_at
`;

const RATE_COLUMNS = `
  rate_id, partner_id, service_type, route_scope,
  container_size, unit, price, currency,
  effective_date, valid_until, status, note,
  created_by, created_at, updated_by, updated_at
`;

const LIVE_USAGE_CTE = `
  usage_rows AS (
    SELECT di.surveyor_partner_id AS partner_id, di.di_id, 'SURVEYOR' AS partner_role
    FROM delivery_instructions di
    LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
    WHERE di.surveyor_partner_id IS NOT NULL
      AND di.status <> 'CANCELLED'
      AND (s.shipment_id IS NULL OR s.status <> 'CANCELLED')
    UNION
    SELECT di.forwarder_partner_id AS partner_id, di.di_id, 'FORWARDER' AS partner_role
    FROM delivery_instructions di
    LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
    WHERE di.forwarder_partner_id IS NOT NULL
      AND di.status <> 'CANCELLED'
      AND (s.shipment_id IS NULL OR s.status <> 'CANCELLED')
    UNION
    SELECT s.forwarder_partner_id AS partner_id, di.di_id, 'FORWARDER' AS partner_role
    FROM phase6_shipments s
    JOIN delivery_instructions di ON di.di_id = s.di_id
    WHERE s.forwarder_partner_id IS NOT NULL
      AND di.status <> 'CANCELLED'
      AND s.status <> 'CANCELLED'
    UNION
    SELECT s.shipping_line_partner_id AS partner_id, di.di_id, 'SHIPPING_LINE' AS partner_role
    FROM phase6_shipments s
    JOIN delivery_instructions di ON di.di_id = s.di_id
    WHERE s.shipping_line_partner_id IS NOT NULL
      AND di.status <> 'CANCELLED'
      AND s.status <> 'CANCELLED'
    UNION
    SELECT s.trucking_partner_id AS partner_id, di.di_id, 'TRUCKING' AS partner_role
    FROM phase6_shipments s
    JOIN delivery_instructions di ON di.di_id = s.di_id
    WHERE s.trucking_partner_id IS NOT NULL
      AND di.status <> 'CANCELLED'
      AND s.status <> 'CANCELLED'
  )
`;

async function nextPartnerId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(partner_id, 4) AS INTEGER)), 0) AS max_id
    FROM service_partners
    WHERE partner_id GLOB 'SP-[0-9]*'
  `).first();
  return `SP-${String(Number(row?.max_id || 0) + 1).padStart(3, '0')}`;
}

async function nextRateId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(rate_id, 5) AS INTEGER)), 0) AS max_id
    FROM service_partner_rates
    WHERE rate_id GLOB 'SPR-[0-9]*'
  `).first();
  return `SPR-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

async function findPartner(db, partnerId) {
  return db.prepare(`
    SELECT ${PARTNER_COLUMNS}
    FROM service_partners
    WHERE partner_id = ?
  `).bind(partnerId).first();
}

async function findRate(db, partnerId, rateId) {
  return db.prepare(`
    SELECT ${RATE_COLUMNS}
    FROM service_partner_rates
    WHERE partner_id = ? AND rate_id = ?
  `).bind(partnerId, rateId).first();
}

export function createLogisticsPartnersRepository(db) {
  return {
    async listPartners(filters = {}) {
      let query = `
        WITH ${LIVE_USAGE_CTE},
        usage_counts AS (
          SELECT partner_id, COUNT(*) AS usage_count
          FROM usage_rows
          GROUP BY partner_id
        ),
        rate_counts AS (
          SELECT partner_id, COUNT(*) AS active_rate_count
          FROM service_partner_rates
          WHERE status = 'ACTIVE'
          GROUP BY partner_id
        )
        SELECT sp.partner_id, sp.partner_type, sp.partner_name,
               sp.contact_name, sp.contact_phone, sp.contact_email,
               sp.address, sp.tax_id, sp.status, sp.note,
               sp.created_by, sp.created_at, sp.updated_by, sp.updated_at,
               COALESCE(rc.active_rate_count, 0) AS active_rate_count,
               COALESCE(uc.usage_count, 0) AS usage_count
        FROM service_partners sp
        LEFT JOIN rate_counts rc ON rc.partner_id = sp.partner_id
        LEFT JOIN usage_counts uc ON uc.partner_id = sp.partner_id
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.partnerType) {
        query += ' AND sp.partner_type = ?';
        params.push(filters.partnerType);
      }
      if (filters.status) {
        query += ' AND sp.status = ?';
        params.push(filters.status);
      }
      if (filters.search) {
        const pattern = `%${filters.search.toLowerCase()}%`;
        query += ` AND (
          LOWER(sp.partner_name) LIKE ?
          OR LOWER(sp.partner_id) LIKE ?
          OR LOWER(COALESCE(sp.contact_name, '')) LIKE ?
        )`;
        params.push(pattern, pattern, pattern);
      }
      query += ' ORDER BY sp.partner_name COLLATE NOCASE ASC, sp.partner_id ASC';
      const { results } = await db.prepare(query).bind(...params).all();
      return results || [];
    },

    async getPartnerDetail(partnerId) {
      const partner = await findPartner(db, partnerId);
      if (!partner) return null;

      const { results: rates } = await db.prepare(`
        SELECT ${RATE_COLUMNS}
        FROM service_partner_rates
        WHERE partner_id = ?
        ORDER BY effective_date DESC, created_at DESC, rate_id DESC
      `).bind(partnerId).all();

      const { results: usage } = await db.prepare(`
        WITH ${LIVE_USAGE_CTE}
        SELECT di.di_id,
               s.shipment_id,
               di.di_no,
               c.customer_name,
               s.booking_no,
               s.vessel,
               di.container_plan,
               COALESCE(s.actual_loading_date, s.planned_loading_date, s.etd, substr(di.created_at, 1, 10)) AS usage_date,
               u.partner_role,
               di.status AS di_status,
               s.status AS shipment_status,
               COALESCE((
                 SELECT COUNT(*)
                 FROM shipment_containers sc
                 WHERE sc.shipment_id = s.shipment_id
                   AND sc.status <> 'CANCELLED'
               ), 0) AS actual_container_count
        FROM usage_rows u
        JOIN delivery_instructions di ON di.di_id = u.di_id
        JOIN customers c ON c.customer_id = di.customer_id
        LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
        WHERE u.partner_id = ?
        ORDER BY usage_date DESC, di.di_no DESC
      `).bind(partnerId).all();

      return {
        partner,
        rates: rates || [],
        usage: usage || []
      };
    },

    async createPartner(dto, actorId) {
      const partner = validatePartnerCreate(dto);
      const partnerId = await nextPartnerId(db);
      await db.prepare(`
        INSERT INTO service_partners (
          partner_id, partner_type, partner_name,
          contact_name, contact_phone, contact_email,
          address, tax_id, status, note,
          created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        partnerId,
        partner.partnerType,
        partner.partnerName,
        partner.contactName,
        partner.contactPhone,
        partner.contactEmail,
        partner.address,
        partner.taxId,
        partner.status,
        partner.note,
        actorId,
        actorId
      ).run();
      return findPartner(db, partnerId);
    },

    async updatePartner(partnerId, dto, actorId) {
      const existing = await findPartner(db, partnerId);
      if (!existing) throw codedError('SERVICE_PARTNER_NOT_FOUND');
      const partner = validatePartnerUpdate(dto, existing);
      await db.prepare(`
        UPDATE service_partners
        SET partner_name = ?,
            status = ?,
            contact_name = ?,
            contact_phone = ?,
            contact_email = ?,
            address = ?,
            tax_id = ?,
            note = ?,
            updated_by = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = ?
      `).bind(
        partner.partnerName,
        partner.status,
        partner.contactName,
        partner.contactPhone,
        partner.contactEmail,
        partner.address,
        partner.taxId,
        partner.note,
        actorId,
        partnerId
      ).run();
      return findPartner(db, partnerId);
    },

    async createRate(partnerId, dto, actorId) {
      const partner = await findPartner(db, partnerId);
      if (!partner) throw codedError('SERVICE_PARTNER_NOT_FOUND');
      const rate = validateRateCreate(dto);
      const rateId = await nextRateId(db);
      await db.prepare(`
        INSERT INTO service_partner_rates (
          rate_id, partner_id, service_type, route_scope,
          container_size, unit, price, currency,
          effective_date, valid_until, status, note,
          created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        rateId,
        partnerId,
        rate.serviceType,
        rate.routeScope,
        rate.containerSize,
        rate.unit,
        rate.price,
        rate.currency,
        rate.effectiveDate,
        rate.validUntil,
        rate.status,
        rate.note,
        actorId,
        actorId
      ).run();
      return findRate(db, partnerId, rateId);
    },

    async updateRate(partnerId, rateId, dto, actorId) {
      const partner = await findPartner(db, partnerId);
      if (!partner) throw codedError('SERVICE_PARTNER_NOT_FOUND');
      const existing = await findRate(db, partnerId, rateId);
      if (!existing) throw codedError('PARTNER_RATE_NOT_FOUND');
      const rate = validateRateUpdate(dto, existing);
      await db.prepare(`
        UPDATE service_partner_rates
        SET service_type = ?,
            route_scope = ?,
            container_size = ?,
            unit = ?,
            price = ?,
            currency = ?,
            effective_date = ?,
            valid_until = ?,
            status = ?,
            note = ?,
            updated_by = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = ? AND rate_id = ?
      `).bind(
        rate.serviceType,
        rate.routeScope,
        rate.containerSize,
        rate.unit,
        rate.price,
        rate.currency,
        rate.effectiveDate,
        rate.validUntil,
        rate.status,
        rate.note,
        actorId,
        partnerId,
        rateId
      ).run();
      return findRate(db, partnerId, rateId);
    }
  };
}
