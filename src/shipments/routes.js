import { createShipmentRepository } from './repository.js';
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

export function createShipmentHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createShipmentRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) {
      return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // POST /api/shipments/:id/documents
    const docPostMatch = path.match(/^\/api\/shipments\/([^/]+)\/documents$/);
    if (docPostMatch && method === 'POST') {
      const shipmentId = docPostMatch[1];
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      try {
        const documentLink = await activeRepo.addShipmentDocumentLink({
          ...body,
          shipmentId
        }, caller.user_id);
        return json({ status: 'SUCCESS', data: { documentLink } });
      } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // GET /api/shipments/:id/documents
    const docGetMatch = path.match(/^\/api\/shipments\/([^/]+)\/documents$/);
    if (docGetMatch && method === 'GET') {
      const shipmentId = docGetMatch[1];
      const documentLinks = await activeRepo.listShipmentDocumentLinks(shipmentId);
      return json({ status: 'SUCCESS', data: { documentLinks } });
    }

    // POST /api/shipments/:id/expenses
    const expPostMatch = path.match(/^\/api\/shipments\/([^/]+)\/expenses$/);
    if (expPostMatch && method === 'POST') {
      const shipmentId = expPostMatch[1];
      const body = await readJson(request);
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return json({ status: 'ERROR', message: 'Invalid request body.' }, 400);
      }

      try {
        const expense = await activeRepo.addShipmentExpense({
          ...body,
          shipmentId
        }, caller.user_id);
        return json({ status: 'SUCCESS', data: { expense } });
      } catch (err) {
        return json({ status: 'ERROR', message: err.message }, 400);
      }
    }

    // GET /api/shipments/:id/expenses
    const expGetMatch = path.match(/^\/api\/shipments\/([^/]+)\/expenses$/);
    if (expGetMatch && method === 'GET') {
      const shipmentId = expGetMatch[1];
      const expenses = await activeRepo.listShipmentExpenses(shipmentId);
      const totalActualExportCostThb = await activeRepo.getShipmentTotalActualExportCostThb(shipmentId);
      return json({ status: 'SUCCESS', data: { expenses, totalActualExportCostThb } });
    }

    return json({ status: 'ERROR', message: 'Not found.' }, 404);
  };
}

export function createShipmentHandlerFromEnv(env) {
  return createShipmentHandler({
    repo: createShipmentRepository(env.DB),
    resolveUser: (req) => resolveAuthenticatedUser(req, env),
    db: env.DB
  });
}
