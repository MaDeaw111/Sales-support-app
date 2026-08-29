import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createShippingDiRepository } from './repository.js';

const OPERATIONAL_READER_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT'];
const SERVICE_PARTNER_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const DELIVERY_INSTRUCTION_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];

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

export function createShippingDiHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createShippingDiRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);

    const url = new URL(request.url);
    const { pathname: path } = url;
    const { method } = request;

    if (path === '/api/service-partners' && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const servicePartners = await activeRepo.listServicePartners({
        status: url.searchParams.get('status') || undefined,
        partnerType: url.searchParams.get('partnerType') || undefined
      });
      return json({ status: 'SUCCESS', data: { servicePartners } });
    }

    if (path === '/api/service-partners' && method === 'POST') {
      if (!SERVICE_PARTNER_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const servicePartner = await activeRepo.createServicePartner(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { servicePartner } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }
    }

    if (path === '/api/delivery-instructions' && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const deliveryInstructions = await activeRepo.listDeliveryInstructions({
        customerId: url.searchParams.get('customerId') || undefined,
        poId: url.searchParams.get('poId') || undefined,
        status: url.searchParams.get('status') || undefined
      });
      return json({ status: 'SUCCESS', data: { deliveryInstructions } });
    }

    const poBalanceMatch = path.match(/^\/api\/delivery-instructions\/po-balance\/([^/]+)$/);
    if (poBalanceMatch && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const poLineBalances = await activeRepo.getPoLineBalances(decodeURIComponent(poBalanceMatch[1]));
      return json({ status: 'SUCCESS', data: { poLineBalances } });
    }

    if (path === '/api/delivery-instructions' && method === 'POST') {
      if (!DELIVERY_INSTRUCTION_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const deliveryInstruction = await activeRepo.createDeliveryInstruction(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { deliveryInstruction } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }
    }

    const deliveryInstructionConfirmMatch = path.match(/^\/api\/delivery-instructions\/([^/]+)\/confirm$/);
    if (deliveryInstructionConfirmMatch && method === 'POST') {
      if (!DELIVERY_INSTRUCTION_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      try {
        const deliveryInstruction = await activeRepo.confirmDeliveryInstruction(decodeURIComponent(deliveryInstructionConfirmMatch[1]), caller.user_id);
        return json({ status: 'SUCCESS', data: { deliveryInstruction } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'DI_NOT_FOUND' ? 404 : 400);
      }
    }

    const deliveryInstructionCancelMatch = path.match(/^\/api\/delivery-instructions\/([^/]+)\/cancel$/);
    if (deliveryInstructionCancelMatch && method === 'POST') {
      if (!DELIVERY_INSTRUCTION_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const deliveryInstruction = await activeRepo.cancelDeliveryInstruction(
          decodeURIComponent(deliveryInstructionCancelMatch[1]),
          body?.note,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { deliveryInstruction } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'DI_NOT_FOUND' ? 404 : 400);
      }
    }

    const deliveryInstructionMatch = path.match(/^\/api\/delivery-instructions\/([^/]+)$/);
    if (deliveryInstructionMatch && method === 'PATCH') {
      if (!DELIVERY_INSTRUCTION_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const deliveryInstruction = await activeRepo.updateDraftDeliveryInstruction(
          decodeURIComponent(deliveryInstructionMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { deliveryInstruction } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'DI_NOT_FOUND' ? 404 : 400);
      }
    }

    if (deliveryInstructionMatch && method === 'DELETE') {
      if (!DELIVERY_INSTRUCTION_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      try {
        await activeRepo.deleteDraftDeliveryInstruction(decodeURIComponent(deliveryInstructionMatch[1]));
        return json({ status: 'SUCCESS' });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'DI_NOT_FOUND' ? 404 : 400);
      }
    }

    const partnerMatch = path.match(/^\/api\/service-partners\/([^/]+)$/);
    if (partnerMatch && method === 'PATCH') {
      if (!SERVICE_PARTNER_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const servicePartner = await activeRepo.updateServicePartner(partnerMatch[1], body, caller.user_id);
        return json({ status: 'SUCCESS', data: { servicePartner } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'SERVICE_PARTNER_NOT_FOUND' ? 404 : 400);
      }
    }

    return json({ status: 'ERROR', message: 'Not found.' }, 404);
  };
}

export function createShippingDiHandlerFromEnv(env) {
  return createShippingDiHandler({
    repo: createShippingDiRepository(env.DB),
    resolveUser: (request) => resolveAuthenticatedUser(request, env),
    db: env.DB
  });
}
