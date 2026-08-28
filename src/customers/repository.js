function wrapDb(db) {
  if (!db) throw new Error('D1 DB binding is required.');
  
  const testStmt = db.prepare('SELECT 1');
  const isD1 = typeof testStmt.bind === 'function';
  
  if (isD1) {
    return db;
  }
  
  return {
    prepare(sql) {
      const stmt = db.prepare(sql);
      return {
        _params: [],
        bind(...args) {
          this._params = args;
          return this;
        },
        async first() {
          const rows = stmt.all(...this._params);
          return rows[0] || null;
        },
        async run() {
          const res = stmt.run(...this._params);
          return { success: true, meta: res };
        },
        async all() {
          const rows = stmt.all(...this._params);
          return { results: rows, success: true };
        }
      };
    },
    async batch(statements) {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    }
  };
}

function rowToCustomer(row, contacts = []) {
  const primary = contacts.find(c => Number(c.is_primary) === 1) || contacts[0] || null;
  return {
    id: row.customer_id,
    code: row.customer_code,
    name: row.customer_name,
    country: row.country || '',
    source: row.source || 'DIRECT',
    ownerId: row.owner_user_id || '',
    ownershipType: row.ownership_type || 'HOUSE_ACCOUNT',
    status: row.status,
    notes: row.notes || '',
    contactPerson: primary?.contact_name || '',
    contactEmail: primary?.email || '',
    contactPhone: primary?.phone || '',
    contacts: contacts.map(c => ({
      id: c.contact_id,
      name: c.contact_name,
      position: c.position || '',
      email: c.email || '',
      phone: c.phone || '',
      isPrimary: Number(c.is_primary) === 1
    }))
  };
}

async function nextCustomerId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(customer_id, 6) AS INTEGER)), 0) AS max_id
    FROM customers
    WHERE customer_id GLOB 'CUST-[0-9]*'
  `).first();
  return `CUST-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

function normalizeContacts(contacts = []) {
  const filtered = contacts.filter(c => String(c?.name || '').trim());
  if (filtered.length === 0) return [];
  
  const hasPrimary = filtered.some(c => !!c.isPrimary);
  let primarySeen = false;
  
  return filtered.map((c, index) => {
    let isPrimary = false;
    if (hasPrimary) {
      if (c.isPrimary && !primarySeen) {
        isPrimary = true;
        primarySeen = true;
      }
    } else if (index === 0) {
      isPrimary = true;
    }
    return {
      id: c.id || c.contactId || undefined,
      name: String(c.name).trim(),
      position: String(c.position || '').trim(),
      email: String(c.email || '').trim(),
      phone: String(c.phone || '').trim(),
      isPrimary
    };
  });
}

