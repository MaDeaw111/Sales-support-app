export function createAuthRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');
  return {
    async findUserByEmail(email) {
      return db.prepare(`
        SELECT user_id, full_name, email, role, customer_scope, status,
               password_hash, password_salt, password_iterations, must_change_password
        FROM users
        WHERE lower(email) = lower(?)
        LIMIT 1
      `).bind(email).first();
    },

    async createSession(record) {
      await db.prepare(`
        INSERT INTO sessions (
          session_id, user_id, token_hash, expires_at, created_at, last_seen_at, user_agent, ip_address
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        record.session_id,
        record.user_id,
        record.token_hash,
        record.expires_at,
        record.created_at,
        record.last_seen_at,
        record.user_agent || '',
        record.ip_address || ''
      ).run();
    },

    async findSessionUserByTokenHash(tokenHash, nowIso) {
      return db.prepare(`
        SELECT u.user_id, u.full_name, u.email, u.role, u.customer_scope, u.status,
               u.password_hash, u.password_salt, u.password_iterations, u.must_change_password,
               s.session_id, s.expires_at
        FROM sessions s
        JOIN users u ON u.user_id = s.user_id
        WHERE s.token_hash = ?
          AND s.expires_at > ?
          AND u.status = 'ACTIVE'
        LIMIT 1
      `).bind(tokenHash, nowIso).first();
    },

    async deleteSessionByTokenHash(tokenHash) {
      await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run();
    },

    async updatePassword(userId, record) {
      await db.prepare(`
        UPDATE users
        SET password_hash = ?, password_salt = ?, password_iterations = ?,
            must_change_password = 0, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ?
      `).bind(record.hash, record.salt, record.iterations, userId).run();
    },

    async deleteOtherSessions(userId, keepSessionId) {
      await db.prepare('DELETE FROM sessions WHERE user_id = ? AND session_id <> ?')
        .bind(userId, keepSessionId)
        .run();
    },

    async touchSession(sessionId, nowIso) {
      await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_id = ?')
        .bind(nowIso, sessionId)
        .run();
    }
  };
}
