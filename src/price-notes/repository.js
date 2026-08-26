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

export function createPriceNoteRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async createPriceNote(dto, creatorId) {
      if (!dto.salesUserId || !dto.customerId || !dto.productId || !dto.incoterm) {
        throw new Error('salesUserId, customerId, productId, and incoterm are required.');
      }
      if (typeof dto.offerPriceUsdPerMt !== 'number' || dto.offerPriceUsdPerMt <= 0) {
        throw new Error('Offer price must be greater than zero.');
      }
      if (['CFR', 'CIF'].includes(dto.incoterm) && (!dto.destinationPort || !dto.destinationPort.trim())) {
        throw new Error('Destination port is required for CFR and CIF.');
      }

      const id = dto.id || await nextId(db, 'manager_price_notes', 'note_id', 'PN');
      const destinationPort = dto.incoterm === 'FOB' ? (dto.destinationPort || null) : dto.destinationPort;

      try {
        await db.prepare(`
          INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, note, created_by_manager_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(id, dto.salesUserId, dto.customerId, dto.productId, dto.incoterm, destinationPort, dto.offerPriceUsdPerMt, dto.note || null, creatorId).run();

        const row = await db.prepare(`
          SELECT note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, note, created_by_manager_id, created_at
          FROM manager_price_notes
          WHERE note_id = ?
        `).bind(id).first();

        return {
          id: row.note_id,
          sales_user_id: row.sales_user_id,
          customer_id: row.customer_id,
          product_id: row.product_id,
          incoterm: row.incoterm,
          destination_port: row.destination_port,
          offer_price_usd_per_mt: row.offer_price_usd_per_mt,
          note: row.note,
          created_by_manager_id: row.created_by_manager_id,
          created_at: row.created_at
        };
      } catch (err) {
        throw err;
      }
    },

    async listPriceNotes(filters = {}) {
      let query = `
        SELECT note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, note, created_by_manager_id, created_at
        FROM manager_price_notes
        WHERE 1 = 1
      `;
      const params = [];

      if (filters.salesUserId) {
        query += ` AND sales_user_id = ?`;
        params.push(filters.salesUserId);
      }
      if (filters.customerId) {
        query += ` AND customer_id = ?`;
        params.push(filters.customerId);
      }
      if (filters.productId) {
        query += ` AND product_id = ?`;
        params.push(filters.productId);
      }

      query += ` ORDER BY created_at DESC`;

      const { results } = await db.prepare(query).bind(...params).all();

      return (results || []).map(r => ({
        id: r.note_id,
        sales_user_id: r.sales_user_id,
        customer_id: r.customer_id,
        product_id: r.product_id,
        incoterm: r.incoterm,
        destination_port: r.destination_port,
        offer_price_usd_per_mt: r.offer_price_usd_per_mt,
        note: r.note,
        created_by_manager_id: r.created_by_manager_id,
        created_at: r.created_at
      }));
    }
  };
}
