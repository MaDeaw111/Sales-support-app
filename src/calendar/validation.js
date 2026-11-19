export const CALENDAR_EVENT_TYPES = Object.freeze([
  'LOADING_PLANNED',
  'LOADING_ACTUAL',
  'ETD',
  'ETA',
  'PO_DELIVERY_START',
  'PO_DELIVERY_END'
]);

export const WAREHOUSE_EVENT_TYPES = Object.freeze([
  'LOADING_PLANNED',
  'LOADING_ACTUAL'
]);

export const SHIPMENT_EVENT_TYPES = Object.freeze([
  'LOADING_PLANNED',
  'LOADING_ACTUAL',
  'ETD',
  'ETA'
]);

export const PO_EVENT_TYPES = Object.freeze([
  'PO_DELIVERY_START',
  'PO_DELIVERY_END'
]);

export const MAX_CALENDAR_RANGE_DAYS = 366;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidIsoDate(value) {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE_RE.exec(value.trim());
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function defaultMonthRange(now) {
  const ref = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date();
  const year = ref.getUTCFullYear();
  const month = ref.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  return {
    from: `${year}-${mm}-01`,
    to: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`
  };
}

function normalizeOptionalFilter(raw) {
  const value = String(raw || '').trim();
  if (!value || value.toUpperCase() === 'ALL') return undefined;
  return value;
}

export function parseCalendarQuery(searchParams, now = new Date()) {
  const rawFrom = String(searchParams.get('from') || '').trim();
  const rawTo = String(searchParams.get('to') || '').trim();

  let from;
  let to;
  if (!rawFrom && !rawTo) {
    ({ from, to } = defaultMonthRange(now));
  } else if (!rawFrom || !rawTo) {
    throw new Error('Both from and to dates are required when specifying a date range.');
  } else {
    if (!isValidIsoDate(rawFrom)) throw new Error('Invalid from date. Expected YYYY-MM-DD.');
    if (!isValidIsoDate(rawTo)) throw new Error('Invalid to date. Expected YYYY-MM-DD.');
    if (rawFrom > rawTo) throw new Error('from date must be on or before to date.');
    const fromMs = Date.parse(`${rawFrom}T00:00:00Z`);
    const toMs = Date.parse(`${rawTo}T00:00:00Z`);
    const inclusiveDays = Math.floor((toMs - fromMs) / 86400000) + 1;
    if (inclusiveDays > MAX_CALENDAR_RANGE_DAYS) {
      throw new Error(`Date range cannot exceed ${MAX_CALENDAR_RANGE_DAYS} days.`);
    }
    from = rawFrom;
    to = rawTo;
  }

  const rawEventType = normalizeOptionalFilter(searchParams.get('eventType'));
  let eventType;
  if (rawEventType !== undefined) {
    const upper = rawEventType.toUpperCase();
    if (!CALENDAR_EVENT_TYPES.includes(upper)) {
      throw new Error(`Invalid eventType: ${rawEventType}`);
    }
    eventType = upper;
  }

  const rawStatus = normalizeOptionalFilter(searchParams.get('status'));

  return {
    from,
    to,
    eventType,
    customerId: normalizeOptionalFilter(searchParams.get('customerId')),
    salesOwnerId: normalizeOptionalFilter(searchParams.get('salesOwnerId')),
    productId: normalizeOptionalFilter(searchParams.get('productId')),
    status: rawStatus ? rawStatus.toUpperCase() : undefined
  };
}
