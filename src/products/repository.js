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

export function createProductRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listCategories() {
      const { results } = await db.prepare(`
        SELECT category_id, category_code, category_name, status
        FROM product_categories
        ORDER BY category_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(r => ({
        id: r.category_id,
        code: r.category_code,
        name: r.category_name,
        status: r.status
      }));
    },

    async findCategoryById(id) {
      const row = await db.prepare(`
        SELECT category_id, category_code, category_name, status
        FROM product_categories
        WHERE category_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!row) return null;

      return {
        id: row.category_id,
        code: row.category_code,
        name: row.category_name,
        status: row.status
      };
    },

    async createCategory(dto) {
      if (!dto.code || !dto.name) {
        throw new Error('Category code and name are required.');
      }
      const categoryId = await nextId(db, 'product_categories', 'category_id', 'CAT');
      try {
        await db.prepare(`
          INSERT INTO product_categories (category_id, category_code, category_name, status)
          VALUES (?, ?, ?, ?)
        `).bind(categoryId, dto.code.trim().toUpperCase(), dto.name.trim(), dto.status || 'ACTIVE').run();
      } catch (err) {
        wrapUniqueError(err, 'Category code already exists.');
      }

      return this.findCategoryById(categoryId);
    },

    async updateCategory(id, dto) {
      const existing = await this.findCategoryById(id);
      if (!existing) throw new Error('Category not found.');

      if (!dto.name || !dto.status) {
        throw new Error('Category name and status are required.');
      }

      await db.prepare(`
        UPDATE product_categories
        SET category_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE category_id = ?
      `).bind(dto.name.trim(), dto.status, id).run();

      return this.findCategoryById(id);
    },

    async listForms() {
      const { results } = await db.prepare(`
        SELECT form_id, form_code, form_name, status
        FROM product_forms
        ORDER BY form_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(r => ({
        id: r.form_id,
        code: r.form_code,
        name: r.form_name,
        status: r.status
      }));
    },

    async findFormById(id) {
      const row = await db.prepare(`
        SELECT form_id, form_code, form_name, status
        FROM product_forms
        WHERE form_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!row) return null;

      return {
        id: row.form_id,
        code: row.form_code,
        name: row.form_name,
        status: row.status
      };
    },

    async createForm(dto) {
      if (!dto.code || !dto.name) {
        throw new Error('Form code and name are required.');
      }
      const formId = await nextId(db, 'product_forms', 'form_id', 'FRM');
      try {
        await db.prepare(`
          INSERT INTO product_forms (form_id, form_code, form_name, status)
          VALUES (?, ?, ?, ?)
        `).bind(formId, dto.code.trim().toUpperCase(), dto.name.trim(), dto.status || 'ACTIVE').run();
      } catch (err) {
        wrapUniqueError(err, 'Form code already exists.');
      }

      return this.findFormById(formId);
    },

    async updateForm(id, dto) {
      const existing = await this.findFormById(id);
      if (!existing) throw new Error('Form not found.');

      if (!dto.name || !dto.status) {
        throw new Error('Form name and status are required.');
      }

      await db.prepare(`
        UPDATE product_forms
        SET form_name = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE form_id = ?
      `).bind(dto.name.trim(), dto.status, id).run();

      return this.findFormById(id);
    },

    async listProducts() {
      const { results } = await db.prepare(`
        SELECT p.product_id, p.product_code, p.product_name, p.short_name, p.hs_code, p.default_unit, p.status,
               c.category_id, c.category_code, c.category_name,
               f.form_id, f.form_code, f.form_name
        FROM products p
        JOIN product_categories c ON p.category_id = c.category_id
        JOIN product_forms f ON p.form_id = f.form_id
        ORDER BY p.product_name COLLATE NOCASE ASC
      `).all();

      const productsList = [];
      for (const r of (results || [])) {
        // Fetch applications
        const { results: apps } = await db.prepare(`
          SELECT application FROM product_applications WHERE product_id = ?
        `).bind(r.product_id).all();

        productsList.push({
          id: r.product_id,
          code: r.product_code,
          name: r.product_name,
          shortName: r.short_name,
          hsCode: r.hs_code,
          defaultUnit: r.default_unit,
          status: r.status,
          category: {
            id: r.category_id,
            code: r.category_code,
            name: r.category_name
          },
          form: {
            id: r.form_id,
            code: r.form_code,
            name: r.form_name
          },
          applications: (apps || []).map(a => a.application)
        });
      }
      return productsList;
    },

    async findProductById(id) {
      const r = await db.prepare(`
        SELECT p.product_id, p.product_code, p.product_name, p.short_name, p.hs_code, p.default_unit, p.status,
               c.category_id, c.category_code, c.category_name,
               f.form_id, f.form_code, f.form_name
        FROM products p
        JOIN product_categories c ON p.category_id = c.category_id
        JOIN product_forms f ON p.form_id = f.form_id
        WHERE p.product_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!r) return null;

      // Fetch applications
      const { results: apps } = await db.prepare(`
        SELECT application FROM product_applications WHERE product_id = ?
      `).bind(id).all();

      return {
        id: r.product_id,
        code: r.product_code,
        name: r.product_name,
        shortName: r.short_name,
        hsCode: r.hs_code,
        defaultUnit: r.default_unit,
        status: r.status,
        category: {
          id: r.category_id,
          code: r.category_code,
          name: r.category_name
        },
        form: {
          id: r.form_id,
          code: r.form_code,
          name: r.form_name
        },
        applications: (apps || []).map(a => a.application)
      };
    },

    async createProduct(dto) {
      if (!dto.code || !dto.name || !dto.shortName || !dto.categoryId || !dto.formId) {
        throw new Error('Product code, name, short name, category, and form are required.');
      }

      // Check category and form exist
      const cat = await this.findCategoryById(dto.categoryId);
      if (!cat) throw new Error('Category not found.');
      const frm = await this.findFormById(dto.formId);
      if (!frm) throw new Error('Form not found.');

      const productId = await nextId(db, 'products', 'product_id', 'PRD');

      const statements = [];
      statements.push(db.prepare(`
        INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id, hs_code, default_unit, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(productId, dto.code.trim().toUpperCase(), dto.name.trim(), dto.shortName.trim(), dto.categoryId, dto.formId, dto.hsCode || '', dto.defaultUnit || 'MT', dto.status || 'ACTIVE'));

      if (dto.applications && Array.isArray(dto.applications)) {
        for (const app of dto.applications) {
          statements.push(db.prepare(`
            INSERT INTO product_applications (product_id, application)
            VALUES (?, ?)
          `).bind(productId, app));
        }
      }

      try {
        await db.batch(statements);
      } catch (err) {
        wrapUniqueError(err, 'Product code already exists.');
      }

      return this.findProductById(productId);
    },

    async updateProduct(id, dto) {
      const existing = await this.findProductById(id);
      if (!existing) throw new Error('Product not found.');

      if (!dto.name || !dto.shortName || !dto.categoryId || !dto.formId || !dto.status) {
        throw new Error('Product name, short name, category, form, and status are required.');
      }

      // Check category and form exist
      const cat = await this.findCategoryById(dto.categoryId);
      if (!cat) throw new Error('Category not found.');
      const frm = await this.findFormById(dto.formId);
      if (!frm) throw new Error('Form not found.');

      const statements = [];
      statements.push(db.prepare(`
        UPDATE products
        SET product_name = ?, short_name = ?, category_id = ?, form_id = ?, hs_code = ?, default_unit = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = ?
      `).bind(dto.name.trim(), dto.shortName.trim(), dto.categoryId, dto.formId, dto.hsCode || '', dto.defaultUnit || 'MT', dto.status, id));

      statements.push(db.prepare('DELETE FROM product_applications WHERE product_id = ?').bind(id));

      if (dto.applications && Array.isArray(dto.applications)) {
        for (const app of dto.applications) {
          statements.push(db.prepare(`
            INSERT INTO product_applications (product_id, application)
            VALUES (?, ?)
          `).bind(id, app));
        }
      }

      try {
        await db.batch(statements);
      } catch (err) {
        wrapUniqueError(err, 'Product update conflict.');
      }

      return this.findProductById(id);
    }
  };
}
