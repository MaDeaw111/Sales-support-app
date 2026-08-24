import { hashPassword } from '../auth/crypto.js';

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

async function nextUserId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(user_id, 5) AS INTEGER)), 0) AS max_id
    FROM users
    WHERE user_id GLOB 'USR-[0-9]*'
  `).first();
  return `USR-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

export function createExternalSalesRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');
  
  return {
    async listExternalSales() {
      const usersSql = `
        SELECT user_id, full_name, email, role, status
        FROM users
        WHERE role = 'EXTERNAL_SALES'
        ORDER BY full_name COLLATE NOCASE ASC
      `;
      const { results: userRows } = await db.prepare(usersSql).all();
      
      const customersSql = `
        SELECT customer_id, owner_user_id
        FROM customers
        WHERE owner_user_id IS NOT NULL
      `;
      const { results: customerRows } = await db.prepare(customersSql).all();
      
      const customerIdsByOwner = {};
      for (const row of customerRows || []) {
        if (!customerIdsByOwner[row.owner_user_id]) {
          customerIdsByOwner[row.owner_user_id] = [];
        }
        customerIdsByOwner[row.owner_user_id].push(row.customer_id);
      }
      
      return (userRows || []).map(r => ({
        id: r.user_id,
        name: r.full_name,
        email: r.email,
        role: r.role,
        status: r.status,
        customerIds: customerIdsByOwner[r.user_id] || []
      }));
    },
    
    async findExternalSalesById(id) {
      const user = await db.prepare(`
        SELECT user_id, full_name, email, role, status
        FROM users
        WHERE user_id = ? AND role = 'EXTERNAL_SALES'
        LIMIT 1
      `).bind(id).first();
      if (!user) return null;
      
      const { results: customerRows } = await db.prepare(`
        SELECT customer_id
        FROM customers
        WHERE owner_user_id = ?
      `).bind(id).all();
      
      return {
        id: user.user_id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status,
        customerIds: (customerRows || []).map(c => c.customer_id)
      };
    },
    
    async createExternalSales(dto) {
      if (!dto.name || !dto.email || !dto.status) {
        throw new Error('Name, email, and status are required.');
      }
      
      const existing = await db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) LIMIT 1').bind(dto.email).first();
      if (existing) {
        const err = new Error('Email already exists.');
        err.code = 'UNIQUE';
        throw err;
      }

      const cids = dto.customerIds;
      if (cids !== undefined && !Array.isArray(cids)) {
        throw new Error('Customer IDs must be an array.');
      }

      if (cids && cids.length > 0) {
        const uniqueCids = Array.from(new Set(cids));
        const placeholders = uniqueCids.map(() => '?').join(',');
        const { results: found } = await db.prepare(`
          SELECT customer_id FROM customers WHERE customer_id IN (${placeholders})
        `).bind(...uniqueCids).all();
        if ((found || []).length !== uniqueCids.length) {
          throw new Error('One or more customer IDs are invalid.');
        }
      }
      
      const tempPassword = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
      const { hash, salt, iterations } = await hashPassword(tempPassword);
      
      const userId = await nextUserId(db);
      const batchStatements = [];

      batchStatements.push(db.prepare(`
        INSERT INTO users (
          user_id, full_name, email, role, customer_scope, status,
          password_hash, password_salt, password_iterations, must_change_password
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).bind(userId, dto.name, dto.email, 'EXTERNAL_SALES', 'OWN_CUSTOMERS', dto.status, hash, salt, iterations));

      if (cids && cids.length > 0) {
        const uniqueCids = Array.from(new Set(cids));
        for (const cid of uniqueCids) {
          batchStatements.push(db.prepare(`
            UPDATE customers
            SET owner_user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
          `).bind(userId, cid));
        }
      }

      await db.batch(batchStatements);
      
      const created = await this.findExternalSalesById(userId);
      return { user: created, tempPassword };
    },
    
    async updateExternalSales(id, dto) {
      const user = await db.prepare('SELECT 1 FROM users WHERE user_id = ? AND role = \'EXTERNAL_SALES\' LIMIT 1').bind(id).first();
      if (!user) {
        throw new Error('External Sales user not found.');
      }
      
      if (dto.email) {
        const emailConflict = await db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) AND user_id <> ? LIMIT 1').bind(dto.email, id).first();
        if (emailConflict) {
          const err = new Error('Email already exists.');
          err.code = 'UNIQUE';
          throw err;
        }
      }
      
      if (dto.customerIds && dto.customerIds.length > 0) {
        const placeholders = dto.customerIds.map(() => '?').join(',');
        const { results: found } = await db.prepare(`
          SELECT customer_id FROM customers WHERE customer_id IN (${placeholders})
        `).bind(...dto.customerIds).all();
        if ((found || []).length !== dto.customerIds.length) {
          throw new Error('One or more customer IDs are invalid.');
        }
      }
      
      const batchStatements = [];
      
      batchStatements.push(db.prepare(`
        UPDATE users
        SET full_name = ?, email = ?, status = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ? AND role = 'EXTERNAL_SALES'
      `).bind(dto.name, dto.email, dto.status, id));
      
      if (dto.customerIds !== undefined) {
        batchStatements.push(db.prepare(`
          UPDATE customers
          SET owner_user_id = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE owner_user_id = ?
        `).bind(id));
        
        for (const cid of dto.customerIds) {
          batchStatements.push(db.prepare(`
            UPDATE customers
            SET owner_user_id = ?, updated_at = CURRENT_TIMESTAMP
            WHERE customer_id = ?
          `).bind(id, cid));
        }
      }
      
      await db.batch(batchStatements);
      return this.findExternalSalesById(id);
    }
  };
}
