import { createAuthRepository } from './repository.js';
import { createSessionToken, hashPassword, hashSessionToken, verifyPassword } from './crypto.js';

const COOKIE_NAME = 'wcat_session';
const SESSION_MS = 12 * 60 * 60 * 1000;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extraHeaders }
  });
}

function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return '';
}

function sessionCookie(token, maxAgeSeconds = Math.floor(SESSION_MS / 1000)) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

function publicUser(row) {
  return {
    user_id: row.user_id,
    full_name: row.full_name,
    email: row.email,
    role: row.role,
    customer_scope: row.customer_scope,
    must_change_password: !!Number(row.must_change_password)
  };
}

function passwordRecord(row) {
  return {
    hash: row.password_hash,
    salt: row.password_salt,
    iterations: Number(row.password_iterations)
  };
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

export function createAuthHandler({ repo, now = () => new Date() }) {
  async function currentSession(request) {
    const token = getCookie(request, COOKIE_NAME);
    if (!token) return null;
    const tokenHash = await hashSessionToken(token);
    const nowIso = now().toISOString();
    const row = await repo.findSessionUserByTokenHash(tokenHash, nowIso);
    if (!row) return null;
    await repo.touchSession(row.session_id, nowIso);
    return { token, tokenHash, row };
  }

  return async function handle(request) {
    const url = new URL(request.url);

    if (url.pathname === '/api/auth/login' && request.method === 'POST') {
      const body = await readJson(request);
      const email = String(body?.email || '').trim();
      const password = String(body?.password || '');
      if (!email || !password) return json({ status: 'ERROR', message: 'Email and password are required.' }, 400);

      const user = await repo.findUserByEmail(email);
      if (!user || user.status !== 'ACTIVE' || !(await verifyPassword(password, passwordRecord(user)))) {
        return json({ status: 'ERROR', message: 'Invalid email or password.' }, 401);
      }

      const token = createSessionToken();
      const tokenHash = await hashSessionToken(token);
      const created = now();
      const expires = new Date(created.getTime() + SESSION_MS);
      await repo.createSession({
        session_id: `SES-${crypto.randomUUID()}`,
        user_id: user.user_id,
        token_hash: tokenHash,
        expires_at: expires.toISOString(),
        created_at: created.toISOString(),
        last_seen_at: created.toISOString(),
        user_agent: request.headers.get('user-agent') || '',
        ip_address: request.headers.get('cf-connecting-ip') || ''
      });
      return json(
        { status: 'SUCCESS', data: { user: publicUser(user) } },
        200,
        { 'set-cookie': sessionCookie(token) }
      );
    }

    if (url.pathname === '/api/auth/me' && request.method === 'GET') {
      const session = await currentSession(request);
      if (!session) {
        return json(
          { status: 'ERROR', message: 'Authentication required.', data: { valid: false } },
          401,
          { 'set-cookie': clearSessionCookie() }
        );
      }
      return json({ status: 'SUCCESS', data: { valid: true, user: publicUser(session.row) } });
    }

    if (url.pathname === '/api/auth/logout' && request.method === 'POST') {
      const token = getCookie(request, COOKIE_NAME);
      if (token) await repo.deleteSessionByTokenHash(await hashSessionToken(token));
      return json({ status: 'SUCCESS', data: { signed_out: true } }, 200, { 'set-cookie': clearSessionCookie() });
    }

    if (url.pathname === '/api/auth/change-password' && request.method === 'POST') {
      const session = await currentSession(request);
      if (!session) return json({ status: 'ERROR', message: 'Authentication required.' }, 401, { 'set-cookie': clearSessionCookie() });
      const body = await readJson(request);
      const currentPassword = String(body?.current_password || '');
      const newPassword = String(body?.new_password || '');
      if (!currentPassword || !newPassword) return json({ status: 'ERROR', message: 'Current and new password are required.' }, 400);
      if (newPassword.length < 8) return json({ status: 'ERROR', message: 'New password must be at least 8 characters.' }, 400);
      if (!(await verifyPassword(currentPassword, passwordRecord(session.row)))) {
        return json({ status: 'ERROR', message: 'Current password is incorrect.' }, 401);
      }
      const nextRecord = await hashPassword(newPassword);
      await repo.updatePassword(session.row.user_id, nextRecord);
      await repo.deleteOtherSessions(session.row.user_id, session.row.session_id);
      const updated = { ...session.row, must_change_password: 0 };
      return json({ status: 'SUCCESS', data: { user: publicUser(updated) } });
    }

    return json({ status: 'ERROR', message: 'Auth route not found.' }, 404);
  };
}

export function createAuthHandlerFromEnv(env) {
  return createAuthHandler({ repo: createAuthRepository(env.DB) });
}
