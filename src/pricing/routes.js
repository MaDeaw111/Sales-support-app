import { createPricingRepository } from './repository.js';
import { resolveAuthenticatedUser } from '../auth/routes.js';

const PRICING_READ_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXTERNAL_SALES', 'EXPORT'];
const PRICING_MANAGE_ROLES = ['ADMIN', 'MANAGER'];
const SPECIAL_PRICE_REQUEST_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXTERNAL_SALES'];

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

export function createPricingHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createPricingRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // GET /api/pricing
    if (path === '/api/pricing' && method === 'GET') {
      if (!PRICING_READ_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const [standardPrices, specialPrices] = await Promise.all([
        activeRepo.listActiveProductStandardPrices(),
        activeRepo.listSpecialPrices(caller)
      ]);
      return json({ status: 'SUCCESS', data: { standardPrices, specialPrices } });
    }

    // PUT /api/pricing/standard/:productId
    const stdProductMatch = path.match(/^\/api\/pricing\/standard\/([^/]+)$/);
    if (stdProductMatch && method === 'PUT') {
      if (!PRICING_MANAGE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      try {
        const standardPrice = await activeRepo.setStandardPrice(
          decodeURIComponent(stdProductMatch[1]),
          body,
          caller.user_id || caller.id
        );
        return json({ status: 'SUCCESS', data: { standardPrice } });
      } catch (err) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'MIGRATION_REQUIRED' ? 503 : 400;
        return json({ status: 'ERROR', message: err.message }, status);
      }
    }

    // POST /api/pricing/standard
    if (path === '/api/pricing/standard' && method === 'POST') {
      if (!PRICING_MANAGE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body) || !body.productId) {
        return json({ status: 'ERROR', message: 'productId and price details are required.' }, 400);
      }
      try {
        const standardPrice = await activeRepo.setStandardPrice(
          String(body.productId).trim(),
          body,
          caller.user_id || caller.id
        );
        return json({ status: 'SUCCESS', data: { standardPrice } });
      } catch (err) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'MIGRATION_REQUIRED' ? 503 : 400;
        return json({ status: 'ERROR', message: err.message }, status);
      }
    }

    // GET /api/pricing/products/:productId/history (MANAGER & ADMIN ONLY)
    const productHistoryMatch = path.match(/^\/api\/pricing\/products\/([^/]+)\/history$/);
    if (productHistoryMatch && method === 'GET') {
      if (!PRICING_MANAGE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      try {
        const history = await activeRepo.getProductPriceHistory(decodeURIComponent(productHistoryMatch[1]));
        return json({ status: 'SUCCESS', data: history });
      } catch (err) {
        return json({ status: 'ERROR', message: err.message }, err.code === 'NOT_FOUND' ? 404 : 400);
      }
    }

    // GET /api/pricing/history (MANAGER & ADMIN ONLY)
    if (path === '/api/pricing/history' && method === 'GET') {
      if (!PRICING_MANAGE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const productId = url.searchParams.get('productId') || null;
      const history = await activeRepo.listAllStandardPriceHistory(productId);
      return json({ status: 'SUCCESS', data: { history } });
    }

    // POST /api/pricing/special
    if (path === '/api/pricing/special' && method === 'POST') {
      if (!SPECIAL_PRICE_REQUEST_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      try {
        const specialPrice = await activeRepo.createSpecialPriceRequest(body, caller);
        return json({ status: 'SUCCESS', data: { specialPrice } });
      } catch (err) {
        const status = err.code === 'FORBIDDEN' ? 403 : err.code === 'NOT_FOUND' ? 404 : err.code === 'MIGRATION_REQUIRED' ? 503 : 400;
        return json({ status: 'ERROR', message: err.message }, status);
      }
    }

    // POST /api/pricing/special/:id/review (MANAGER & ADMIN ONLY)
    const reviewSpecialMatch = path.match(/^\/api\/pricing\/special\/([^/]+)\/review$/);
    if (reviewSpecialMatch && method === 'POST') {
      if (!PRICING_MANAGE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }
      try {
        const specialPrice = await activeRepo.reviewSpecialPrice(
          decodeURIComponent(reviewSpecialMatch[1]),
          body,
          caller.user_id || caller.id
        );
        return json({ status: 'SUCCESS', data: { specialPrice } });
      } catch (err) {
        const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'MIGRATION_REQUIRED' ? 503 : 400;
        return json({ status: 'ERROR', message: err.message }, status);
      }
    }

    return json({ status: 'ERROR', message: 'Not found.' }, 404);
  };
}

export function createPricingHandlerFromEnv(env) {
  return createPricingHandler({
    repo: createPricingRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env),
    db: env.DB
  });
}
