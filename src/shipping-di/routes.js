import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createShippingDiRepository } from './repository.js';

const OPERATIONAL_READER_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT'];
const PHASE6_READ_ROLES = [...OPERATIONAL_READER_ROLES, 'EXTERNAL_SALES', 'PRODUCTION_WAREHOUSE'];
const SERVICE_PARTNER_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const DELIVERY_INSTRUCTION_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_BOOKING_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_SCHEDULE_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_CONTAINER_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_INVOICE_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_DOCUMENT_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const CUSTOMER_CREDIT_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const SHIPMENT_PAYMENT_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];

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

function pick(record, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(record, field))
    .map((field) => [field, record[field]]));
}

function pickPresent(record, fields) {
  return Object.fromEntries(fields
    .filter((field) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined)
    .map((field) => [field, record[field]]));
}

export function projectShippingDiForRole(record, caller) {
  if (!record || !caller) return record;
  if (caller.role === 'EXTERNAL_SALES') {
    return pickPresent(record, [
      'di_no', 'status', 'booking_no', 'vessel', 'etd', 'eta',
      'planned_loading_date', 'actual_loading_date', 'schedule_result'
    ]);
  }
  if (caller.role === 'PRODUCTION_WAREHOUSE') {
    return {
      ...pickPresent(record, ['planned_loading_date', 'actual_loading_date', 'container_plan']),
      products: (record.products || []).map((product) => pick(product, [
        'product_code', 'product_name', 'planned_qty_mt', 'packing_snapshot'
      ])),
      containers: (record.containers || []).map((container) => ({
        ...pick(container, ['container_no', 'seal_no']),
        lines: (container.lines || []).map((line) => pick(line, [
          'product_code', 'product_name', 'number_of_bags', 'qty_mt'
        ]))
      }))
    };
  }
  return record;
}

