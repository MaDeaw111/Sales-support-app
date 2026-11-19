import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createLogisticsPartnersRepository } from './repository.js';
import { parsePartnerListQuery } from './validation.js';

const READ_ROLES = ['ADMIN', 'MANAGER', 'EXPORT', 'SALES_SUPPORT'];
const WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];

const NOT_FOUND_CODES = new Set([
  'SERVICE_PARTNER_NOT_FOUND',
  'PARTNER_RATE_NOT_FOUND'
]);

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

function errorStatus(error) {
  return NOT_FOUND_CODES.has(error?.code) ? 404 : 400;
}

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function createLogisticsPartnersHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createLogisticsPartnersRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    if (!READ_ROLES.includes(caller.role)) {
      return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    }

    const url = new URL(request.url);
    const { pathname: path } = url;
    const { method } = request;

    if (path === '/api/logistics-partners' && method === 'GET') {
      let query;
      try {
        query = parsePartnerListQuery(url.searchParams);
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }
      const partners = await activeRepo.listPartners(query);
      return json({ status: 'SUCCESS', data: { partners } });
    }

    if (path === '/api/logistics-partners' && method === 'POST') {
      if (!WRITE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      try {
        const partner = await activeRepo.createPartner(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { partner } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    const rateItemMatch = path.match(/^\/api\/logistics-partners\/([^/]+)\/rates\/([^/]+)$/);
    if (rateItemMatch && method === 'PATCH') {
      if (!WRITE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const partnerId = safeDecodeParam(rateItemMatch[1]);
      const rateId = safeDecodeParam(rateItemMatch[2]);
      if (!partnerId || !rateId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const body = await readJson(request);
      try {
        const rate = await activeRepo.updateRate(partnerId, rateId, body, caller.user_id);
        return json({ status: 'SUCCESS', data: { rate } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    const ratesCollectionMatch = path.match(/^\/api\/logistics-partners\/([^/]+)\/rates$/);
    if (ratesCollectionMatch && method === 'POST') {
      if (!WRITE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const partnerId = safeDecodeParam(ratesCollectionMatch[1]);
      if (!partnerId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const body = await readJson(request);
      try {
        const rate = await activeRepo.createRate(partnerId, body, caller.user_id);
        return json({ status: 'SUCCESS', data: { rate } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    const partnerItemMatch = path.match(/^\/api\/logistics-partners\/([^/]+)$/);
    if (partnerItemMatch && method === 'GET') {
      const partnerId = safeDecodeParam(partnerItemMatch[1]);
      if (!partnerId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const detail = await activeRepo.getPartnerDetail(partnerId);
      if (!detail) {
        return json({ status: 'ERROR', message: 'SERVICE_PARTNER_NOT_FOUND' }, 404);
      }
      return json({ status: 'SUCCESS', data: detail });
    }

    if (partnerItemMatch && method === 'PUT') {
      if (!WRITE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const partnerId = safeDecodeParam(partnerItemMatch[1]);
      if (!partnerId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const body = await readJson(request);
      try {
        const partner = await activeRepo.updatePartner(partnerId, body, caller.user_id);
        return json({ status: 'SUCCESS', data: { partner } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    return json({ status: 'ERROR', message: 'Logistics partners route not found.' }, 404);
  };
}

export function createLogisticsPartnersHandlerFromEnv(env) {
  return createLogisticsPartnersHandler({
    db: env.DB,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
