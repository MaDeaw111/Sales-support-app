import crypto from 'node:crypto';

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
    async findCustomerById(customerId) {
      const customerRow = await db.prepare(`
        SELECT customer_id, customer_code, customer_name, country, source, owner_user_id, status, notes, created_at, updated_at
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
               owner_user_id, status, notes, created_at, updated_at
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
    
    async createCustomer(dto) {
      const customerId = dto.id || await nextCustomerId(db);
      const code = dto.code;
      const name = dto.name;
      const country = dto.country || '';
      const source = dto.source || 'DIRECT';
      const ownerId = dto.ownerId || null;
      const status = dto.status || 'ACTIVE_CUSTOMER';
      const notes = dto.notes || '';
      
      await db.prepare(`
        INSERT INTO customers (
          customer_id, customer_code, customer_name, country, source, owner_user_id, status, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(customerId, code, name, country, source, ownerId, status, notes).run();
      
      const contacts = normalizeContacts(dto.contacts || []);
      for (const contact of contacts) {
        const contactId = contact.id || `CONT-${crypto.randomUUID()}`;
        const contactName = contact.name;
        const position = contact.position;
        const email = contact.email;
        const phone = contact.phone;
        const isPrimary = contact.isPrimary ? 1 : 0;
        
        await db.prepare(`
          INSERT INTO customer_contacts (
            contact_id, customer_id, contact_name, position, email, phone, is_primary
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(contactId, customerId, contactName, position, email, phone, isPrimary).run();
      }
      
      return this.findCustomerById(customerId);
    },
    
    async updateCustomer(customerId, dto) {
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
      if (dto.ownerId !== undefined) {
        fields.push('owner_user_id = ?');
        params.push(dto.ownerId);
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
