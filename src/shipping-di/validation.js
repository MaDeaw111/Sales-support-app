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
const SHIPMENT_BOOKING_PROPERTIES = [
  'bookingNo',
  'forwarderPartnerId',
  'shippingLinePartnerId',
  'truckingPartnerId',
  'vessel',
  'etd',
  'eta',
  'plannedLoadingDate'
];
const SHIPMENT_SCHEDULE_PROPERTIES = ['plannedLoadingDate', 'actualLoadingDate', 'scheduleNote'];
const SHIPMENT_CONTAINER_PROPERTIES = ['containerNo', 'sealNo', 'lines'];
const SHIPMENT_CONTAINER_LINE_PROPERTIES = ['poRevisionLineId', 'numberOfBags', 'netWeightMt'];

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

export function validateDeliveryInstructionUpdate(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto) || Object.keys(dto).length === 0) {
    throw codedError('DI_UPDATE_PAYLOAD_INVALID');
  }
  if (Object.keys(dto).some((property) => !DELIVERY_INSTRUCTION_PROPERTIES.includes(property))) {
    throw codedError('DI_PROPERTY_INVALID');
  }
  return dto;
}

export function validateCancellationNote(note) {
  if (typeof note !== 'string' || !note.trim()) throw codedError('CANCEL_NOTE_REQUIRED');
  return note.trim();
}

function optionalBookingText(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw codedError('SHIPMENT_BOOKING_VALUE_INVALID');
  return value.trim();
}

function optionalBookingDate(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) {
    throw codedError('SHIPMENT_BOOKING_DATE_INVALID');
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw codedError('SHIPMENT_BOOKING_DATE_INVALID');
  }
  return value;
}

function requiredScheduleDate(value) {
  if (typeof value !== 'string' || !value) throw codedError('SHIPMENT_SCHEDULE_DATE_REQUIRED');
  try {
    return optionalBookingDate(value);
  } catch {
    throw codedError('SHIPMENT_SCHEDULE_DATE_INVALID');
  }
}

export function validateShipmentBooking(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('SHIPMENT_BOOKING_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !SHIPMENT_BOOKING_PROPERTIES.includes(property))) {
    throw codedError('SHIPMENT_BOOKING_PROPERTY_INVALID');
  }

  const bookingNo = typeof dto.bookingNo === 'string' ? dto.bookingNo.trim() : '';
  if (!bookingNo) throw codedError('SHIPMENT_BOOKING_NUMBER_REQUIRED');

  return {
    bookingNo,
    forwarderPartnerId: optionalId(dto.forwarderPartnerId, 'SHIPMENT_FORWARDER_INVALID'),
    shippingLinePartnerId: optionalId(dto.shippingLinePartnerId, 'SHIPMENT_SHIPPING_LINE_INVALID'),
    truckingPartnerId: optionalId(dto.truckingPartnerId, 'SHIPMENT_TRUCKING_INVALID'),
    vessel: optionalBookingText(dto.vessel),
    etd: optionalBookingDate(dto.etd),
    eta: optionalBookingDate(dto.eta),
    plannedLoadingDate: optionalBookingDate(dto.plannedLoadingDate)
  };
}

export function calculateScheduleResult(shippingMonth, shippingPeriod, actualLoadingDate) {
  const actualDate = requiredScheduleDate(actualLoadingDate);
  const actualMonth = actualDate.slice(0, 7);
  const actualDay = Number(actualDate.slice(8, 10));
  if (actualMonth !== shippingMonth) return 'OUT_OF_PLAN';
  if (shippingPeriod === 'FIRST_HALF') return actualDay <= 15 ? 'ON_PLAN' : 'OUT_OF_PLAN';
  if (shippingPeriod === 'SECOND_HALF') return actualDay >= 16 ? 'ON_PLAN' : 'OUT_OF_PLAN';
  throw codedError('DI_SHIPPING_PERIOD_INVALID');
}

