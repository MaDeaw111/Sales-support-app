import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword, hashSessionToken } from '../src/auth/crypto.js';
import { createAuthHandler, resolveAuthenticatedUser } from '../src/auth/routes.js';

function makeUser(passwordRecord) {
  return {
    user_id: 'USR-TEST-1',
    full_name: 'Test Admin',
    email: 'admin@example.com',
    role: 'ADMIN',
    customer_scope: 'ALL',
    status: 'ACTIVE',
    password_hash: passwordRecord.hash,
    password_salt: passwordRecord.salt,
    password_iterations: passwordRecord.iterations,
    must_change_password: 1
  };
}

class MemoryRepo {
  constructor(user) {
    this.user = user;
    this.sessions = new Map();
  }
  async findUserByEmail(email) {
    return email.toLowerCase() === this.user.email.toLowerCase() ? { ...this.user } : null;
  }
  async createSession(record) { this.sessions.set(record.token_hash, { ...record }); }
  async findSessionUserByTokenHash(tokenHash, nowIso) {
    const session = this.sessions.get(tokenHash);
    if (!session || session.expires_at <= nowIso || this.user.status !== 'ACTIVE') return null;
    return { ...this.user, session_id: session.session_id, expires_at: session.expires_at };
  }
  async deleteSessionByTokenHash(tokenHash) { this.sessions.delete(tokenHash); }
  async updatePassword(userId, record) {
    assert.equal(userId, this.user.user_id);
    this.user.password_hash = record.hash;
    this.user.password_salt = record.salt;
    this.user.password_iterations = record.iterations;
    this.user.must_change_password = 0;
  }
  async deleteOtherSessions(userId, keepSessionId) {
    assert.equal(userId, this.user.user_id);
    for (const [hash, session] of this.sessions) {
      if (session.session_id !== keepSessionId) this.sessions.delete(hash);
    }
  }
  async touchSession() {}
}

function jsonRequest(path, body, cookie = '') {
  return new Request(`https://example.com${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(cookie ? { cookie } : {})
    },
    body: JSON.stringify(body)
  });
}

function extractCookie(response) {
  const raw = response.headers.get('set-cookie') || '';
  const pair = raw.split(';')[0];
  return { raw, pair };
}

test('login creates HttpOnly secure session cookie and returns user', async () => {
  const user = makeUser(await hashPassword('Password123!'));
  const repo = new MemoryRepo(user);
  const handler = createAuthHandler({ repo, now: () => new Date('2026-08-24T03:00:00Z') });
  const response = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'Password123!' }));
  assert.equal(response.status, 200);
  const cookie = extractCookie(response);
  assert.match(cookie.raw, /^wcat_session=/);
  assert.match(cookie.raw, /HttpOnly/i);
  assert.match(cookie.raw, /Secure/i);
  assert.match(cookie.raw, /SameSite=Lax/i);
  const body = await response.json();
  assert.equal(body.status, 'SUCCESS');
  assert.equal(body.data.user.email, user.email);
  assert.equal(body.data.user.must_change_password, true);
  assert.equal(body.data.user.password_hash, undefined);
});

test('login rejects invalid password without creating a session', async () => {
  const user = makeUser(await hashPassword('Password123!'));
  const repo = new MemoryRepo(user);
  const handler = createAuthHandler({ repo });
  const response = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'wrong-password' }));
  assert.equal(response.status, 401);
  assert.equal(repo.sessions.size, 0);
});

test('me validates session cookie and returns current user', async () => {
  const user = makeUser(await hashPassword('Password123!'));
  const repo = new MemoryRepo(user);
  const now = () => new Date('2026-08-24T03:00:00Z');
  const handler = createAuthHandler({ repo, now });
  const login = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'Password123!' }));
  const cookie = extractCookie(login).pair;
  const response = await handler(new Request('https://example.com/api/auth/me', { headers: { cookie } }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.valid, true);
});

test('logout deletes active session and clears cookie', async () => {
  const user = makeUser(await hashPassword('Password123!'));
  const repo = new MemoryRepo(user);
  const handler = createAuthHandler({ repo });
  const login = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'Password123!' }));
  const cookie = extractCookie(login).pair;
  assert.equal(repo.sessions.size, 1);
  const response = await handler(new Request('https://example.com/api/auth/logout', { method: 'POST', headers: { cookie } }));
  assert.equal(response.status, 200);
  assert.equal(repo.sessions.size, 0);
  assert.match(response.headers.get('set-cookie') || '', /Max-Age=0/);
});

test('change-password verifies current password, clears forced-change flag, and keeps current session', async () => {
  const user = makeUser(await hashPassword('Password123!'));
  const repo = new MemoryRepo(user);
  const handler = createAuthHandler({ repo });
  const login = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'Password123!' }));
  const cookie = extractCookie(login).pair;
  const response = await handler(jsonRequest('/api/auth/change-password', {
    current_password: 'Password123!',
    new_password: 'NewPassword456!'
  }, cookie));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.user.must_change_password, false);
  assert.equal(repo.sessions.size, 1);

  const oldLogin = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'Password123!' }));
  assert.equal(oldLogin.status, 401);
  const newLogin = await handler(jsonRequest('/api/auth/login', { email: user.email, password: 'NewPassword456!' }));
  assert.equal(newLogin.status, 200);
});

test('resolveAuthenticatedUser resolves current user from valid cookie and returns null for missing or expired sessions', async () => {
  const db = new DatabaseSync(':memory:');
  const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(sql);

  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('USR-0001', 'Milan Wolff', 'm.wolff@meelunie.com', 'ADMIN', 'ALL', 'hash', 'salt');

  const validToken = 'valid-token';
  const validTokenHash = await hashSessionToken(validToken);
  const expiredToken = 'expired-token';
  const expiredTokenHash = await hashSessionToken(expiredToken);

  const futureIso = new Date(Date.now() + 1000000).toISOString();
  const pastIso = new Date(Date.now() - 1000000).toISOString();

  db.prepare(`
    INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('SES-1', 'USR-0001', validTokenHash, futureIso);

  db.prepare(`
    INSERT INTO sessions (session_id, user_id, token_hash, expires_at)
    VALUES (?, ?, ?, ?)
  `).run('SES-2', 'USR-0001', expiredTokenHash, pastIso);

  const wrappedDb = {
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
    }
  };

  const env = { DB: wrappedDb };

  const req1 = new Request('https://example.com/api/some-endpoint', {
    headers: { cookie: `wcat_session=${validToken}` }
  });
  const user = await resolveAuthenticatedUser(req1, env);
  assert.ok(user);
  assert.equal(user.user_id, 'USR-0001');
  assert.equal(user.full_name, 'Milan Wolff');
  assert.equal(user.email, 'm.wolff@meelunie.com');
  assert.equal(user.role, 'ADMIN');
  assert.equal(user.customer_scope, 'ALL');
  assert.equal(user.password_hash, 'hash');

  const req2 = new Request('https://example.com/api/some-endpoint', {
    headers: { cookie: `wcat_session=${expiredToken}` }
  });
  const userExpired = await resolveAuthenticatedUser(req2, env);
  assert.equal(userExpired, null);

  const req3 = new Request('https://example.com/api/some-endpoint');
  const userMissing = await resolveAuthenticatedUser(req3, env);
  assert.equal(userMissing, null);
});
