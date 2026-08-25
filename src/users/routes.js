import { createUserRepository } from './repository.js';
import { resolveAuthenticatedUser } from '../auth/routes.js';

const ALLOWED_ROLES = new Set(['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXTERNAL_SALES', 'EXPORT', 'PRODUCTION_WAREHOUSE']);
const ALLOWED_STATUSES = new Set(['ACTIVE', 'INACTIVE', 'SUSPENDED']);
const ALLOWED_SCOPES = new Set(['ALL', 'OWN_CUSTOMERS', 'NONE']);

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

export function createUserHandler({ repo, resolveUser }) {
  return async function handle(request, env) {
    const caller = await resolveUser(request, env);
    if (!caller) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const isAdmin = caller.role === 'ADMIN';
    const isManager = caller.role === 'MANAGER';

    // GET /api/users (List)
    if (path === '/api/users' && method === 'GET') {
      if (!isAdmin && !isManager) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const users = await repo.listUsers();
      return json({ status: 'SUCCESS', data: { users } });
    }

    // POST /api/users (Create)
    if (path === '/api/users' && method === 'POST') {
      if (!isAdmin) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const role = String(body.role || '').trim().toUpperCase();
      const status = String(body.status || '').trim().toUpperCase();
      const customerScope = String(body.customerScope || 'NONE').trim().toUpperCase();

      if (!name) return json({ status: 'ERROR', message: 'Name is required.' }, 400);
      if (!email) return json({ status: 'ERROR', message: 'Email is required.' }, 400);
      if (!ALLOWED_ROLES.has(role)) return json({ status: 'ERROR', message: 'Invalid role.' }, 400);
      if (!ALLOWED_STATUSES.has(status)) return json({ status: 'ERROR', message: 'Invalid status.' }, 400);
      if (!ALLOWED_SCOPES.has(customerScope)) return json({ status: 'ERROR', message: 'Invalid customer scope.' }, 400);

      try {
        const { user: created, tempPassword } = await repo.createUser({
          name,
          email,
          role,
          status,
          customerScope
        });
        return json({ status: 'SUCCESS', data: { user: created, temporaryPassword: tempPassword } });
      } catch (err) {
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: 'Email already exists.' }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // Detail & Update matching `/api/users/:id`
    const detailMatch = path.match(/^\/api\/users\/([^/]+)$/);
    if (detailMatch) {
      const targetId = detailMatch[1];

      // GET /api/users/:id
      if (method === 'GET') {
        if (!isAdmin && !isManager) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        const user = await repo.findUserById(targetId);
        if (!user) {
          return json({ status: 'ERROR', message: 'User not found.' }, 404);
        }
        return json({ status: 'SUCCESS', data: { user } });
      }

      // PUT /api/users/:id
      if (method === 'PUT') {
        if (!isAdmin) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
        }

        const name = String(body.name || '').trim();
        const email = String(body.email || '').trim().toLowerCase();
        const role = String(body.role || '').trim().toUpperCase();
        const status = String(body.status || '').trim().toUpperCase();
        const customerScope = String(body.customerScope || 'NONE').trim().toUpperCase();

        if (!name) return json({ status: 'ERROR', message: 'Name is required.' }, 400);
        if (!email) return json({ status: 'ERROR', message: 'Email is required.' }, 400);
        if (!ALLOWED_ROLES.has(role)) return json({ status: 'ERROR', message: 'Invalid role.' }, 400);
        if (!ALLOWED_STATUSES.has(status)) return json({ status: 'ERROR', message: 'Invalid status.' }, 400);
        if (!ALLOWED_SCOPES.has(customerScope)) return json({ status: 'ERROR', message: 'Invalid customer scope.' }, 400);

        try {
          const updated = await repo.updateUser(targetId, {
            name,
            email,
            role,
            status,
            customerScope
          });
          return json({ status: 'SUCCESS', data: { user: updated } });
        } catch (err) {
          if (err.message && err.message.includes('not found')) {
            return json({ status: 'ERROR', message: 'User not found.' }, 404);
          }
          if (err.code === 'UNIQUE') {
            return json({ status: 'ERROR', message: 'Email already exists.' }, 409);
          }
          return json({ status: 'ERROR', message: err.message }, 400);
        }
      }
    }

    // Reset Password matching `/api/users/:id/reset-password`
    const resetMatch = path.match(/^\/api\/users\/([^/]+)\/reset-password$/);
    if (resetMatch && method === 'POST') {
      if (!isAdmin) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const targetId = resetMatch[1];
      try {
        const { user: updated, tempPassword } = await repo.resetPassword(targetId);
        return json({ status: 'SUCCESS', data: { user: updated, temporaryPassword: tempPassword } });
      } catch (err) {
        if (err.message && err.message.includes('not found')) {
          return json({ status: 'ERROR', message: 'User not found.' }, 404);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    return json({ status: 'ERROR', message: 'Route not found.' }, 404);
  };
}

export function createUserHandlerFromEnv(env) {
  return createUserHandler({
    repo: createUserRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
