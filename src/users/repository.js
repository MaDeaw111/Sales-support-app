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

export function createUserRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listUsers() {
      const { results } = await db.prepare(`
        SELECT user_id, full_name, email, role, customer_scope, status, must_change_password
        FROM users
        ORDER BY full_name COLLATE NOCASE ASC
      `).all();

      return (results || []).map(r => ({
        id: r.user_id,
        name: r.full_name,
        email: r.email,
        role: r.role,
        status: r.status,
        customerScope: r.customer_scope,
        mustChangePassword: !!Number(r.must_change_password)
      }));
    },

    async findUserById(id) {
      const user = await db.prepare(`
        SELECT user_id, full_name, email, role, customer_scope, status, must_change_password
        FROM users
        WHERE user_id = ?
        LIMIT 1
      `).bind(id).first();

      if (!user) return null;

      return {
        id: user.user_id,
        name: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status,
        customerScope: user.customer_scope,
        mustChangePassword: !!Number(user.must_change_password)
      };
    },

    async createUser(dto) {
      if (!dto.name || !dto.email || !dto.role || !dto.status) {
        throw new Error('Name, email, role, and status are required.');
      }

      // Check unique email case-insensitively
      const existing = await db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) LIMIT 1').bind(dto.email).first();
      if (existing) {
        const err = new Error('Email already exists.');
        err.code = 'UNIQUE';
        throw err;
      }

      const tempPassword = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
      const { hash, salt, iterations } = await hashPassword(tempPassword);
      const userId = await nextUserId(db);

      await db.prepare(`
        INSERT INTO users (
          user_id, full_name, email, role, customer_scope, status,
          password_hash, password_salt, password_iterations, must_change_password
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
      `).bind(userId, dto.name, dto.email, dto.role, dto.customerScope || 'NONE', dto.status, hash, salt, iterations).run();

      const created = await this.findUserById(userId);
      return { user: created, tempPassword };
    },

    async updateUser(id, dto) {
      const currentUser = await db.prepare('SELECT role, status FROM users WHERE user_id = ?').bind(id).first();
      if (!currentUser) {
        throw new Error('User not found.');
      }

      if (!dto.name || !dto.email || !dto.role || !dto.status) {
        throw new Error('Name, email, role, and status are required.');
      }

      // Check duplicate email
      const emailConflict = await db.prepare('SELECT 1 FROM users WHERE lower(email) = lower(?) AND user_id <> ? LIMIT 1').bind(dto.email, id).first();
      if (emailConflict) {
        const err = new Error('Email already exists.');
        err.code = 'UNIQUE';
        throw err;
      }

      // Self lockout protection: cannot disable/suspend or demote the last active ADMIN
      if (currentUser.role === 'ADMIN' && currentUser.status === 'ACTIVE') {
        const activeAdmins = await db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'ADMIN' AND status = 'ACTIVE'").first();
        if (Number(activeAdmins?.count || 0) <= 1) {
          if (dto.role !== 'ADMIN') {
            throw new Error('Cannot demote the last active Admin.');
          }
          if (dto.status !== 'ACTIVE') {
            throw new Error('Cannot deactivate or suspend the last active Admin.');
          }
        }
      }

      // External Sales role change block if customers are assigned
      if (currentUser.role === 'EXTERNAL_SALES' && dto.role !== 'EXTERNAL_SALES') {
        const assigned = await db.prepare('SELECT COUNT(*) as count FROM customers WHERE owner_user_id = ?').bind(id).first();
        if (Number(assigned?.count || 0) > 0) {
          throw new Error('Cannot change role of External Sales user while they have assigned customers.');
        }
      }

      await db.prepare(`
        UPDATE users
        SET full_name = ?, email = ?, role = ?, status = ?, customer_scope = ?, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).bind(dto.name, dto.email, dto.role, dto.status, dto.customerScope || 'NONE', id).run();

      return this.findUserById(id);
    },

    async resetPassword(id) {
      const user = await this.findUserById(id);
      if (!user) {
        throw new Error('User not found.');
      }

      const tempPassword = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(12)));
      const { hash, salt, iterations } = await hashPassword(tempPassword);

      const batchStatements = [];

      // Update password hash/salt & force change password
      batchStatements.push(db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, password_iterations = ?, must_change_password = 1, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).bind(hash, salt, iterations, id));

      // Delete target user sessions
      batchStatements.push(db.prepare(`
        DELETE FROM sessions WHERE user_id = ?
      `).bind(id));

      await db.batch(batchStatements);

      const updated = await this.findUserById(id);
      return { user: updated, tempPassword };
    }
  };
}
