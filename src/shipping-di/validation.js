const PARTNER_TYPES = ['FORWARDER', 'SHIPPING_LINE', 'TRUCKING', 'SURVEYOR'];
const PARTNER_STATUSES = ['ACTIVE', 'INACTIVE'];
const PARTNER_PROPERTIES = ['companyName', 'partnerType', 'status'];
const DELIVERY_INSTRUCTION_PROPERTIES = [
  'customerId',
  'poId',
  'poRevisionId',
  'diNo',
  'shippingMonth',
  'shippingPeriod',
  'lines',
  'googleDriveUrl',
  'surveyorPartnerId',
  'forwarderPartnerId',
  'note'
];

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function validateServicePartner(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !PARTNER_PROPERTIES.includes(property))) {
    throw codedError('SERVICE_PARTNER_PROPERTY_INVALID');
  }

  const companyName = String(dto.companyName || '').trim();
  const partnerType = dto.partnerType;
  const status = dto.status === undefined ? 'ACTIVE' : dto.status;

  if (!companyName) throw codedError('SERVICE_PARTNER_NAME_REQUIRED');
  if (!PARTNER_TYPES.includes(partnerType)) throw codedError('SERVICE_PARTNER_TYPE_INVALID');
  if (!PARTNER_STATUSES.includes(status)) throw codedError('SERVICE_PARTNER_STATUS_INVALID');

  return { companyName, partnerType, status };
}

function requiredId(value, code) {
  if (typeof value !== 'string' || !value.trim()) throw codedError(code);
  return value;
}

function optionalId(value, code) {
  if (value === undefined || value === null) return null;
  return requiredId(value, code);
}

function validateGoogleDriveUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw codedError('DI_GOOGLE_DRIVE_URL_INVALID');

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['drive.google.com', 'docs.google.com'].includes(url.hostname)
    ) {
      throw codedError('DI_GOOGLE_DRIVE_URL_INVALID');
    }
  } catch (error) {
    if (error.code === 'DI_GOOGLE_DRIVE_URL_INVALID') throw error;
    throw codedError('DI_GOOGLE_DRIVE_URL_INVALID');
  }

  return value;
}

export function validateDeliveryInstructionAvailabilityLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw codedError('DI_LINES_REQUIRED');

  return lines.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw codedError('DI_LINE_INVALID');
    const poId = requiredId(line.poId, 'DI_LINE_PO_LINEAGE_INVALID');
    const poRevisionId = requiredId(line.poRevisionId, 'DI_LINE_PO_LINEAGE_INVALID');
    const poRevisionLineId = requiredId(line.poRevisionLineId, 'DI_LINE_PO_LINEAGE_INVALID');
    if (typeof line.plannedQtyMt !== 'number' || !Number.isFinite(line.plannedQtyMt) || line.plannedQtyMt <= 0) {
      throw codedError('DI_LINE_PLANNED_QTY_INVALID');
    }
    if (typeof line.packingSnapshot !== 'string' || !line.packingSnapshot.trim()) {
      throw codedError('DI_LINE_PACKING_REQUIRED');
    }
    return { poId, poRevisionId, poRevisionLineId, plannedQtyMt: line.plannedQtyMt, packingSnapshot: line.packingSnapshot.trim() };
  });
}

export function validateDeliveryInstruction(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('DI_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !DELIVERY_INSTRUCTION_PROPERTIES.includes(property))) {
    throw codedError('DI_PROPERTY_INVALID');
  }

  const customerId = requiredId(dto.customerId, 'DI_CUSTOMER_REQUIRED');
  const poId = requiredId(dto.poId, 'DI_PO_REQUIRED');
  const poRevisionId = requiredId(dto.poRevisionId, 'DI_PO_REVISION_REQUIRED');
  const diNo = dto.diNo === undefined || dto.diNo === null
    ? null
    : requiredId(dto.diNo, 'DI_NUMBER_INVALID');

  if (typeof dto.shippingMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(dto.shippingMonth)) {
    throw codedError('DI_SHIPPING_MONTH_INVALID');
  }
  if (!['FIRST_HALF', 'SECOND_HALF'].includes(dto.shippingPeriod)) {
    throw codedError('DI_SHIPPING_PERIOD_INVALID');
  }
  const lines = validateDeliveryInstructionAvailabilityLines(dto.lines);

  if (typeof dto.note !== 'undefined' && dto.note !== null && typeof dto.note !== 'string') {
    throw codedError('DI_NOTE_INVALID');
  }

  return {
    customerId,
    poId,
    poRevisionId,
    diNo,
    shippingMonth: dto.shippingMonth,
    shippingPeriod: dto.shippingPeriod,
    lines,
    googleDriveUrl: validateGoogleDriveUrl(dto.googleDriveUrl),
    surveyorPartnerId: optionalId(dto.surveyorPartnerId, 'DI_SURVEYOR_INVALID'),
    forwarderPartnerId: optionalId(dto.forwarderPartnerId, 'DI_FORWARDER_INVALID'),
    note: dto.note ?? null
  };
}

export { codedError };