export function createCustomerRepository(dbBinding) {
  const db = wrapDb(dbBinding);
  
  const repo = {
    async userExists(userId) {
      const row = await db.prepare('SELECT 1 FROM users WHERE user_id = ? LIMIT 1').bind(userId).first();
      return !!row;
    },

    async findCustomerById(customerId) {
      const customerRow = await db.prepare(`
        SELECT customer_id, customer_code, customer_name, country, source, owner_user_id, status, notes, ownership_type, created_at, updated_at
        FROM customers
        WHERE customer_id = ?
        LIMIT 1
      `).bind(customerId).first();
      
      if (!customerRow) return null;
      
      const { results: contactRows } = await db.prepare(`
        SELECT contact_id, customer_id, contact_name, position, email, phone, is_primary
        FROM customer_contacts
        WHERE customer_id = ?
        ORDER BY is_primary DESC, contact_name COLLATE NOCASE
      `).bind(customerId).all();
      
      return rowToCustomer(customerRow, contactRows || []);
    },
    
    async listCustomers(filters = {}) {
      const sql = `
        SELECT customer_id, customer_code, customer_name, country, source,
               owner_user_id, status, notes, ownership_type, created_at, updated_at
        FROM customers
        WHERE (? IS NULL OR owner_user_id = ?)
        ORDER BY customer_name COLLATE NOCASE;
      `;
      const ownerId = filters.ownerUserId || null;
      
      const { results: customerRows } = await db.prepare(sql).bind(ownerId, ownerId).all();
      if (!customerRows || customerRows.length === 0) {
        return [];
      }
      
      const placeholders = customerRows.map(() => '?').join(',');
      const contactsSql = `
        SELECT contact_id, customer_id, contact_name, position, email, phone, is_primary
        FROM customer_contacts
        WHERE customer_id IN (${placeholders})
        ORDER BY customer_id, is_primary DESC, contact_name COLLATE NOCASE
      `;
      const customerIds = customerRows.map(c => c.customer_id);
      const { results: contactRows } = await db.prepare(contactsSql).bind(...customerIds).all();
      
      const contactsByCustomerId = {};
      for (const cid of customerIds) {
        contactsByCustomerId[cid] = [];
      }
      for (const contact of contactRows || []) {
        contactsByCustomerId[contact.customer_id].push(contact);
      }
      
      return customerRows.map(c => {
        const contacts = contactsByCustomerId[c.customer_id] || [];
        return rowToCustomer(c, contacts);
      });
    },
    
    async listCustomerOwners() {
      const sql = `
        SELECT user_id, full_name, email, role
        FROM users
        WHERE status = 'ACTIVE' AND role = 'EXTERNAL_SALES'
        ORDER BY full_name COLLATE NOCASE ASC
      `;
      const { results } = await db.prepare(sql).all();
      return (results || []).map(r => ({
        id: r.user_id,
        name: r.full_name,
        email: r.email,
        role: r.role
      }));
    },
    
    async createCustomer(dto) {
      const customerId = dto.id || await nextCustomerId(db);
      const code = dto.code;
      const name = dto.name;
      const country = dto.country || '';
      const source = dto.source || 'DIRECT';
      let ownershipType = dto.ownershipType;
      if (ownershipType === undefined) {
        ownershipType = dto.ownerId ? 'ASSIGNED_SALES' : 'HOUSE_ACCOUNT';
      }
      let ownerId = dto.ownerId || null;
      
      if (ownershipType === 'ASSIGNED_SALES') {
        if (!ownerId || !String(ownerId).trim()) {
          throw new Error('Sales Owner is required for ASSIGNED_SALES account.');
        }
      } else {
        if (dto.ownershipType === 'HOUSE_ACCOUNT' && dto.ownerId) {
          throw new Error('Sales Owner must be empty for HOUSE_ACCOUNT account.');
        }
        ownerId = null;
      }
      
      const status = dto.status || 'ACTIVE_CUSTOMER';
      const notes = dto.notes || '';
      
      const batchStatements = [];
      
      batchStatements.push(
        db.prepare(`
          INSERT INTO customers (
            customer_id, customer_code, customer_name, country, source, owner_user_id, status, notes, ownership_type
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(customerId, code, name, country, source, ownerId, status, notes, ownershipType)
      );
      
      const contacts = normalizeContacts(dto.contacts || []);
      for (const contact of contacts) {
        const contactId = contact.id || `CONT-${crypto.randomUUID()}`;
        const contactName = contact.name;
        const position = contact.position;
        const email = contact.email;
        const phone = contact.phone;
        const isPrimary = contact.isPrimary ? 1 : 0;
        
        batchStatements.push(
          db.prepare(`
            INSERT INTO customer_contacts (
              contact_id, customer_id, contact_name, position, email, phone, is_primary
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(contactId, customerId, contactName, position, email, phone, isPrimary)
        );
      }
      
      await db.batch(batchStatements);
      
      return this.findCustomerById(customerId);
    },
    
    async updateCustomer(customerId, dto) {
      const current = await this.findCustomerById(customerId);
      if (!current) throw new Error('Customer not found.');

      let ownershipType = dto.ownershipType;
      if (ownershipType === undefined) {
        if (dto.ownerId !== undefined) {
          ownershipType = dto.ownerId ? 'ASSIGNED_SALES' : 'HOUSE_ACCOUNT';
        } else {
          ownershipType = current.ownershipType || 'HOUSE_ACCOUNT';
        }
      }
      if (!['ASSIGNED_SALES', 'HOUSE_ACCOUNT'].includes(ownershipType)) {
        throw new Error('Invalid ownershipType.');
      }

      let ownerId = dto.ownerId !== undefined ? dto.ownerId : current.ownerId;
      if (ownershipType === 'ASSIGNED_SALES') {
        if (!ownerId || !String(ownerId).trim()) {
          throw new Error('Sales Owner is required for ASSIGNED_SALES account.');
        }
      } else {
        ownerId = null;
      }

      const batchStatements = [];
      const fields = [];
      const params = [];
      
      if (dto.name !== undefined) {
        fields.push('customer_name = ?');
        params.push(dto.name);
      }
      if (dto.code !== undefined) {
        fields.push('customer_code = ?');
        params.push(dto.code);
      }
      if (dto.country !== undefined) {
        fields.push('country = ?');
        params.push(dto.country);
      }
      if (dto.source !== undefined) {
        fields.push('source = ?');
        params.push(dto.source);
      }
      
      // Always update both ownership_type and owner_user_id together if either changes
      if (dto.ownershipType !== undefined || dto.ownerId !== undefined) {
        fields.push('ownership_type = ?');
        params.push(ownershipType);
        fields.push('owner_user_id = ?');
        params.push(ownerId);
      }
      
      if (dto.status !== undefined) {
        fields.push('status = ?');
        params.push(dto.status);
      }
      if (dto.notes !== undefined) {
        fields.push('notes = ?');
        params.push(dto.notes);
      }
      
      if (fields.length > 0) {
        fields.push('updated_at = CURRENT_TIMESTAMP');
        const sql = `UPDATE customers SET ${fields.join(', ')} WHERE customer_id = ?`;
        params.push(customerId);
        batchStatements.push(db.prepare(sql).bind(...params));
      }
      
      if (dto.contacts !== undefined) {
        batchStatements.push(
          db.prepare('DELETE FROM customer_contacts WHERE customer_id = ?').bind(customerId)
        );
        
        const contacts = normalizeContacts(dto.contacts || []);
        for (const contact of contacts) {
          const contactId = contact.id || `CONT-${crypto.randomUUID()}`;
          const contactName = contact.name;
          const position = contact.position;
          const email = contact.email;
          const phone = contact.phone;
          const isPrimary = contact.isPrimary ? 1 : 0;
          
          batchStatements.push(
            db.prepare(`
              INSERT INTO customer_contacts (
                contact_id, customer_id, contact_name, position, email, phone, is_primary
              ) VALUES (?, ?, ?, ?, ?, ?, ?)
            `).bind(contactId, customerId, contactName, position, email, phone, isPrimary)
          );
        }
      }
      
      if (batchStatements.length > 0) {
        await db.batch(batchStatements);
      }
      
      return this.findCustomerById(customerId);
    }
  };
  
  return repo;
}
