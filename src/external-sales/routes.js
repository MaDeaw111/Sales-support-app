import { createExternalSalesRepository } from './repository.js';
import { resolveAuthenticatedUser } from '../auth/routes.js';

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

export function createExternalSalesHandler({ repo, resolveUser }) {
  return async function handle(request, env) {
    const user = await resolveUser(request, env);
    if (!user) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const isReadAllowed = ['ADMIN', 'MANAGER', 'SALES_SUPPORT'].includes(user.role);
    const isWriteAllowed = ['ADMIN', 'MANAGER'].includes(user.role);

    // List
    if (path === '/api/external-sales' && method === 'GET') {
      if (!isReadAllowed) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const list = await repo.listExternalSales();
      return json({ status: 'SUCCESS', data: { externalSales: list } });
    }

    // Detail
    const detailMatch = path.match(/^\/api\/external-sales\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      if (!isReadAllowed) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const targetId = detailMatch[1];
      const sales = await repo.findExternalSalesById(targetId);
      if (!sales) {
        return json({ status: 'ERROR', message: 'External Sales profile not found.' }, 404);
      }
      return json({ status: 'SUCCESS', data: { externalSales: sales } });
    }

    // Create
    if (path === '/api/external-sales' && method === 'POST') {
      if (!isWriteAllowed) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim();
      const status = String(body.status || '').trim();

      if (!name) {
        return json({ status: 'ERROR', message: 'Name is required.' }, 400);
      }
      if (!email) {
        return json({ status: 'ERROR', message: 'Email is required.' }, 400);
      }
      if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
        return json({ status: 'ERROR', message: 'Invalid status.' }, 400);
      }

      try {
        const { user: created, tempPassword } = await repo.createExternalSales({ name, email, status });
        return json({ status: 'SUCCESS', data: { externalSales: created, tempPassword } });
      } catch (err) {
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: 'Email already exists.' }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // Update
    if (detailMatch && method === 'PUT') {
      if (!isWriteAllowed) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const targetId = detailMatch[1];
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim();
      const status = String(body.status || '').trim();
      const customerIds = body.customerIds;

      if (!name) {
        return json({ status: 'ERROR', message: 'Name is required.' }, 400);
      }
      if (!email) {
        return json({ status: 'ERROR', message: 'Email is required.' }, 400);
      }
      if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(status)) {
        return json({ status: 'ERROR', message: 'Invalid status.' }, 400);
      }
      if (customerIds !== undefined && !Array.isArray(customerIds)) {
        return json({ status: 'ERROR', message: 'Customer IDs must be an array.' }, 400);
      }

      try {
        const updated = await repo.updateExternalSales(targetId, { name, email, status, customerIds });
        return json({ status: 'SUCCESS', data: { externalSales: updated } });
      } catch (err) {
        if (err.message && err.message.includes('not found')) {
          return json({ status: 'ERROR', message: 'External Sales profile not found.' }, 404);
        }
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: 'Email already exists.' }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    return json({ status: 'ERROR', message: 'Route not found.' }, 404);
  };
}

export function createExternalSalesHandlerFromEnv(env) {
  return createExternalSalesHandler({
    repo: createExternalSalesRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
