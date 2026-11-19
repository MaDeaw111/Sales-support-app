export const PAYMENT_STATUSES = Object.freeze([
  'UNPAID',
  'PARTIAL',
  'PAID'
]);

export const INVOICE_READINESS_VALUES = Object.freeze([
  'FINALIZED',
  'PRELIMINARY_ONLY',
  'NO_INVOICE'
]);

export const PAYMENT_SHIPMENT_STATUSES = Object.freeze([
  'PLANNING',
  'BOOKED',
  'LOADED',
  'DOCS_SENT',
  'COMPLETED'
]);

export const PAYMENT_CURRENCIES = Object.freeze([
  'USD',
  'THB',
  'EUR'
]);

export function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeOptionalFilter(raw) {
  const value = String(raw || '').trim();
  if (!value || value.toUpperCase() === 'ALL') return undefined;
  return value;
}

function parseEnumFilter(searchParams, key, allowlist, errorCode) {
  const raw = normalizeOptionalFilter(searchParams.get(key));
  if (raw === undefined) return undefined;
  const upper = raw.toUpperCase();
  if (!allowlist.includes(upper)) throw codedError(errorCode);
  return upper;
}

export function parsePaymentsQuery(searchParams) {
  const paymentStatus = parseEnumFilter(searchParams, 'paymentStatus', PAYMENT_STATUSES, 'PAYMENT_STATUS_INVALID');
  const invoiceReadiness = parseEnumFilter(searchParams, 'invoiceReadiness', INVOICE_READINESS_VALUES, 'PAYMENT_INVOICE_READINESS_INVALID');
  const shipmentStatus = parseEnumFilter(searchParams, 'shipmentStatus', PAYMENT_SHIPMENT_STATUSES, 'PAYMENT_SHIPMENT_STATUS_INVALID');
  const currency = parseEnumFilter(searchParams, 'currency', PAYMENT_CURRENCIES, 'PAYMENT_CURRENCY_INVALID');
  const customerId = normalizeOptionalFilter(searchParams.get('customerId'));
  const rawSearch = String(searchParams.get('search') || '').trim();
  const search = rawSearch ? rawSearch : undefined;

  return {
    paymentStatus,
    invoiceReadiness,
    shipmentStatus,
    currency,
    customerId,
    search
  };
}
