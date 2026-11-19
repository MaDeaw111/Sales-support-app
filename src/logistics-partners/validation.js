export const LOGISTICS_PARTNER_TYPES = Object.freeze([
  'FORWARDER',
  'SHIPPING_LINE',
  'TRUCKING',
  'SURVEYOR'
]);

export const LOGISTICS_PARTNER_STATUSES = Object.freeze([
  'ACTIVE',
  'INACTIVE'
]);

export const RATE_CURRENCIES = Object.freeze([
  'THB',
  'USD',
  'EUR'
]);

export const RATE_CONTAINER_SIZES = Object.freeze([
  '20GP',
  '40GP',
  '40HC',
  'BULK',
  'OTHER',
  '-'
]);

export const RATE_STATUSES = Object.freeze([
  'ACTIVE',
  'INACTIVE'
]);

const PARTNER_PROPERTIES = [
  'partnerName',
  'partnerType',
  'status',
  'contactName',
  'contactPhone',
  'contactEmail',
  'address',
  'taxId',
  'note'
];

const RATE_PROPERTIES = [
  'serviceType',
  'routeScope',
  'containerSize',
  'unit',
  'price',
  'currency',
  'effectiveDate',
  'validUntil',
  'status',
  'note'
];

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function isSupportedMoneyAmount(value) {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value > 0 &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.0000001
  );
}

function normalizeOptionalString(value, errorCode) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw codedError(errorCode);
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeRequiredString(value, errorCode) {
  if (typeof value !== 'string') throw codedError(errorCode);
  const trimmed = value.trim();
  if (!trimmed) throw codedError(errorCode);
  return trimmed;
}

function assertPlainObject(dto, errorCode) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw codedError(errorCode);
  }
}

export function validatePartnerCreate(dto) {
  assertPlainObject(dto, 'SERVICE_PARTNER_PAYLOAD_INVALID');
  if (Object.keys(dto).some((key) => !PARTNER_PROPERTIES.includes(key))) {
    throw codedError('SERVICE_PARTNER_PROPERTY_INVALID');
  }

  const partnerName = normalizeRequiredString(dto.partnerName, 'SERVICE_PARTNER_NAME_REQUIRED');
  const partnerType = dto.partnerType;
  if (!LOGISTICS_PARTNER_TYPES.includes(partnerType)) {
    throw codedError('SERVICE_PARTNER_TYPE_INVALID');
  }

  const status = dto.status === undefined ? 'ACTIVE' : dto.status;
  if (!LOGISTICS_PARTNER_STATUSES.includes(status)) {
    throw codedError('SERVICE_PARTNER_STATUS_INVALID');
  }

  const contactName = normalizeOptionalString(dto.contactName, 'SERVICE_PARTNER_FIELD_INVALID');
  const contactPhone = normalizeOptionalString(dto.contactPhone, 'SERVICE_PARTNER_FIELD_INVALID');
  const contactEmail = normalizeOptionalString(dto.contactEmail, 'SERVICE_PARTNER_EMAIL_INVALID');
  if (contactEmail !== null && !EMAIL_RE.test(contactEmail)) {
    throw codedError('SERVICE_PARTNER_EMAIL_INVALID');
  }
  const address = normalizeOptionalString(dto.address, 'SERVICE_PARTNER_FIELD_INVALID');
  const taxId = normalizeOptionalString(dto.taxId, 'SERVICE_PARTNER_FIELD_INVALID');
  const note = normalizeOptionalString(dto.note, 'SERVICE_PARTNER_FIELD_INVALID');

  return {
    partnerName,
    partnerType,
    status,
    contactName,
    contactPhone,
    contactEmail,
    address,
    taxId,
    note
  };
}

export function validatePartnerUpdate(dto, existing) {
  assertPlainObject(dto, 'SERVICE_PARTNER_PAYLOAD_INVALID');
  if (Object.keys(dto).length === 0) {
    throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
  }
  if (Object.keys(dto).some((key) => !PARTNER_PROPERTIES.includes(key))) {
    throw codedError('SERVICE_PARTNER_PROPERTY_INVALID');
  }
  if (dto.partnerType !== undefined && dto.partnerType !== existing.partner_type) {
    throw codedError('SERVICE_PARTNER_TYPE_IMMUTABLE');
  }

  const merged = {
    partnerName: Object.hasOwn(dto, 'partnerName') ? dto.partnerName : existing.partner_name,
    partnerType: existing.partner_type,
    status: Object.hasOwn(dto, 'status') ? dto.status : existing.status,
    contactName: Object.hasOwn(dto, 'contactName') ? dto.contactName : existing.contact_name,
    contactPhone: Object.hasOwn(dto, 'contactPhone') ? dto.contactPhone : existing.contact_phone,
    contactEmail: Object.hasOwn(dto, 'contactEmail') ? dto.contactEmail : existing.contact_email,
    address: Object.hasOwn(dto, 'address') ? dto.address : existing.address,
    taxId: Object.hasOwn(dto, 'taxId') ? dto.taxId : existing.tax_id,
    note: Object.hasOwn(dto, 'note') ? dto.note : existing.note
  };

  return validatePartnerCreate(merged);
}

