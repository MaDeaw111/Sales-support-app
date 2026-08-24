import { createCustomerRepository } from './repository.js';
import { resolveAuthenticatedUser } from '../auth/routes.js';

const FULL_ACCESS_ROLES = new Set(['ADMIN', 'MANAGER', 'SALES_SUPPORT']);

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

export function canMutateCustomers(user) {
  return FULL_ACCESS_ROLES.has(user.role);
}

export function customerOwnerFilter(user) {
  if (FULL_ACCESS_ROLES.has(user.role)) return null;
  if (user.role === 'EXTERNAL_SALES') return user.user_id;
  return '__NO_ACCESS__';
}

export function createCustomerHandler({ repo, resolveUser }) {
  return async function handle(request, env) {
    const user = await resolveUser(request, env);
    if (!user) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }
    
    const ownerFilter = customerOwnerFilter(user);
    const url = new URL(request.url);
    const path = url.pathname;
    
    if (path === '/api/customers' && request.method === 'GET') {
      if (ownerFilter === '__NO_ACCESS__') {
        return json({ status: 'SUCCESS', data: [] });
      }
      const customers = await repo.listCustomers(ownerFilter ? { ownerUserId: ownerFilter } : {});
      return json({ status: 'SUCCESS', data: customers });
    }
    
    if (path === '/api/customers' && request.method === 'POST') {
      if (ownerFilter === '__NO_ACCESS__') {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      
      const body = await readJson(request);
      if (!body || !body.name || !body.code) {
        return json({ status: 'ERROR', message: 'Name and code are required.' }, 400);
      }
      
      const name = String(body.name).trim();
      const code = String(body.code).trim();
      if (!name || !code) {
        return json({ status: 'ERROR', message: 'Name and code are required.' }, 400);
      }
      
      let ownerId = body.ownerId || null;
      if (user.role === 'EXTERNAL_SALES') {
        if (ownerId && ownerId !== user.user_id) {
          return json({ status: 'ERROR', message: 'External sales agent cannot assign ownership to another user.' }, 400);
        }
        ownerId = user.user_id;
      }
      
      try {
        const created = await repo.createCustomer({
          name,
          code,
          country: body.country,
          source: body.source,
          ownerId,
          status: body.status,
          notes: body.notes,
          contacts: body.contacts
        });
        return json({ status: 'SUCCESS', data: created }, 200);
      } catch (err) {
        if (err.message && err.message.includes('UNIQUE constraint failed')) {
          return json({ status: 'ERROR', message: 'Customer code already exists.' }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 500);
      }
    }
    
    const match = path.match(/^\/api\/customers\/([^/]+)$/);
    if (match) {
      const customerId = match[1];
      
      if (request.method === 'GET') {
        const customer = await repo.findCustomerById(customerId);
        if (!customer) {
          return json({ status: 'ERROR', message: 'Customer not found.' }, 404);
        }
        
        if (ownerFilter === '__NO_ACCESS__') {
          return json({ status: 'ERROR', message: 'Customer not found.' }, 404);
        }
        if (ownerFilter && customer.ownerId !== ownerFilter) {
          return json({ status: 'ERROR', message: 'Customer not found.' }, 404);
        }
        
        return json({ status: 'SUCCESS', data: customer });
      }
      
      if (request.method === 'PUT') {
        if (ownerFilter === '__NO_ACCESS__') {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        
        const customer = await repo.findCustomerById(customerId);
        if (!customer) {
          return json({ status: 'ERROR', message: 'Customer not found.' }, 404);
        }
        
        if (ownerFilter && customer.ownerId !== ownerFilter) {
          return json({ status: 'ERROR', message: 'Customer not found.' }, 404);
        }
        
        const body = await readJson(request);
        if (user.role === 'EXTERNAL_SALES') {
          if (body && body.ownerId !== undefined && body.ownerId !== user.user_id) {
            return json({ status: 'ERROR', message: 'External sales agent cannot assign ownership to another user.' }, 400);
          }
          if (body) {
            body.ownerId = user.user_id; // enforce
          }
        }
        
        try {
          const updated = await repo.updateCustomer(customerId, body);
          return json({ status: 'SUCCESS', data: updated });
        } catch (err) {
          if (err.message && err.message.includes('UNIQUE constraint failed')) {
            return json({ status: 'ERROR', message: 'Customer code already exists.' }, 409);
          }
          return json({ status: 'ERROR', message: err.message }, 500);
        }
      }
    }
    
    return json({ status: 'ERROR', message: 'Route not found.' }, 404);
  };
}

export function createCustomerHandlerFromEnv(env) {
  return createCustomerHandler({
    repo: createCustomerRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
