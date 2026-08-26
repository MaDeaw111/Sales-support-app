import { createProductRepository } from './repository.js';
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

export function createProductHandler({ repo, resolveUser }) {
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

    // GET /api/products
    if (path === '/api/products' && method === 'GET') {
      const products = await repo.listProducts();
      return json({ status: 'SUCCESS', data: { products } });
    }

    // POST /api/products
    if (path === '/api/products' && method === 'POST') {
      if (!isAdmin && !isManager) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      try {
        const product = await repo.createProduct(body);
        return json({ status: 'SUCCESS', data: { product } });
      } catch (err) {
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: err.message }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // GET /api/spec-parameters
    if (path === '/api/spec-parameters' && method === 'GET') {
      const parameters = await repo.listParameters();
      return json({ status: 'SUCCESS', data: { parameters } });
    }

    // POST /api/spec-parameters
    if (path === '/api/spec-parameters' && method === 'POST') {
      if (!isAdmin && !isManager) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      try {
        const parameter = await repo.createParameter(body);
        return json({ status: 'SUCCESS', data: { parameter } });
      } catch (err) {
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: err.message }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // PUT /api/spec-parameters/:id
    const paramMatch = path.match(/^\/api\/spec-parameters\/([^/]+)$/);
    if (paramMatch && method === 'PUT') {
      if (!isAdmin && !isManager) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const paramId = paramMatch[1];
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      try {
        const parameter = await repo.updateParameter(paramId, body);
        return json({ status: 'SUCCESS', data: { parameter } });
      } catch (err) {
        if (err.message && err.message.includes('not found')) {
          return json({ status: 'ERROR', message: 'Parameter not found.' }, 404);
        }
        if (err.code === 'UNIQUE') {
          return json({ status: 'ERROR', message: err.message }, 409);
        }
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // Detail/Update matching /api/products/:id
    const productMatch = path.match(/^\/api\/products\/([^/]+)$/);
    if (productMatch) {
      const productId = productMatch[1];

      // GET /api/products/:id
      if (method === 'GET') {
        const product = await repo.findProductById(productId);
        if (!product) {
          return json({ status: 'ERROR', message: 'Product not found.' }, 404);
        }
        return json({ status: 'SUCCESS', data: { product } });
      }

      // PUT /api/products/:id
      if (method === 'PUT') {
        if (!isAdmin && !isManager) {
          return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
        }
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
        }

        try {
          const product = await repo.updateProduct(productId, body);
          return json({ status: 'SUCCESS', data: { product } });
        } catch (err) {
          if (err.message && err.message.includes('not found')) {
            return json({ status: 'ERROR', message: 'Product not found.' }, 404);
          }
          if (err.code === 'UNIQUE') {
            return json({ status: 'ERROR', message: err.message }, 409);
          }
          return json({ status: 'ERROR', message: err.message }, 400);
        }
      }
    }

    return json({ status: 'ERROR', message: 'Route not found.' }, 404);
  };
}

export function createProductHandlerFromEnv(env) {
  return createProductHandler({
    repo: createProductRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