export function validateRateCreate(dto) {
  assertPlainObject(dto, 'PARTNER_RATE_PAYLOAD_INVALID');
  if (Object.keys(dto).some((key) => !RATE_PROPERTIES.includes(key))) {
    throw codedError('PARTNER_RATE_PROPERTY_INVALID');
  }

  const serviceType = normalizeRequiredString(dto.serviceType, 'PARTNER_RATE_SERVICE_TYPE_REQUIRED');
  const routeScope = normalizeOptionalString(dto.routeScope, 'PARTNER_RATE_FIELD_INVALID');
  const containerSize = dto.containerSize === undefined || dto.containerSize === null ? '-' : dto.containerSize;
  if (!RATE_CONTAINER_SIZES.includes(containerSize)) {
    throw codedError('PARTNER_RATE_CONTAINER_SIZE_INVALID');
  }
  const unit = normalizeRequiredString(dto.unit, 'PARTNER_RATE_UNIT_REQUIRED');

  if (!isSupportedMoneyAmount(dto.price)) {
    throw codedError('PARTNER_RATE_PRICE_INVALID');
  }
  const price = Math.round(dto.price * 100) / 100;

  if (!RATE_CURRENCIES.includes(dto.currency)) {
    throw codedError('PARTNER_RATE_CURRENCY_INVALID');
  }

  if (typeof dto.effectiveDate !== 'string' || !isValidIsoDate(dto.effectiveDate)) {
    throw codedError('PARTNER_RATE_EFFECTIVE_DATE_INVALID');
  }
  const effectiveDate = dto.effectiveDate.trim();

  let validUntil = null;
  if (dto.validUntil !== undefined && dto.validUntil !== null) {
    if (typeof dto.validUntil !== 'string') {
      throw codedError('PARTNER_RATE_VALID_UNTIL_INVALID');
    }
    const trimmedValidUntil = dto.validUntil.trim();
    if (trimmedValidUntil) {
      if (!isValidIsoDate(trimmedValidUntil)) {
        throw codedError('PARTNER_RATE_VALID_UNTIL_INVALID');
      }
      validUntil = trimmedValidUntil;
    }
  }

  if (validUntil !== null && validUntil < effectiveDate) {
    throw codedError('PARTNER_RATE_DATE_RANGE_INVALID');
  }

  const status = dto.status === undefined ? 'ACTIVE' : dto.status;
  if (!RATE_STATUSES.includes(status)) {
    throw codedError('PARTNER_RATE_STATUS_INVALID');
  }

  const note = normalizeOptionalString(dto.note, 'PARTNER_RATE_FIELD_INVALID');

  return {
    serviceType,
    routeScope,
    containerSize,
    unit,
    price,
    currency: dto.currency,
    effectiveDate,
    validUntil,
    status,
    note
  };
}

export function validateRateUpdate(dto, existing) {
  assertPlainObject(dto, 'PARTNER_RATE_PAYLOAD_INVALID');
  if (Object.keys(dto).length === 0) {
    throw codedError('PARTNER_RATE_PAYLOAD_INVALID');
  }
  if (Object.keys(dto).some((key) => !RATE_PROPERTIES.includes(key))) {
    throw codedError('PARTNER_RATE_PROPERTY_INVALID');
  }

  const merged = {
    serviceType: Object.hasOwn(dto, 'serviceType') ? dto.serviceType : existing.service_type,
    routeScope: Object.hasOwn(dto, 'routeScope') ? dto.routeScope : existing.route_scope,
    containerSize: Object.hasOwn(dto, 'containerSize') ? dto.containerSize : existing.container_size,
    unit: Object.hasOwn(dto, 'unit') ? dto.unit : existing.unit,
    price: Object.hasOwn(dto, 'price') ? dto.price : existing.price,
    currency: Object.hasOwn(dto, 'currency') ? dto.currency : existing.currency,
    effectiveDate: Object.hasOwn(dto, 'effectiveDate') ? dto.effectiveDate : existing.effective_date,
    validUntil: Object.hasOwn(dto, 'validUntil') ? dto.validUntil : existing.valid_until,
    status: Object.hasOwn(dto, 'status') ? dto.status : existing.status,
    note: Object.hasOwn(dto, 'note') ? dto.note : existing.note
  };

  return validateRateCreate(merged);
}

export function parsePartnerListQuery(searchParams) {
  const rawType = String(searchParams.get('partnerType') || '').trim();
  let partnerType;
  if (rawType && rawType.toUpperCase() !== 'ALL') {
    const upper = rawType.toUpperCase();
    if (!LOGISTICS_PARTNER_TYPES.includes(upper)) {
      throw codedError('SERVICE_PARTNER_TYPE_INVALID');
    }
    partnerType = upper;
  }

  const rawStatus = String(searchParams.get('status') || '').trim();
  let status;
  if (rawStatus && rawStatus.toUpperCase() !== 'ALL') {
    const upper = rawStatus.toUpperCase();
    if (!LOGISTICS_PARTNER_STATUSES.includes(upper)) {
      throw codedError('SERVICE_PARTNER_STATUS_INVALID');
    }
    status = upper;
  }

  const rawSearch = String(searchParams.get('search') || '').trim();
  const search = rawSearch ? rawSearch : undefined;

  return { partnerType, status, search };
}
