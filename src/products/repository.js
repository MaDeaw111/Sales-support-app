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
    },

    async listParameters() {
      const { results } = await db.prepare(`
        SELECT parameter_id, parameter_code, parameter_name, data_type, default_unit, status, sort_order
        FROM spec_parameters
        ORDER BY sort_order ASC, parameter_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(r => ({
        id: r.parameter_id,
        code: r.parameter_code,
        name: r.parameter_name,
        dataType: r.data_type,
        defaultUnit: r.default_unit,
        status: r.status,
        sortOrder: Number(r.sort_order)
      }));
    },

    async findParameterById(id) {
      const r = await db.prepare(`
        SELECT parameter_id, parameter_code, parameter_name, data_type, default_unit, status, sort_order
        FROM spec_parameters
        WHERE parameter_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!r) return null;

      return {
        id: r.parameter_id,
        code: r.parameter_code,
        name: r.parameter_name,
        dataType: r.data_type,
        defaultUnit: r.default_unit,
        status: r.status,
        sortOrder: Number(r.sort_order)
      };
    },

    async createParameter(dto) {
      if (!dto.code || !dto.name || !dto.dataType || !dto.status) {
        throw new Error('Parameter code, name, data type, and status are required.');
      }
      if (dto.dataType !== 'NUMBER' && dto.dataType !== 'TEXT') {
        throw new Error('Invalid parameter data type.');
      }
      if (dto.status !== 'ACTIVE' && dto.status !== 'INACTIVE' && dto.status !== 'ARCHIVED') {
        throw new Error('Invalid parameter status.');
      }

      const paramId = await nextId(db, 'spec_parameters', 'parameter_id', 'PAR');
      try {
        await db.prepare(`
          INSERT INTO spec_parameters (parameter_id, parameter_code, parameter_name, data_type, default_unit, status, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(paramId, dto.code.trim().toUpperCase(), dto.name.trim(), dto.dataType, dto.defaultUnit || '', dto.status, dto.sortOrder || 0).run();
      } catch (err) {
        wrapUniqueError(err, 'Parameter code already exists.');
      }

      return this.findParameterById(paramId);
    },

    async updateParameter(id, dto) {
      const existing = await this.findParameterById(id);
      if (!existing) throw new Error('Parameter not found.');

      if (!dto.name || !dto.dataType || !dto.status) {
        throw new Error('Parameter name, data type, and status are required.');
      }
      if (dto.dataType !== 'NUMBER' && dto.dataType !== 'TEXT') {
        throw new Error('Invalid parameter data type.');
      }
      if (dto.status !== 'ACTIVE' && dto.status !== 'INACTIVE' && dto.status !== 'ARCHIVED') {
        throw new Error('Invalid parameter status.');
      }

      await db.prepare(`
        UPDATE spec_parameters
        SET parameter_name = ?, data_type = ?, default_unit = ?, status = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
        WHERE parameter_id = ?
      `).bind(dto.name.trim(), dto.dataType, dto.defaultUnit || '', dto.status, dto.sortOrder || 0, id).run();

      return this.findParameterById(id);
    },

    async listStandardSpecs(productId, application) {
      const { results } = await db.prepare(`
        SELECT standard_spec_id, product_id, application, revision_no, status, effective_date, notes, created_by, created_at, updated_by, updated_at
        FROM standard_specs
        WHERE product_id = ? AND application = ?
        ORDER BY revision_no DESC
      `).bind(productId, application).all();

      const list = [];
      for (const r of (results || [])) {
        const spec = await this.findStandardSpecById(r.standard_spec_id);
        if (spec) list.push(spec);
      }
      return list;
    },

    async findStandardSpecById(id) {
      const r = await db.prepare(`
        SELECT standard_spec_id, product_id, application, revision_no, status, effective_date, notes, created_by, created_at, updated_by, updated_at
        FROM standard_specs
        WHERE standard_spec_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!r) return null;

      const { results: itemRows } = await db.prepare(`
        SELECT i.standard_spec_item_id, i.parameter_id, p.parameter_code, p.parameter_name, i.operator, i.numeric_value, i.numeric_value_to, i.text_value, i.unit, i.sort_order, i.notes
        FROM standard_spec_items i
        JOIN spec_parameters p ON i.parameter_id = p.parameter_id
        WHERE i.standard_spec_id = ?
        ORDER BY i.sort_order ASC, p.parameter_name ASC
      `).bind(id).all();

      return {
        id: r.standard_spec_id,
        productId: r.product_id,
        application: r.application,
        revisionNo: Number(r.revision_no),
        status: r.status,
        effectiveDate: r.effective_date,
        notes: r.notes,
        createdBy: r.created_by,
        createdAt: r.created_at,
        updatedBy: r.updated_by,
        updatedAt: r.updated_at,
        items: (itemRows || []).map(i => ({
          itemId: i.standard_spec_item_id,
          parameterId: i.parameter_id,
          parameterCode: i.parameter_code,
          parameterName: i.parameter_name,
          operator: i.operator,
          numericValue: i.numeric_value,
          numericValueTo: i.numeric_value_to,
          textValue: i.text_value,
          unit: i.unit,
          sortOrder: Number(i.sort_order),
          notes: i.notes
        }))
      };
    },

    async createStandardSpecDraft(dto) {
      if (!dto.productId || !dto.application || !dto.effectiveDate) {
        throw new Error('Product, application, and effective date are required.');
      }

      // 1. Calculate next revision number
      const row = await db.prepare(`
        SELECT COALESCE(MAX(revision_no), -1) AS max_rev
        FROM standard_specs
        WHERE product_id = ? AND application = ?
      `).bind(dto.productId, dto.application).first();
      const nextRev = Number(row?.max_rev ?? -1) + 1;

      // 2. Generate standard spec ID
      const specId = await nextId(db, 'standard_specs', 'standard_spec_id', 'STD');

      const statements = [];
      statements.push(db.prepare(`
        INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date, notes, created_by, updated_by)
        VALUES (?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?)
      `).bind(specId, dto.productId, dto.application, nextRev, dto.effectiveDate, dto.notes || '', dto.createdBy || null, dto.createdBy || null));

      // 3. Copy items from current ACTIVE spec if it exists
      const activeSpec = await db.prepare(`
        SELECT standard_spec_id FROM standard_specs
        WHERE product_id = ? AND application = ? AND status = 'ACTIVE'
        LIMIT 1
      `).bind(dto.productId, dto.application).first();

      if (activeSpec) {
        const { results: activeItems } = await db.prepare(`
          SELECT parameter_id, operator, numeric_value, numeric_value_to, text_value, unit, sort_order, notes
          FROM standard_spec_items
          WHERE standard_spec_id = ?
        `).bind(activeSpec.standard_spec_id).all();

        for (const item of (activeItems || [])) {
          const itemId = `STI-${crypto.randomUUID()}`;
          statements.push(db.prepare(`
            INSERT INTO standard_spec_items (standard_spec_item_id, standard_spec_id, parameter_id, operator, numeric_value, numeric_value_to, text_value, unit, sort_order, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).bind(itemId, specId, item.parameter_id, item.operator, item.numeric_value, item.numeric_value_to, item.text_value, item.unit, item.sort_order, item.notes));
        }
      }

      await db.batch(statements);
      return this.findStandardSpecById(specId);
    },

    async updateStandardSpecDraftItems(specId, items, updatedBy) {
      const existing = await this.findStandardSpecById(specId);
      if (!existing) throw new Error('Standard specification not found.');
      if (existing.status !== 'DRAFT') {
        throw new Error('Cannot edit non-DRAFT specifications.');
      }

      const statements = [];
      statements.push(db.prepare(`
        DELETE FROM standard_spec_items WHERE standard_spec_id = ?
      `).bind(specId));

      for (const item of (items || [])) {
        const itemId = `STI-${crypto.randomUUID()}`;
        statements.push(db.prepare(`
          INSERT INTO standard_spec_items (standard_spec_item_id, standard_spec_id, parameter_id, operator, numeric_value, numeric_value_to, text_value, unit, sort_order, notes)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          itemId,
          specId,
          item.parameterId,
          item.operator,
          item.numericValue !== undefined ? item.numericValue : null,
          item.numericValueTo !== undefined ? item.numericValueTo : null,
          item.textValue !== undefined ? item.textValue : null,
          item.unit || '',
          item.sortOrder || 0,
          item.notes || ''
        ));
      }

      statements.push(db.prepare(`
        UPDATE standard_specs
        SET updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE standard_spec_id = ?
      `).bind(updatedBy || null, specId));

      await db.batch(statements);
      return this.findStandardSpecById(specId);
    },

    async activateStandardSpec(specId, userId) {
      const existing = await this.findStandardSpecById(specId);
      if (!existing) throw new Error('Standard specification not found.');
      if (existing.status !== 'DRAFT') {
        throw new Error('Only DRAFT specifications can be activated.');
      }

      const statements = [];
      // Archive any existing active spec
      statements.push(db.prepare(`
        UPDATE standard_specs
        SET status = 'ARCHIVED', updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE product_id = ? AND application = ? AND status = 'ACTIVE'
      `).bind(userId || null, existing.productId, existing.application));

      // Activate target spec
      statements.push(db.prepare(`
        UPDATE standard_specs
        SET status = 'ACTIVE', updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE standard_spec_id = ?
      `).bind(userId || null, specId));

      await db.batch(statements);
      return this.findStandardSpecById(specId);
    },

    async archiveStandardSpec(specId, userId) {
      const existing = await this.findStandardSpecById(specId);
      if (!existing) throw new Error('Standard specification not found.');
      if (existing.status !== 'ACTIVE') {
        throw new Error('Only ACTIVE specifications can be archived.');
      }

      await db.prepare(`
        UPDATE standard_specs
        SET status = 'ARCHIVED', updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE standard_spec_id = ?
      `).bind(userId || null, specId).run();

      return this.findStandardSpecById(specId);
    }
  };
}
