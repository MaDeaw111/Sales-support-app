import { createPriceNoteRepository } from './repository.js';
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

export function createPriceNoteHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createPriceNoteRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const isAdmin = caller.role === 'ADMIN';
    const isManager = caller.role === 'MANAGER';

    // GET /api/manager-price-notes
    if (path === '/api/manager-price-notes' && method === 'GET') {
      const salesUserId = url.searchParams.get('salesUserId');
      const customerId = url.searchParams.get('customerId');
      const productId = url.searchParams.get('productId');

      const priceNotes = await activeRepo.listPriceNotes({ salesUserId, customerId, productId });
      return json({ status: 'SUCCESS', data: { priceNotes } });
    }

    // POST /api/manager-price-notes
    if (path === '/api/manager-price-notes' && method === 'POST') {
      if (!isAdmin && !isManager) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }

      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      try {
        const priceNote = await activeRepo.createPriceNote(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { priceNote } });
      } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    return json({ status: 'ERROR', message: 'Not found.' }, 404);
  };
}

export function createPriceNoteHandlerFromEnv(env) {
  return createPriceNoteHandler({
    repo: createPriceNoteRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env),
    db: env.DB
  });
}
