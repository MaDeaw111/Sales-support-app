const ALLOWED_CURRENCIES = new Set(['USD', 'THB', 'EUR']);

function isValidIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function validateStandardPriceInput(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new Error('Invalid request body.');
  }

  const rawPrice = dto.pricePerMt !== undefined ? dto.pricePerMt : dto.fobUsdPerMt;
  const pricePerMt = Number(rawPrice);
  if (!Number.isFinite(pricePerMt) || pricePerMt <= 0) {
    throw new Error('Standard price per MT must be greater than zero.');
  }

  const currency = String(dto.currency || 'USD').trim().toUpperCase();
  if (!ALLOWED_CURRENCIES.has(currency)) {
    throw new Error('Currency must be USD, THB, or EUR.');
  }

  const rawEffectiveFrom = dto.effectiveFrom !== undefined ? dto.effectiveFrom : dto.effectiveDate;
  const effectiveFrom = typeof rawEffectiveFrom === 'string' && rawEffectiveFrom.trim()
    ? rawEffectiveFrom.trim()
    : new Date().toISOString().slice(0, 10);
  if (!isValidIsoDate(effectiveFrom)) {
    throw new Error('Effective date must be a valid YYYY-MM-DD date.');
  }

  const rawValidUntil = dto.validUntil;
  let validUntil = null;
  if (rawValidUntil !== undefined && rawValidUntil !== null && String(rawValidUntil).trim() !== '') {
    validUntil = String(rawValidUntil).trim();
    if (!isValidIsoDate(validUntil)) {
      throw new Error('Valid until date must be a valid YYYY-MM-DD date.');
    }
    if (validUntil < effectiveFrom) {
      throw new Error('Valid until date cannot be earlier than effective date.');
    }
  }

  const rawReason = dto.changeReason !== undefined ? dto.changeReason : dto.reason;
  if (rawReason !== undefined && rawReason !== null && typeof rawReason !== 'string') {
    throw new Error('Change reason must be a string.');
  }
  const changeReason = String(rawReason || '').trim();
  if (changeReason.length > 500) {
    throw new Error('Change reason must be 500 characters or fewer.');
  }

  return {
    pricePerMt: Math.round(pricePerMt * 100) / 100,
    currency,
    effectiveFrom,
    validUntil,
    changeReason
  };
}

export function validateSpecialPriceRequest(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new Error('Invalid request body.');
  }

  const customerId = String(dto.customerId || '').trim();
  const productId = String(dto.productId || '').trim();
  if (!customerId || !productId) {
    throw new Error('customerId and productId are required.');
  }

  const rawPrice = dto.approvedPriceUsd !== undefined ? dto.approvedPriceUsd : dto.requestedPriceUsd;
  const approvedPriceUsd = Number(rawPrice);
  if (!Number.isFinite(approvedPriceUsd) || approvedPriceUsd <= 0) {
    throw new Error('Requested price must be greater than zero.');
  }

  const expectedQtyMt = dto.expectedQtyMt !== undefined && dto.expectedQtyMt !== null && dto.expectedQtyMt !== ''
    ? Number(dto.expectedQtyMt)
    : 0;
  if (!Number.isFinite(expectedQtyMt) || expectedQtyMt < 0) {
    throw new Error('Expected quantity must be zero or greater.');
  }

  let validUntil = null;
  if (dto.validUntil !== undefined && dto.validUntil !== null && String(dto.validUntil).trim() !== '') {
    validUntil = String(dto.validUntil).trim();
    if (!isValidIsoDate(validUntil)) {
      throw new Error('Valid until date must be a valid YYYY-MM-DD date.');
    }
  }

  const reason = String(dto.reason || '').trim();
  if (reason.length > 500) {
    throw new Error('Reason must be 500 characters or fewer.');
  }

  return {
    customerId,
    productId,
    approvedPriceUsd: Math.round(approvedPriceUsd * 100) / 100,
    expectedQtyMt,
    validUntil,
    reason
  };
}

export function validateSpecialPriceReview(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) {
    throw new Error('Invalid request body.');
  }
  const decision = String(dto.decision || '').trim().toUpperCase();
  if (!['APPROVE', 'REJECT'].includes(decision)) {
    throw new Error('Decision must be APPROVE or REJECT.');
  }
  return { decision };
}