export function validateShipmentSchedule(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto) || Object.keys(dto).length === 0) {
    throw codedError('SHIPMENT_SCHEDULE_PAYLOAD_INVALID');
  }
  if (Object.keys(dto).some((property) => !SHIPMENT_SCHEDULE_PROPERTIES.includes(property))) {
    throw codedError('SHIPMENT_SCHEDULE_PROPERTY_INVALID');
  }

  const hasPlannedLoadingDate = Object.hasOwn(dto, 'plannedLoadingDate');
  const hasActualLoadingDate = Object.hasOwn(dto, 'actualLoadingDate');
  if (hasPlannedLoadingDate === hasActualLoadingDate) throw codedError('SHIPMENT_SCHEDULE_DATE_REQUIRED');
  if (Object.hasOwn(dto, 'scheduleNote') && !hasActualLoadingDate) {
    throw codedError('SHIPMENT_SCHEDULE_NOTE_WITHOUT_ACTUAL_LOADING_DATE');
  }
  if (dto.scheduleNote !== undefined && dto.scheduleNote !== null && typeof dto.scheduleNote !== 'string') {
    throw codedError('SHIPMENT_SCHEDULE_NOTE_INVALID');
  }

  return {
    plannedLoadingDate: hasPlannedLoadingDate ? requiredScheduleDate(dto.plannedLoadingDate) : undefined,
    actualLoadingDate: hasActualLoadingDate ? requiredScheduleDate(dto.actualLoadingDate) : undefined,
    scheduleNote: dto.scheduleNote === undefined ? undefined : dto.scheduleNote?.trim() || null
  };
}

export function validateShipmentContainers(containers) {
  if (!Array.isArray(containers) || containers.length === 0) {
    throw codedError('SHIPMENT_CONTAINERS_REQUIRED');
  }

  const seenContainerNumbers = new Set();
  return containers.map((container) => {
    if (!container || typeof container !== 'object' || Array.isArray(container)) {
      throw codedError('SHIPMENT_CONTAINER_INVALID');
    }
    if (Object.keys(container).some((property) => !SHIPMENT_CONTAINER_PROPERTIES.includes(property))) {
      throw codedError('SHIPMENT_CONTAINER_PROPERTY_INVALID');
    }
    const containerNo = typeof container.containerNo === 'string' ? container.containerNo.trim() : '';
    if (!containerNo) throw codedError('SHIPMENT_CONTAINER_NO_REQUIRED');
    if (seenContainerNumbers.has(containerNo)) throw codedError('SHIPMENT_CONTAINER_NO_DUPLICATE');
    seenContainerNumbers.add(containerNo);
    const sealNo = container.sealNo === undefined || container.sealNo === null
      ? null
      : optionalBookingText(container.sealNo);
    if (!Array.isArray(container.lines) || container.lines.length === 0) {
      throw codedError('SHIPMENT_CONTAINER_LINES_REQUIRED');
    }
    const seenLineIds = new Set();
    const lines = container.lines.map((line) => {
      if (!line || typeof line !== 'object' || Array.isArray(line)) throw codedError('SHIPMENT_CONTAINER_LINE_INVALID');
      if (Object.keys(line).some((property) => !SHIPMENT_CONTAINER_LINE_PROPERTIES.includes(property))) {
        throw codedError('SHIPMENT_CONTAINER_LINE_PROPERTY_INVALID');
      }
      const poRevisionLineId = requiredId(line.poRevisionLineId, 'SHIPMENT_CONTAINER_LINE_PO_LINE_REQUIRED');
      if (seenLineIds.has(poRevisionLineId)) throw codedError('SHIPMENT_CONTAINER_LINE_DUPLICATE');
      seenLineIds.add(poRevisionLineId);
      if (!Number.isInteger(line.numberOfBags) || line.numberOfBags <= 0) {
        throw codedError('SHIPMENT_CONTAINER_LINE_BAG_COUNT_INVALID');
      }
      if (typeof line.netWeightMt !== 'number' || !Number.isFinite(line.netWeightMt) || line.netWeightMt <= 0) {
        throw codedError('SHIPMENT_CONTAINER_LINE_NET_WEIGHT_INVALID');
      }
      return { poRevisionLineId, numberOfBags: line.numberOfBags, netWeightMt: line.netWeightMt };
    });
    return { containerNo, sealNo, lines };
  });
}

export { codedError };
