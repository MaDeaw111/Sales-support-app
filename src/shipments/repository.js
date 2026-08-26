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
    }
  };
}
