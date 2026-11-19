export const COMMISSION_STATUSES = Object.freeze([
  'PENDING',
  'PAYABLE',
  'PAID'
]);

const SETTLE_PROPERTIES = [
  'shipmentId',
  'recipientUserId',
  'paidDate',
  'paymentReference',
  'note',
  'requestKey'
];

const NOTE_UPDATE_PROPERTIES = [
  'paymentReference',
  'note'
];

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

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

function normalizeOptionalFilter(raw) {
  const value = String(raw || '').trim();
  if (!value || value.toUpperCase() === 'ALL') return undefined;
  return value;
}

function normalizeRequiredString(value, errorCode) {
  if (typeof value !== 'string' || !value.trim()) throw codedError(errorCode);
  return value.trim();
}

function normalizeOptionalString(value, errorCode) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw codedError(errorCode);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function assertPlainObject(dto, errorCode) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw codedError(errorCode);
  }
}

export function parseCommissionsQuery(searchParams) {
  const rawStatus = normalizeOptionalFilter(searchParams.get('status'));
  let status;
  if (rawStatus !== undefined) {
    const upper = rawStatus.toUpperCase();
    if (!COMMISSION_STATUSES.includes(upper)) throw codedError('COMMISSION_STATUS_INVALID');
    status = upper;
  }

  const recipientUserId = normalizeOptionalFilter(searchParams.get('recipientUserId'));
  const customerId = normalizeOptionalFilter(searchParams.get('customerId'));

  const rawFrom = String(searchParams.get('paidDateFrom') || '').trim();
  const rawTo = String(searchParams.get('paidDateTo') || '').trim();
  let paidDateFrom;
  let paidDateTo;
  if (rawFrom) {
    if (!isValidIsoDate(rawFrom)) throw codedError('COMMISSION_DATE_INVALID');
    paidDateFrom = rawFrom;
  }
  if (rawTo) {
    if (!isValidIsoDate(rawTo)) throw codedError('COMMISSION_DATE_INVALID');
    paidDateTo = rawTo;
  }
  if (paidDateFrom && paidDateTo && paidDateFrom > paidDateTo) {
    throw codedError('COMMISSION_DATE_RANGE_INVALID');
  }

  const rawSearch = String(searchParams.get('search') || '').trim();
  const search = rawSearch ? rawSearch : undefined;

  return {
    status,
    recipientUserId,
    customerId,
    paidDateFrom,
    paidDateTo,
    search
  };
}

export function validateSettlePayload(dto) {
  assertPlainObject(dto, 'COMMISSION_PAYLOAD_INVALID');
  if (Object.keys(dto).some((key) => !SETTLE_PROPERTIES.includes(key))) {
    throw codedError('COMMISSION_PROPERTY_INVALID');
  }

  const shipmentId = normalizeRequiredString(dto.shipmentId, 'COMMISSION_SHIPMENT_REQUIRED');
  const recipientUserId = normalizeRequiredString(dto.recipientUserId, 'COMMISSION_RECIPIENT_REQUIRED');
  if (typeof dto.paidDate !== 'string' || !isValidIsoDate(dto.paidDate)) {
    throw codedError('COMMISSION_PAID_DATE_INVALID');
  }
  const paidDate = dto.paidDate.trim();
  const paymentReference = normalizeOptionalString(dto.paymentReference, 'COMMISSION_FIELD_INVALID');
  const note = normalizeOptionalString(dto.note, 'COMMISSION_FIELD_INVALID');
  const requestKey = normalizeRequiredString(dto.requestKey, 'COMMISSION_REQUEST_KEY_REQUIRED');

  return {
    shipmentId,
    recipientUserId,
    paidDate,
    paymentReference,
    note,
    requestKey
  };
}

export function validateSettlementNoteUpdate(dto) {
  assertPlainObject(dto, 'COMMISSION_PAYLOAD_INVALID');
  const keys = Object.keys(dto);
  if (keys.length === 0) throw codedError('COMMISSION_PAYLOAD_INVALID');
  if (keys.some((key) => !NOTE_UPDATE_PROPERTIES.includes(key))) {
    throw codedError('COMMISSION_PROPERTY_INVALID');
  }

  const hasPaymentReference = Object.hasOwn(dto, 'paymentReference');
  const hasNote = Object.hasOwn(dto, 'note');
  return {
    hasPaymentReference,
    paymentReference: hasPaymentReference ? normalizeOptionalString(dto.paymentReference, 'COMMISSION_FIELD_INVALID') : undefined,
    hasNote,
    note: hasNote ? normalizeOptionalString(dto.note, 'COMMISSION_FIELD_INVALID') : undefined
  };
}
