import { resolveAuthenticatedUser } from '../auth/routes.js';
import { createCalendarRepository } from './repository.js';
import {
  parseCalendarQuery,
  SHIPMENT_EVENT_TYPES,
  WAREHOUSE_EVENT_TYPES
} from './validation.js';

const FULL_OPERATIONAL_ROLES = ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT'];
const RESCHEDULE_ROLES = ['ADMIN', 'MANAGER', 'EXPORT'];
const CALENDAR_READ_ROLES = [...FULL_OPERATIONAL_ROLES, 'EXTERNAL_SALES', 'PRODUCTION_WAREHOUSE'];

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function pick(record, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(record, field))
      .map((field) => [field, record[field]])
  );
}

function pickPresent(record, fields) {
  return Object.fromEntries(
    fields
      .filter((field) => Object.hasOwn(record, field) && record[field] !== null && record[field] !== undefined)
      .map((field) => [field, record[field]])
  );
}

async function scopedCalendarEventId(caller, event) {
  const source = `phase7-calendar:${caller.user_id}:${caller.role}:${event.event_id}`;
  const bytes = new TextEncoder().encode(source);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function projectCalendarEventForRole(event, caller) {
  if (!event || !caller) return event;

  if (caller.role === 'PRODUCTION_WAREHOUSE') {
    return {
      event_id: await scopedCalendarEventId(caller, event),
      event_type: event.event_type,
      event_date: event.event_date,
      ...pickPresent(event, ['planned_loading_date', 'actual_loading_date', 'container_plan']),
      planned_qty_mt: event.planned_qty_mt,
      actual_container_count: event.actual_container_count,
      products: (event.products || []).map((product) => pick(product, [
        'product_code', 'product_name', 'planned_qty_mt', 'packing_snapshot'
      ])),
      containers: (event.containers || []).map((container) => ({
        ...pick(container, ['container_no', 'seal_no']),
        lines: (container.lines || []).map((line) => pick(line, [
          'product_code', 'product_name', 'number_of_bags', 'qty_mt'
        ]))
      }))
    };
  }

  if (caller.role === 'EXTERNAL_SALES') {
    const opaqueId = await scopedCalendarEventId(caller, event);
    if (SHIPMENT_EVENT_TYPES.includes(event.event_type)) {
      return {
        event_id: opaqueId,
        event_type: event.event_type,
        event_date: event.event_date,
        ...pickPresent(event, [
          'di_no', 'di_status', 'shipment_status',
          'booking_no', 'vessel', 'etd', 'eta',
          'planned_loading_date', 'actual_loading_date', 'schedule_result'
        ])
      };
    }
    return {
      event_id: opaqueId,
      event_type: event.event_type,
      event_date: event.event_date,
      ...pickPresent(event, [
        'customer_po_no', 'po_status', 'incoterm', 'destination',
        'delivery_start', 'delivery_end', 'total_contract_qty_mt'
      ])
    };
  }

  const canReschedule =
    event.event_type === 'LOADING_PLANNED' &&
    event.shipment_status === 'BOOKED' &&
    RESCHEDULE_ROLES.includes(caller.role);

  return {
    ...event,
    can_reschedule: canReschedule
  };
}

export function createCalendarHandler({ repo, resolveUser, db, now = () => new Date() }) {
  const activeRepo = repo || createCalendarRepository(db);
  const activeResolveUser = resolveUser || resolveAuthenticatedUser;

  return async function handle(request, env) {
    const caller = await activeResolveUser(request, env);
    if (!caller) return json({ status: 'ERROR', message: 'Authentication required.' }, 401);
    if (!CALENDAR_READ_ROLES.includes(caller.role)) {
      return json({ status: 'ERROR', message: 'Permission denied.' }, 403);
    }

    const url = new URL(request.url);
    if (url.pathname !== '/api/operations-calendar' || request.method !== 'GET') {
      return json({ status: 'ERROR', message: 'Calendar route not found.' }, 404);
    }

    let query;
    try {
      query = parseCalendarQuery(url.searchParams, now());
    } catch (error) {
      return json({ status: 'ERROR', message: error.message }, 400);
    }

    const isWarehouse = caller.role === 'PRODUCTION_WAREHOUSE';
    const isExternalSales = caller.role === 'EXTERNAL_SALES';

    if (isWarehouse && query.eventType && !WAREHOUSE_EVENT_TYPES.includes(query.eventType)) {
      return json({
        status: 'SUCCESS',
        data: {
          range: { from: query.from, to: query.to },
          events: [],
          dailyLoadingSummary: []
        }
      });
    }

    const { events, dailyLoadingSummary } = await activeRepo.listCalendarData({
      from: query.from,
      to: query.to,
      eventType: query.eventType,
      // Anti-inference: ignore hidden-field predicates for restricted roles before querying
      customerId: (isWarehouse || isExternalSales) ? undefined : query.customerId,
      salesOwnerId: (isWarehouse || isExternalSales) ? undefined : query.salesOwnerId,
      productId: isExternalSales ? undefined : query.productId,
      status: isWarehouse ? undefined : query.status,
      ownedByUserId: isExternalSales ? caller.user_id : undefined,
      loadingOnly: isWarehouse
    });

    const projectedEvents = [];
    for (const event of events) {
      projectedEvents.push(await projectCalendarEventForRole(event, caller));
    }

    return json({
      status: 'SUCCESS',
      data: {
        range: { from: query.from, to: query.to },
        events: projectedEvents,
        dailyLoadingSummary: isExternalSales ? [] : dailyLoadingSummary
      }
    });
  };
}

export function createCalendarHandlerFromEnv(env) {
  return createCalendarHandler({
    db: env.DB,
    resolveUser: (req) => resolveAuthenticatedUser(req, env)
  });
}
