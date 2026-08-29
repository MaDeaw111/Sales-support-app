const PARTNER_TYPES = ['FORWARDER', 'SHIPPING_LINE', 'TRUCKING', 'SURVEYOR'];
const PARTNER_STATUSES = ['ACTIVE', 'INACTIVE'];
const PARTNER_PROPERTIES = ['companyName', 'partnerType', 'status'];

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

export { codedError };
