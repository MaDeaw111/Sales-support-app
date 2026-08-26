async function nextId(db, table, column, prefix) {
  const globPattern = `${prefix}-[0-9]*`;
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(${column}, ${prefix.length + 2}) AS INTEGER)), 0) AS max_id
    FROM ${table}
    WHERE ${column} GLOB '${globPattern}'
  `).first();
  return `${prefix}-${String(Number(row?.max_id || 0) + 1).padStart(3, '0')}`;
}

function wrapUniqueError(err, msg) {
  if (err.message && err.message.includes('UNIQUE constraint failed')) {
    const error = new Error(msg);
    error.code = 'UNIQUE';
    throw error;
  }
  throw err;
}

export function createShipmentRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listExpenseCategories() {
      const { results } = await db.prepare(`
        SELECT category_id, category_code, category_name, category_group, status, sort_order
        FROM expense_categories
        ORDER BY sort_order ASC, category_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(r => ({
        id: r.category_id,
        category_code: r.category_code,
        category_name: r.category_name,
        category_group: r.category_group,
        status: r.status,
        sort_order: r.sort_order
      }));
    },

    async createExpenseCategory(dto) {
      if (!dto.code || !dto.name || !dto.categoryGroup) {
        throw new Error('Expense category code, name, and group are required.');
      }
      const id = dto.id || await nextId(db, 'expense_categories', 'category_id', 'CAT');
      const status = dto.status || 'ACTIVE';
      const sortOrder = dto.sortOrder || 0;

      try {
        await db.prepare(`
          INSERT INTO expense_categories (category_id, category_code, category_name, category_group, status, sort_order)
          VALUES (?, ?, ?, ?, ?, ?)
        `).bind(id, dto.code, dto.name, dto.categoryGroup, status, sortOrder).run();

        return {
          id,
          category_code: dto.code,
          category_name: dto.name,
          category_group: dto.categoryGroup,
          status,
          sort_order: sortOrder
        };
      } catch (err) {
        wrapUniqueError(err, 'Expense Category code must be unique.');
      }
    },

    async addShipmentDocumentLink(dto, creatorId) {
      if (!dto.shipmentId || !dto.documentType || !dto.title || !dto.driveUrl) {
        throw new Error('shipmentId, documentType, title, and driveUrl are required.');
      }
      if (!dto.driveUrl.startsWith('http://') && !dto.driveUrl.startsWith('https://')) {
        throw new Error('Drive URL must start with http:// or https://');
      }

      const id = dto.id || await nextId(db, 'shipment_document_links', 'link_id', 'DOC');
      const now = new Date().toISOString();

      try {
        await db.prepare(`
          INSERT INTO shipment_document_links (link_id, shipment_id, document_type, title, drive_url, reference_no, remark, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, dto.shipmentId, dto.documentType, dto.title, dto.driveUrl, dto.referenceNo || null, dto.remark || null, creatorId, now, now).run();

        const row = await db.prepare(`
          SELECT link_id, shipment_id, document_type, title, drive_url, reference_no, remark, created_by, created_at, updated_at
          FROM shipment_document_links
          WHERE link_id = ?
        `).bind(id).first();

        return row;
      } catch (err) {
        throw err;
      }
    },

    async listShipmentDocumentLinks(shipmentId) {
      const { results } = await db.prepare(`
        SELECT link_id, shipment_id, document_type, title, drive_url, reference_no, remark, created_by, created_at, updated_at
        FROM shipment_document_links
        WHERE shipment_id = ?
        ORDER BY created_at ASC
      `).bind(shipmentId).all();

      return results || [];
    },

    async addShipmentExpense(dto, creatorId) {
      if (!dto.shipmentId || !dto.expenseCategoryId || !dto.amount || !dto.currency) {
        throw new Error('shipmentId, expenseCategoryId, amount, and currency are required.');
      }
      if (dto.currency === 'USD' && (typeof dto.fxUsed !== 'number' || dto.fxUsed <= 0)) {
        throw new Error('FX rate is required for USD expenses.');
      }

      const id = dto.id || await nextId(db, 'shipment_expenses', 'expense_id', 'EXP');
      const now = new Date().toISOString();
      const fxUsed = dto.currency === 'THB' ? null : dto.fxUsed;
      const amountThb = dto.currency === 'THB' ? dto.amount : dto.amount * dto.fxUsed;

      try {
        await db.prepare(`
          INSERT INTO shipment_expenses (expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb, reference_no, shipment_document_link_id, remark, created_by, updated_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, dto.shipmentId, dto.expenseCategoryId, dto.amount, dto.currency, fxUsed, amountThb, dto.referenceNo || null, dto.shipmentDocumentLinkId || null, dto.remark || null, creatorId, creatorId, now, now).run();

        const row = await db.prepare(`
          SELECT expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb, reference_no, shipment_document_link_id, remark, created_by, updated_by, created_at, updated_at
          FROM shipment_expenses
          WHERE expense_id = ?
        `).bind(id).first();

        return row;
      } catch (err) {
        throw err;
      }
    },

    async listShipmentExpenses(shipmentId) {
      const { results } = await db.prepare(`
        SELECT expense_id, shipment_id, expense_category_id, amount, currency, fx_used, amount_thb, reference_no, shipment_document_link_id, remark, created_by, updated_by, created_at, updated_at
        FROM shipment_expenses
        WHERE shipment_id = ?
        ORDER BY created_at ASC
      `).bind(shipmentId).all();

      return results || [];
    },

    async getShipmentTotalActualExportCostThb(shipmentId) {
      const row = await db.prepare(`
        SELECT SUM(amount_thb) AS total
        FROM shipment_expenses
        WHERE shipment_id = ?
      `).bind(shipmentId).first();

      return row?.total || 0;
    },

    async getShipmentFreightVariance(shipmentId) {
      const shipment = await db.prepare(`
        SELECT s.shipment_id, s.is_one_container, q.quoted_freight_usd_per_container
        FROM shipments s
        LEFT JOIN freight_quotes q ON s.freight_quote_id = q.quote_id
        WHERE s.shipment_id = ?
        LIMIT 1
      `).bind(shipmentId).first();

      if (!shipment || shipment.is_one_container !== 1) {
        return { quotedFreight: null, actualFreightSum: null, variance: null };
      }

      const actualRow = await db.prepare(`
        SELECT SUM(e.amount) AS total
        FROM shipment_expenses e
        JOIN expense_categories c ON e.expense_category_id = c.category_id
        WHERE e.shipment_id = ?
          AND c.category_group = 'OCEAN_FREIGHT'
          AND e.currency = 'USD'
      `).bind(shipmentId).first();

      const quotedFreight = shipment.quoted_freight_usd_per_container;
      const actualFreightSum = actualRow?.total || 0;

      if (quotedFreight === null || quotedFreight === undefined) {
        return { quotedFreight: null, actualFreightSum, variance: null };
      }

      const variance = quotedFreight - actualFreightSum;

      return {
        quotedFreight,
        actualFreightSum,
        variance
      };
    },

    async ensureShipmentAnchor(shipmentId, poId, customerId, productId, isOneContainer = 1) {
      const ship = await db.prepare(`SELECT * FROM shipments WHERE shipment_id = ?`).bind(shipmentId).first();
      if (ship) {
        // Return existing shipment along with po info
        return ship;
      }

      const po = await db.prepare(`SELECT * FROM pos WHERE po_id = ?`).bind(poId).first();
      if (!po) {
        await db.prepare(`
          INSERT INTO pos (po_id, customer_id, product_id, status)
          VALUES (?, ?, ?, 'ACTIVE')
        `).bind(poId, customerId, productId).run();
      }

      await db.prepare(`
        INSERT INTO shipments (shipment_id, po_id, is_one_container)
        VALUES (?, ?, ?)
      `).bind(shipmentId, poId, isOneContainer).run();

      return await db.prepare(`SELECT * FROM shipments WHERE shipment_id = ?`).bind(shipmentId).first();
    },

    async updateShipment(shipmentId, dto) {
      const sets = [];
      const params = [];
      if (dto.freightQuoteId !== undefined) {
        sets.push('freight_quote_id = ?');
        params.push(dto.freightQuoteId || null);
      }
      if (dto.isOneContainer !== undefined) {
        sets.push('is_one_container = ?');
        params.push(dto.isOneContainer);
      }

      if (sets.length > 0) {
        params.push(shipmentId);
        await db.prepare(`
          UPDATE shipments
          SET ${sets.join(', ')}
          WHERE shipment_id = ?
        `).bind(...params).run();
      }

      return await db.prepare(`SELECT * FROM shipments WHERE shipment_id = ?`).bind(shipmentId).first();
    },

    async getShipment(shipmentId) {
      return await db.prepare(`SELECT * FROM shipments WHERE shipment_id = ?`).bind(shipmentId).first();
    }
  };
}
