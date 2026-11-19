import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createPaymentsRepository } from './repository.js';
import { parsePaymentsQuery } from './validation.js';

const INTERNAL_READ_ROLES = ['ADMIN', 'MANAGER', 'EXPORT', 'SALES_SUPPORT'];
const PAYMENT_WRITE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const PAYMENTS_READ_ROLES = [...INTERNAL_READ_ROLES, 'EXTERNAL_SALES'];

const EXTERNAL_SALES_ITEM_FIELDS = [
  'di_no',
  'customer_name',
  'customer_po_no',
  'currency',
  'shipment_status',
  'etd',
  'actual_loading_date',
  'invoice_readiness',
  'final_invoice_nos',
  'latest_final_invoice_date',
  'final_invoice_total',
  'payment_total',
  'outstanding_balance',
  'payment_status',
  'commission_ready'
];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function pick(record, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]])
  );
}

export function projectPaymentItemForRole(item, caller) {
  if (!item || !caller) return item;
  if (caller.role === 'EXTERNAL_SALES') {
    return pick(item, EXTERNAL_SALES_ITEM_FIELDS);
  }
  return {
    ...item,
    can_edit_payment: PAYMENT_WRITE_ROLES.includes(caller.role)
  };
}

export function projectPaymentsSummaryForRole(summary, caller) {
  if (!summary || !caller) return summary;
  if (caller.role === 'EXTERNAL_SALES') {
    const projected = {
      total_shipments: summary.total_shipments,
      paid_count: summary.paid_count,
      partial_count: summary.partial_count,
      unpaid_count: summary.unpaid_count,
      final_invoiced_count: summary.final_invoiced_count,
      awaiting_final_invoice_count: summary.awaiting_final_invoice_count,
      totals_by_currency: (summary.totals_by_currency || []).map((row) => ({
        currency: row.currency,
        shipment_count: row.shipment_count,
        final_invoice_total: row.final_invoice_total,
        payment_total: row.payment_total,
        outstanding_total: row.outstanding_total
      }))
    };
    return projected;
  }
  return summary;
}

export function createPaymentsHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createPaymentsRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    if (!PAYMENTS_READ_ROLES.includes(caller.role)) {
      return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    }

    const url = new URL(request.url);
    const { pathname: path } = url;
    const { method } = request;

    if (path === '/api/payments' && method === 'GET') {
      let query;
      try {
        query = parsePaymentsQuery(url.searchParams);
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }

      const isExternalSales = caller.role === 'EXTERNAL_SALES';
      const result = await activeRepo.listPaymentsDashboard({
        paymentStatus: query.paymentStatus,
        invoiceReadiness: query.invoiceReadiness,
        shipmentStatus: query.shipmentStatus,
        currency: query.currency,
        // Anti-inference: ignore customerId filter for EXTERNAL_SALES before querying
        customerId: isExternalSales ? undefined : query.customerId,
        search: query.search,
        ownedByUserId: isExternalSales ? caller.user_id : undefined,
        restrictedSearch: isExternalSales,
        includeCustomerCredits: !isExternalSales
      });

      return json({
        status: 'SUCCESS',
        data: {
          summary: projectPaymentsSummaryForRole(result.summary, caller),
          items: result.items.map((item) => projectPaymentItemForRole(item, caller)),
          customerCredits: isExternalSales ? [] : result.customerCredits
        }
      });
    }

    const detailMatch = path.match(/^\/api\/payments\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      if (!INTERNAL_READ_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const shipmentId = safeDecodeParam(detailMatch[1]);
      if (!shipmentId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const detail = await activeRepo.getShipmentPaymentDetail(shipmentId);
      if (!detail) {
        return json({ status: 'ERROR', message: 'SHIPMENT_NOT_FOUND' }, 404);
      }
      return json({
        status: 'SUCCESS',
        data: {
          ...detail,
          shipment: projectPaymentItemForRole(detail.shipment, caller)
        }
      });
    }

    return json({ status: 'ERROR', message: 'Payments route not found.' }, 404);
  };
}

export function createPaymentsHandlerFromEnv(env) {
  return createPaymentsHandler({
    db: env.DB,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
