import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createCommissionsRepository } from './repository.js';
import { parseCommissionsQuery } from './validation.js';

const SETTLE_ROLES = ['ADMIN', 'MANAGER'];
const COMMISSION_READ_ROLES = ['ADMIN', 'MANAGER', 'EXTERNAL_SALES'];

const NOT_FOUND_CODES = new Set(['COMMISSION_NOT_FOUND']);
const CONFLICT_CODES = new Set([
  'COMMISSION_ALREADY_SETTLED',
  'COMMISSION_REQUEST_KEY_CONFLICT'
]);

const EXTERNAL_SALES_LIST_FIELDS = [
  'settlement_id',
  'di_no',
  'customer_name',
  'customer_po_no',
  'final_invoice_nos',
  'actual_shipped_mt',
  'planned_qty_mt',
  'rate_usd_mt',
  'commission_amount_usd',
  'currency',
  'po_currency',
  'payment_status',
  'shipment_status',
  'status',
  'paid_date',
  'payment_reference',
  'note'
];

const EXTERNAL_SALES_SETTLEMENT_FIELDS = [
  'settlement_id',
  'di_no',
  'customer_name',
  'customer_po_no',
  'final_invoice_nos',
  'actual_mt_snapshot',
  'rate_snapshot_usd_mt',
  'amount_usd_snapshot',
  'currency',
  'po_currency',
  'status',
  'paid_date',
  'payment_reference',
  'note',
  'settled_at',
  'shipment_status',
  'payment_status'
];

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

function safeDecodeParam(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function errorStatus(error) {
  if (NOT_FOUND_CODES.has(error?.code)) return 404;
  if (CONFLICT_CODES.has(error?.code)) return 409;
  return 400;
}

function pick(record, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]])
  );
}

function sanitizeBreakdown(lines) {
  return (lines || []).map((line) => ({
    product_code: line.product_code,
    product_name: line.product_name,
    actual_mt: line.actual_mt,
    rate_usd_mt: line.rate_usd_mt,
    amount_usd: line.amount_usd
  }));
}

export function projectCommissionItemForRole(item, caller) {
  if (!item || !caller) return item;
  if (caller.role === 'EXTERNAL_SALES') {
    return {
      ...pick(item, EXTERNAL_SALES_LIST_FIELDS),
      line_breakdown: sanitizeBreakdown(item.line_breakdown)
    };
  }
  return {
    ...item,
    can_settle: SETTLE_ROLES.includes(caller.role) && item.status === 'PAYABLE'
  };
}

export function projectSettlementDetailForRole(detail, caller) {
  if (!detail || !caller) return detail;
  if (caller.role === 'EXTERNAL_SALES') {
    return {
      settlement: {
        ...pick(detail.settlement, EXTERNAL_SALES_SETTLEMENT_FIELDS),
        line_breakdown: sanitizeBreakdown(detail.settlement.line_breakdown)
      },
      auditHistory: []
    };
  }
  return detail;
}

export function createCommissionsHandler({ repo, resolveUser, db }) {
  const activeRepo = repo || createCommissionsRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    if (!COMMISSION_READ_ROLES.includes(caller.role)) {
      return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    }

    const url = new URL(request.url);
    const { pathname: path } = url;
    const { method } = request;

    if (path === '/api/commissions' && method === 'GET') {
      let query;
      try {
        query = parseCommissionsQuery(url.searchParams);
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, 400);
      }

      const isExternalSales = caller.role === 'EXTERNAL_SALES';
      const result = await activeRepo.listCommissions({
        status: query.status,
        // Anti-inference: EXTERNAL_SALES always scoped to self; ignore recipientUserId/customerId filters
        recipientUserId: isExternalSales ? caller.user_id : query.recipientUserId,
        customerId: isExternalSales ? undefined : query.customerId,
        paidDateFrom: query.paidDateFrom,
        paidDateTo: query.paidDateTo,
        search: query.search,
        restrictedSearch: isExternalSales,
        includeRecipients: !isExternalSales
      });

      return json({
        status: 'SUCCESS',
        data: {
          summary: result.summary,
          items: result.items.map((item) => projectCommissionItemForRole(item, caller)),
          recipients: isExternalSales ? [] : result.recipients
        }
      });
    }

    if (path === '/api/commissions/settle' && method === 'POST') {
      if (!SETTLE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const body = await readJson(request);
      try {
        const settlement = await activeRepo.settleCommission(body, caller.user_id);
        return json({ status: 'SUCCESS', data: { settlement } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    const detailMatch = path.match(/^\/api\/commissions\/([^/]+)$/);
    if (detailMatch && method === 'GET') {
      const settlementId = safeDecodeParam(detailMatch[1]);
      if (!settlementId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const detail = await activeRepo.getSettlementDetail(settlementId);
      if (!detail) {
        return json({ status: 'ERROR', message: 'COMMISSION_NOT_FOUND' }, 404);
      }
      if (caller.role === 'EXTERNAL_SALES' && detail.settlement.recipient_user_id !== caller.user_id) {
        return json({ status: 'ERROR', message: 'COMMISSION_NOT_FOUND' }, 404);
      }
      return json({
        status: 'SUCCESS',
        data: projectSettlementDetailForRole(detail, caller)
      });
    }

    if (detailMatch && method === 'PATCH') {
      if (!SETTLE_ROLES.includes(caller.role)) {
        return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
      }
      const settlementId = safeDecodeParam(detailMatch[1]);
      if (!settlementId) {
        return json({ status: 'ERROR', message: 'INVALID_PATH_PARAMETER' }, 400);
      }
      const body = await readJson(request);
      try {
        const settlement = await activeRepo.updateSettlementMetadata(settlementId, body, caller.user_id);
        return json({ status: 'SUCCESS', data: { settlement } });
      } catch (error) {
        return json({ status: 'ERROR', message: error.message }, errorStatus(error));
      }
    }

    return json({ status: 'ERROR', message: 'Commissions route not found.' }, 404);
  };
}

export function createCommissionsHandlerFromEnv(env) {
  return createCommissionsHandler({
    db: env.DB,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
