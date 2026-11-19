import {
  validateStandardPriceInput,
  validateSpecialPriceRequest,
  validateSpecialPriceReview
} from './validation.js';

async function nextId(db, table, column, prefix) {
  const globPattern = `${prefix}-[0-9]*`;
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(${column}, ${prefix.length + 2}) AS INTEGER)), 0) AS max_id
    FROM ${table}
    WHERE ${column} GLOB '${globPattern}'
  `).first();
  return `${prefix}-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

async function tableExists(db, tableName) {
  try {
    const row = await db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
    `).bind(tableName).first();
    return Boolean(row?.name);
  } catch {
    return false;
  }
}

function mapStandardPriceRow(row) {
  const hasActive = Boolean(row.standard_price_id);
  return {
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    shortName: row.short_name,
    categoryName: row.category_name || '',
    formName: row.form_name || '',
    defaultUnit: row.default_unit || 'MT',
    hasActivePrice: hasActive,
    id: hasActive ? row.standard_price_id : null,
    revisionNo: hasActive ? Number(row.revision_no) : 0,
    fobUsdPerMt: hasActive ? Number(row.price_per_mt) : null,
    pricePerMt: hasActive ? Number(row.price_per_mt) : null,
    currency: hasActive ? row.currency : 'USD',
    effectiveDate: hasActive ? row.effective_from : null,
    effectiveFrom: hasActive ? row.effective_from : null,
    validUntil: hasActive ? (row.valid_until || null) : null,
    status: hasActive ? row.price_status : 'NOT_SET',
    previousPricePerMt: hasActive && row.previous_price_per_mt !== null && row.previous_price_per_mt !== undefined
      ? Number(row.previous_price_per_mt)
      : null,
    changeReason: hasActive ? (row.change_reason || '') : '',
    changedBy: hasActive ? row.changed_by : null,
    changedByName: hasActive ? (row.changed_by_name || row.changed_by || null) : null,
    changedAt: hasActive ? row.changed_at : null,
    historyCount: Number(row.history_count || 0)
  };
}

function mapHistoryEntry(row) {
  return {
    id: row.standard_price_id,
    productId: row.product_id,
    productCode: row.product_code || '',
    productName: row.product_name || '',
    shortName: row.short_name || '',
    revisionNo: Number(row.revision_no),
    pricePerMt: Number(row.price_per_mt),
    fobUsdPerMt: Number(row.price_per_mt),
    previousPricePerMt: row.previous_price_per_mt !== null && row.previous_price_per_mt !== undefined
      ? Number(row.previous_price_per_mt)
      : null,
    currency: row.currency,
    effectiveFrom: row.effective_from,
    effectiveDate: row.effective_from,
    validUntil: row.valid_until || null,
    status: row.status,
    changeReason: row.change_reason || '',
    changedBy: row.changed_by,
    changedByName: row.changed_by_name || row.changed_by,
    changedAt: row.changed_at
  };
}

function mapSpecialPriceRow(row) {
  return {
    id: row.special_price_id,
    customerId: row.customer_id,
    customerName: row.customer_name || row.customer_id,
    productId: row.product_id,
    productCode: row.product_code || '',
    productName: row.product_name || '',
    shortName: row.short_name || row.product_id,
    stdFobAtRequest: Number(row.std_fob_at_request || 0),
    approvedPriceUsd: Number(row.approved_price_usd || 0),
    expectedQtyMt: Number(row.expected_qty_mt || 0),
    validUntil: row.valid_until || null,
    approvalStatus: row.approval_status,
    reason: row.reason || '',
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name || row.requested_by,
    reviewedBy: row.reviewed_by || null,
    reviewedByName: row.reviewed_by_name || row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    createdAt: row.created_at
  };
}

export function createPricingRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listActiveProductStandardPrices() {
      const hasStandardPrices = await tableExists(db, 'standard_prices');
      if (!hasStandardPrices) {
        const { results } = await db.prepare(`
          SELECT p.product_id, p.product_code, p.product_name, p.short_name, p.default_unit,
                 c.category_name, f.form_name
          FROM products p
          LEFT JOIN product_categories c ON c.category_id = p.category_id
          LEFT JOIN product_forms f ON f.form_id = p.form_id
          WHERE p.status = 'ACTIVE'
          ORDER BY p.product_name COLLATE NOCASE ASC
        `).all();
        return (results || []).map((row) => mapStandardPriceRow({
          ...row,
          standard_price_id: null,
          history_count: 0
        }));
      }

      const { results } = await db.prepare(`
        SELECT p.product_id, p.product_code, p.product_name, p.short_name, p.default_unit,
               c.category_name, f.form_name,
               sp.standard_price_id, sp.revision_no, sp.price_per_mt, sp.currency,
               sp.effective_from, sp.valid_until, sp.status AS price_status,
               sp.previous_price_per_mt, sp.change_reason, sp.changed_by, sp.changed_at,
               u.full_name AS changed_by_name,
               (SELECT COUNT(*) FROM standard_prices h WHERE h.product_id = p.product_id) AS history_count
        FROM products p
        LEFT JOIN product_categories c ON c.category_id = p.category_id
        LEFT JOIN product_forms f ON f.form_id = p.form_id
        LEFT JOIN standard_prices sp ON sp.product_id = p.product_id AND sp.status = 'ACTIVE'
        LEFT JOIN users u ON u.user_id = sp.changed_by
        WHERE p.status = 'ACTIVE'
        ORDER BY p.product_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(mapStandardPriceRow);
    },

    async setStandardPrice(productId, dto, actorId) {
      const hasStandardPrices = await tableExists(db, 'standard_prices');
      if (!hasStandardPrices) {
        const err = new Error('Pricing tables are not initialized yet (apply migration 0011_standard_price_history.sql).');
        err.code = 'MIGRATION_REQUIRED';
        throw err;
      }

      const validated = validateStandardPriceInput(dto);

      const product = await db.prepare(`
        SELECT product_id, product_code, product_name, short_name, status
        FROM products
        WHERE product_id = ?
        LIMIT 1
      `).bind(productId).first();
      if (!product) {
        const err = new Error('Product not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      const currentActive = await db.prepare(`
        SELECT standard_price_id, price_per_mt, revision_no
        FROM standard_prices
        WHERE product_id = ? AND status = 'ACTIVE'
        LIMIT 1
      `).bind(productId).first();

      const maxRevRow = await db.prepare(`
        SELECT COALESCE(MAX(revision_no), 0) AS max_rev
        FROM standard_prices
        WHERE product_id = ?
      `).bind(productId).first();

      const nextRevisionNo = Number(maxRevRow?.max_rev || 0) + 1;
      const newId = await nextId(db, 'standard_prices', 'standard_price_id', 'STD');
      const previousPrice = currentActive ? Number(currentActive.price_per_mt) : null;

      const statements = [];
      if (currentActive) {
        statements.push(db.prepare(`
          UPDATE standard_prices
          SET status = 'SUPERSEDED'
          WHERE product_id = ? AND status = 'ACTIVE'
        `).bind(productId));
      }

      statements.push(db.prepare(`
        INSERT INTO standard_prices (
          standard_price_id, product_id, revision_no, price_per_mt, currency,
          effective_from, valid_until, status, previous_price_per_mt, change_reason, changed_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?, ?)
      `).bind(
        newId,
        productId,
        nextRevisionNo,
        validated.pricePerMt,
        validated.currency,
        validated.effectiveFrom,
        validated.validUntil,
        previousPrice,
        validated.changeReason,
        actorId
      ));

      await db.batch(statements);

      const savedRow = await db.prepare(`
        SELECT p.product_id, p.product_code, p.product_name, p.short_name, p.default_unit,
               c.category_name, f.form_name,
               sp.standard_price_id, sp.revision_no, sp.price_per_mt, sp.currency,
               sp.effective_from, sp.valid_until, sp.status AS price_status,
               sp.previous_price_per_mt, sp.change_reason, sp.changed_by, sp.changed_at,
               u.full_name AS changed_by_name,
               (SELECT COUNT(*) FROM standard_prices h WHERE h.product_id = p.product_id) AS history_count
        FROM products p
        LEFT JOIN product_categories c ON c.category_id = p.category_id
        LEFT JOIN product_forms f ON f.form_id = p.form_id
        JOIN standard_prices sp ON sp.standard_price_id = ?
        LEFT JOIN users u ON u.user_id = sp.changed_by
        WHERE p.product_id = ?
        LIMIT 1
      `).bind(newId, productId).first();

      return mapStandardPriceRow(savedRow);
    },

    async getProductPriceHistory(productId) {
      const product = await db.prepare(`
        SELECT product_id, product_code, product_name, short_name, status
        FROM products
        WHERE product_id = ?
        LIMIT 1
      `).bind(productId).first();
      if (!product) {
        const err = new Error('Product not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      const hasStandardPrices = await tableExists(db, 'standard_prices');
      const hasSpecialPrices = await tableExists(db, 'special_prices');

      let standardPriceHistory = [];
      if (hasStandardPrices) {
        const { results } = await db.prepare(`
          SELECT sp.standard_price_id, sp.product_id, p.product_code, p.product_name, p.short_name,
                 sp.revision_no, sp.price_per_mt, sp.previous_price_per_mt, sp.currency,
                 sp.effective_from, sp.valid_until, sp.status, sp.change_reason,
                 sp.changed_by, u.full_name AS changed_by_name, sp.changed_at
          FROM standard_prices sp
          JOIN products p ON p.product_id = sp.product_id
          LEFT JOIN users u ON u.user_id = sp.changed_by
          WHERE sp.product_id = ?
          ORDER BY sp.revision_no DESC, sp.changed_at DESC
        `).bind(productId).all();
        standardPriceHistory = (results || []).map(mapHistoryEntry);
      }

      let approvedSpecialPriceHistory = [];
      if (hasSpecialPrices) {
        const { results } = await db.prepare(`
          SELECT sp.special_price_id, sp.customer_id, c.customer_name,
                 sp.product_id, p.product_code, p.product_name, p.short_name,
                 sp.std_fob_at_request, sp.approved_price_usd, sp.expected_qty_mt,
                 sp.valid_until, sp.approval_status, sp.reason,
                 sp.requested_by, req_u.full_name AS requested_by_name,
                 sp.reviewed_by, rev_u.full_name AS reviewed_by_name,
                 sp.reviewed_at, sp.created_at
          FROM special_prices sp
          JOIN customers c ON c.customer_id = sp.customer_id
          JOIN products p ON p.product_id = sp.product_id
          LEFT JOIN users req_u ON req_u.user_id = sp.requested_by
          LEFT JOIN users rev_u ON rev_u.user_id = sp.reviewed_by
          WHERE sp.product_id = ? AND sp.approval_status = 'APPROVED'
          ORDER BY COALESCE(sp.reviewed_at, sp.created_at) DESC
        `).bind(productId).all();
        approvedSpecialPriceHistory = (results || []).map(mapSpecialPriceRow);
      }

      return {
        product: {
          id: product.product_id,
          code: product.product_code,
          name: product.product_name,
          shortName: product.short_name,
          status: product.status
        },
        standardPriceHistory,
        approvedSpecialPriceHistory
      };
    },

    async listAllStandardPriceHistory(productId = null) {
      const hasStandardPrices = await tableExists(db, 'standard_prices');
      if (!hasStandardPrices) return [];

      let sql = `
        SELECT sp.standard_price_id, sp.product_id, p.product_code, p.product_name, p.short_name,
               sp.revision_no, sp.price_per_mt, sp.previous_price_per_mt, sp.currency,
               sp.effective_from, sp.valid_until, sp.status, sp.change_reason,
               sp.changed_by, u.full_name AS changed_by_name, sp.changed_at
        FROM standard_prices sp
        JOIN products p ON p.product_id = sp.product_id
        LEFT JOIN users u ON u.user_id = sp.changed_by
      `;
      const params = [];
      if (productId) {
        sql += ' WHERE sp.product_id = ?';
        params.push(productId);
      }
      sql += ' ORDER BY sp.changed_at DESC, sp.revision_no DESC';
      const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const { results } = await stmt.all();
      return (results || []).map(mapHistoryEntry);
    },

    async listSpecialPrices(caller = {}) {
      const hasSpecialPrices = await tableExists(db, 'special_prices');
      if (!hasSpecialPrices) return [];

      let sql = `
        SELECT sp.special_price_id, sp.customer_id, c.customer_name,
               sp.product_id, p.product_code, p.product_name, p.short_name,
               sp.std_fob_at_request, sp.approved_price_usd, sp.expected_qty_mt,
               sp.valid_until, sp.approval_status, sp.reason,
               sp.requested_by, req_u.full_name AS requested_by_name,
               sp.reviewed_by, rev_u.full_name AS reviewed_by_name,
               sp.reviewed_at, sp.created_at
        FROM special_prices sp
        JOIN customers c ON c.customer_id = sp.customer_id
        JOIN products p ON p.product_id = sp.product_id
        LEFT JOIN users req_u ON req_u.user_id = sp.requested_by
        LEFT JOIN users rev_u ON rev_u.user_id = sp.reviewed_by
        WHERE 1 = 1
      `;
      const params = [];
      if (caller?.role === 'EXTERNAL_SALES') {
        sql += ' AND c.owner_user_id = ?';
        params.push(caller.user_id);
      }
      sql += ' ORDER BY sp.created_at DESC, sp.special_price_id DESC';
      const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
      const { results } = await stmt.all();
      return (results || []).map(mapSpecialPriceRow);
    },

    async createSpecialPriceRequest(dto, caller) {
      const hasSpecialPrices = await tableExists(db, 'special_prices');
      if (!hasSpecialPrices) {
        const err = new Error('Pricing tables are not initialized yet (apply migration 0011_standard_price_history.sql).');
        err.code = 'MIGRATION_REQUIRED';
        throw err;
      }

      const validated = validateSpecialPriceRequest(dto);

      const customer = await db.prepare(`
        SELECT customer_id, owner_user_id FROM customers WHERE customer_id = ? LIMIT 1
      `).bind(validated.customerId).first();
      if (!customer) {
        const err = new Error('Customer not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (caller?.role === 'EXTERNAL_SALES' && customer.owner_user_id !== caller.user_id) {
        const err = new Error('Permission denied for this customer.');
        err.code = 'FORBIDDEN';
        throw err;
      }

      const product = await db.prepare(`
        SELECT product_id FROM products WHERE product_id = ? LIMIT 1
      `).bind(validated.productId).first();
      if (!product) {
        const err = new Error('Product not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }

      let stdFobAtRequest = 0;
      if (await tableExists(db, 'standard_prices')) {
        const activeStd = await db.prepare(`
          SELECT price_per_mt FROM standard_prices WHERE product_id = ? AND status = 'ACTIVE' LIMIT 1
        `).bind(validated.productId).first();
        if (activeStd) stdFobAtRequest = Number(activeStd.price_per_mt || 0);
      }

      const id = await nextId(db, 'special_prices', 'special_price_id', 'SPR');
      await db.prepare(`
        INSERT INTO special_prices (
          special_price_id, customer_id, product_id, std_fob_at_request,
          approved_price_usd, expected_qty_mt, valid_until, approval_status, reason, requested_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?)
      `).bind(
        id,
        validated.customerId,
        validated.productId,
        stdFobAtRequest,
        validated.approvedPriceUsd,
        validated.expectedQtyMt,
        validated.validUntil,
        validated.reason,
        caller.user_id
      ).run();

      const row = await db.prepare(`
        SELECT sp.special_price_id, sp.customer_id, c.customer_name,
               sp.product_id, p.product_code, p.product_name, p.short_name,
               sp.std_fob_at_request, sp.approved_price_usd, sp.expected_qty_mt,
               sp.valid_until, sp.approval_status, sp.reason,
               sp.requested_by, req_u.full_name AS requested_by_name,
               sp.reviewed_by, rev_u.full_name AS reviewed_by_name,
               sp.reviewed_at, sp.created_at
        FROM special_prices sp
        JOIN customers c ON c.customer_id = sp.customer_id
        JOIN products p ON p.product_id = sp.product_id
        LEFT JOIN users req_u ON req_u.user_id = sp.requested_by
        LEFT JOIN users rev_u ON rev_u.user_id = sp.reviewed_by
        WHERE sp.special_price_id = ?
        LIMIT 1
      `).bind(id).first();

      return mapSpecialPriceRow(row);
    },

    async reviewSpecialPrice(specialPriceId, dto, reviewerId) {
      const hasSpecialPrices = await tableExists(db, 'special_prices');
      if (!hasSpecialPrices) {
        const err = new Error('Pricing tables are not initialized yet (apply migration 0011_standard_price_history.sql).');
        err.code = 'MIGRATION_REQUIRED';
        throw err;
      }

      const { decision } = validateSpecialPriceReview(dto);
      const existing = await db.prepare(`
        SELECT special_price_id, approval_status FROM special_prices WHERE special_price_id = ? LIMIT 1
      `).bind(specialPriceId).first();
      if (!existing) {
        const err = new Error('Special price request not found.');
        err.code = 'NOT_FOUND';
        throw err;
      }
      if (existing.approval_status !== 'PENDING') {
        throw new Error('Only PENDING special price requests can be reviewed.');
      }

      const nextStatus = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      await db.prepare(`
        UPDATE special_prices
        SET approval_status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE special_price_id = ?
      `).bind(nextStatus, reviewerId, specialPriceId).run();

      const row = await db.prepare(`
        SELECT sp.special_price_id, sp.customer_id, c.customer_name,
               sp.product_id, p.product_code, p.product_name, p.short_name,
               sp.std_fob_at_request, sp.approved_price_usd, sp.expected_qty_mt,
               sp.valid_until, sp.approval_status, sp.reason,
               sp.requested_by, req_u.full_name AS requested_by_name,
               sp.reviewed_by, rev_u.full_name AS reviewed_by_name,
               sp.reviewed_at, sp.created_at
        FROM special_prices sp
        JOIN customers c ON c.customer_id = sp.customer_id
        JOIN products p ON p.product_id = sp.product_id
        LEFT JOIN users req_u ON req_u.user_id = sp.requested_by
        LEFT JOIN users rev_u ON rev_u.user_id = sp.reviewed_by
        WHERE sp.special_price_id = ?
        LIMIT 1
      `).bind(specialPriceId).first();

      return mapSpecialPriceRow(row);
    }
  };
}