export function createShippingDiHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createShippingDiRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  async function canAccessShippingDiCustomer(caller, customerId) {
    if (caller.role !== 'EXTERNAL_SALES') return true;
    if (!customerId || !db?.prepare) return false;
    const customer = await db.prepare(`
      SELECT owner_user_id
      FROM customers
      WHERE customer_id = ?
    `).bind(customerId).first();
    return customer?.owner_user_id === caller.user_id;
  }

  async function customerIdForShippingRecord(record) {
    if (!record) return null;
    if (record.customer_id || record.customerId) return record.customer_id || record.customerId;
    if (!record.di_id || typeof activeRepo.getDeliveryInstruction !== 'function') return null;
    const deliveryInstruction = await activeRepo.getDeliveryInstruction(record.di_id);
    return deliveryInstruction?.customer_id || deliveryInstruction?.customerId || null;
  }

  async function canReadShippingDiRecord(caller, record) {
    return canAccessShippingDiCustomer(caller, await customerIdForShippingRecord(record));
  }

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
      if (!PHASE6_READ_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      if (caller.role === 'EXTERNAL_SALES' && !db?.prepare) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const deliveryInstructions = await activeRepo.listDeliveryInstructions({
        customerId: url.searchParams.get('customerId') || undefined,
        poId: url.searchParams.get('poId') || undefined,
        status: url.searchParams.get('status') || undefined
      });
      const visibleInstructions = [];
      for (const deliveryInstruction of deliveryInstructions) {
        if (await canReadShippingDiRecord(caller, deliveryInstruction)) {
          visibleInstructions.push(projectShippingDiForRole(deliveryInstruction, caller));
        }
      }
      return json({ status: 'SUCCESS', data: { deliveryInstructions: visibleInstructions } });
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

    if (path === '/api/customer-credits' && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const customerCredits = await activeRepo.listCustomerCredits({
        customerId: url.searchParams.get('customerId') || undefined
      });
      return json({ status: 'SUCCESS', data: { customerCredits } });
    }

    if (path === '/api/customer-credits' && method === 'POST') {
      if (!CUSTOMER_CREDIT_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const credit = await activeRepo.createCustomerCredit(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { credit } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }
    }

    const deliveryInstructionShipmentMatch = path.match(/^\/api\/delivery-instructions\/([^/]+)\/shipment$/);
    if (deliveryInstructionShipmentMatch && method === 'GET') {
      if (!PHASE6_READ_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const shipment = await activeRepo.getPhase6ShipmentByDeliveryInstructionId(
        decodeURIComponent(deliveryInstructionShipmentMatch[1])
      );
      if (!shipment) return json({ status: 'ERROR', message: 'SHIPMENT_NOT_FOUND' }, 404);
      if (!await canReadShippingDiRecord(caller, shipment)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      return json({ status: 'SUCCESS', data: { shipment: projectShippingDiForRole(shipment, caller) } });
    }

    const shipmentMatch = path.match(/^\/api\/shipments-v2\/([^/]+)$/);
    if (shipmentMatch && method === 'GET') {
      if (!PHASE6_READ_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const shipment = await activeRepo.getPhase6ShipmentByShipmentId(decodeURIComponent(shipmentMatch[1]));
      if (!shipment) return json({ status: 'ERROR', message: 'SHIPMENT_NOT_FOUND' }, 404);
      if (!await canReadShippingDiRecord(caller, shipment)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      return json({ status: 'SUCCESS', data: { shipment: projectShippingDiForRole(shipment, caller) } });
    }

    const shipmentHistoryMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/history$/);
    if (shipmentHistoryMatch && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const shipmentId = decodeURIComponent(shipmentHistoryMatch[1]);
      const shipment = await activeRepo.getPhase6ShipmentByShipmentId(shipmentId);
      if (!shipment) return json({ status: 'ERROR', message: 'SHIPMENT_NOT_FOUND' }, 404);
      const history = await activeRepo.getPhase6ShipmentHistoryByShipmentId(shipmentId);
      return json({ status: 'SUCCESS', data: { history } });
    }

    const shipmentBookingMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/booking$/);
    if (shipmentBookingMatch && method === 'PUT') {
      if (!SHIPMENT_BOOKING_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const shipment = await activeRepo.recordShipmentBooking(
          decodeURIComponent(shipmentBookingMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { shipment } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400
        );
      }
    }

    const shipmentScheduleMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/schedule$/);
    if (shipmentScheduleMatch && method === 'PUT') {
      if (!SHIPMENT_SCHEDULE_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const shipment = await activeRepo.updateShipmentSchedule(
          decodeURIComponent(shipmentScheduleMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { shipment } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400
        );
      }
    }

    const shipmentContainersMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/containers$/);
    if (shipmentContainersMatch && method === 'PUT') {
      if (!SHIPMENT_CONTAINER_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const result = await activeRepo.replaceShipmentContainers(
          decodeURIComponent(shipmentContainersMatch[1]),
          body?.containers,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: result });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400
        );
      }
    }

    const shipmentDocumentsMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/documents$/);
    if (shipmentDocumentsMatch && method === 'PUT') {
      if (!SHIPMENT_DOCUMENT_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const shipment = await activeRepo.updateShipmentDocuments(
          decodeURIComponent(shipmentDocumentsMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { shipment } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400
        );
      }
    }

    const shipmentPaymentMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/payment$/);
    if (shipmentPaymentMatch && method === 'PUT') {
      if (!SHIPMENT_PAYMENT_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const shipment = await activeRepo.updateShipmentPayment(
          decodeURIComponent(shipmentPaymentMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { shipment } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400
        );
      }
    }

    const shipmentInvoiceFinalizeMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/invoices\/([^/]+)\/finalize$/);
    if (shipmentInvoiceFinalizeMatch && method === 'PATCH') {
      if (!SHIPMENT_INVOICE_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const invoice = await activeRepo.finalizeShipmentInvoice(
          decodeURIComponent(shipmentInvoiceFinalizeMatch[2]),
          body?.lines,
          caller.user_id,
          decodeURIComponent(shipmentInvoiceFinalizeMatch[1])
        );
        return json({ status: 'SUCCESS', data: { invoice } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          ['SHIPMENT_NOT_FOUND', 'INVOICE_NOT_FOUND'].includes(error.code) ? 404 : 400
        );
      }
    }

    const shipmentInvoicesMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/invoices$/);
    if (shipmentInvoicesMatch && method === 'GET') {
      if (!OPERATIONAL_READER_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      try {
        const invoices = await activeRepo.getShipmentInvoices(decodeURIComponent(shipmentInvoicesMatch[1]));
        return json({ status: 'SUCCESS', data: { invoices } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400);
      }
    }

    if (shipmentInvoicesMatch && method === 'POST') {
      if (!SHIPMENT_INVOICE_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const invoice = await activeRepo.createShipmentInvoice(
          decodeURIComponent(shipmentInvoicesMatch[1]),
          body,
          caller.user_id
        );
        return json({ status: 'SUCCESS', data: { invoice } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, error.code === 'SHIPMENT_NOT_FOUND' ? 404 : 400);
      }
    }

    const shipmentInvoiceMatch = path.match(/^\/api\/shipments-v2\/([^/]+)\/invoices\/([^/]+)$/);
    if (shipmentInvoiceMatch && method === 'PUT') {
      if (!SHIPMENT_INVOICE_WRITE_ROLES.includes(caller.role)) return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      const body = await readJson(request);
      try {
        const invoice = await activeRepo.updateShipmentInvoice(
          decodeURIComponent(shipmentInvoiceMatch[2]),
          body,
          caller.user_id,
          decodeURIComponent(shipmentInvoiceMatch[1])
        );
        return json({ status: 'SUCCESS', data: { invoice } });
      } catch (error) {
        return json(
          { status: 'ERROR', message: error.message },
          ['SHIPMENT_NOT_FOUND', 'INVOICE_NOT_FOUND'].includes(error.code) ? 404 : 400
        );
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
