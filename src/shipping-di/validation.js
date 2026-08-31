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
  'containerPlan',
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
const SHIPMENT_INVOICE_PROPERTIES = ['invoiceNo', 'version', 'invoiceDate', 'lines'];
const SHIPMENT_DOCUMENT_PROPERTIES = [
  'allShipDocsDriveUrl',
  'digitalDocsSentDate',
  'originalDocsRequired',
  'dhlSentDate',
  'dhlTrackingNo',
  'docsNote'
];
const CUSTOMER_CREDIT_PROPERTIES = ['customerId', 'amount', 'reason', 'requestKey'];
const CUSTOMER_CREDIT_USAGE_PROPERTIES = ['creditId', 'amount', 'invoiceId', 'requestKey'];
const SHIPMENT_PAYMENT_PROPERTIES = ['cashReceivedAmount', 'paymentNote'];

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isSupportedMoneyAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) &&
    Math.abs(value * 100 - Math.round(value * 100)) < 0.0000001;
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

function validateGoogleDriveUrl(value, code = 'DI_GOOGLE_DRIVE_URL_INVALID') {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw codedError(code);

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      !['drive.google.com', 'docs.google.com'].includes(url.hostname)
    ) {
      throw codedError(code);
    }
  } catch (error) {
    if (error.code === code) throw error;
    throw codedError(code);
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

export function validateDeliveryInstructionContainerPlan(value) {
  if (typeof value !== 'string' || !value.trim()) throw codedError('DI_CONTAINER_PLAN_REQUIRED');
  return value.trim();
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
  const containerPlan = validateDeliveryInstructionContainerPlan(dto.containerPlan);
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
    containerPlan,
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

function validateGoogleDriveFolderUrl(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !value.trim()) throw codedError('ALL_SHIP_DOCS_DRIVE_URL_INVALID');

  try {
    const url = new URL(value);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'drive.google.com' ||
      !/^\/(?:drive(?:\/u\/\d+)?\/)?folders?\/[^/?#]+\/?$/.test(url.pathname)
    ) {
      throw codedError('ALL_SHIP_DOCS_DRIVE_URL_INVALID');
    }
  } catch (error) {
    if (error.code === 'ALL_SHIP_DOCS_DRIVE_URL_INVALID') throw error;
    throw codedError('ALL_SHIP_DOCS_DRIVE_URL_INVALID');
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

function validateInvoiceDate(value) {
  if (value === undefined || value === null) throw codedError('INVOICE_DATE_REQUIRED');
  try {
    return optionalBookingDate(value);
  } catch {
    throw codedError('INVOICE_DATE_INVALID');
  }
}

function validateInvoiceLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw codedError('INVOICE_LINES_REQUIRED');
  const lineIds = new Set();
  return lines.map((line) => {
    if (!line || typeof line !== 'object' || Array.isArray(line)) throw codedError('INVOICE_LINE_INVALID');
    if (Object.keys(line).some((property) => !['poRevisionLineId', 'qtyMt'].includes(property))) {
      throw codedError('INVOICE_LINE_PROPERTY_INVALID');
    }
    const poRevisionLineId = requiredId(line.poRevisionLineId, 'INVOICE_LINE_PO_LINE_REQUIRED');
    if (lineIds.has(poRevisionLineId)) throw codedError('INVOICE_LINE_DUPLICATE');
    lineIds.add(poRevisionLineId);
    if (typeof line.qtyMt !== 'number' || !Number.isFinite(line.qtyMt) || line.qtyMt <= 0) {
      throw codedError('INVOICE_LINE_QTY_INVALID');
    }
    return { poRevisionLineId, qtyMt: line.qtyMt };
  });
}

export function validateShipmentInvoice(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('INVOICE_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !SHIPMENT_INVOICE_PROPERTIES.includes(property))) {
    throw codedError('INVOICE_PROPERTY_INVALID');
  }
  const invoiceNo = typeof dto.invoiceNo === 'string' ? dto.invoiceNo.trim() : '';
  if (!invoiceNo) throw codedError('INVOICE_NUMBER_REQUIRED');
  if (!['PRELIMINARY', 'FINAL'].includes(dto.version)) throw codedError('INVOICE_VERSION_INVALID');
  return {
    invoiceNo,
    version: dto.version,
    invoiceDate: validateInvoiceDate(dto.invoiceDate),
    lines: validateInvoiceLines(dto.lines)
  };
}

export function validateShipmentInvoiceFinalization(lines) {
  return validateInvoiceLines(lines);
}

export function validateCustomerCredit(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('CREDIT_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !CUSTOMER_CREDIT_PROPERTIES.includes(property))) {
    throw codedError('CREDIT_PROPERTY_INVALID');
  }
  const customerId = requiredId(dto.customerId, 'CREDIT_CUSTOMER_REQUIRED');
  if (!isSupportedMoneyAmount(dto.amount) || dto.amount <= 0) {
    throw codedError('CREDIT_AMOUNT_INVALID');
  }
  const reason = typeof dto.reason === 'string' ? dto.reason.trim() : '';
  if (!reason) throw codedError('CREDIT_REASON_REQUIRED');
  const requestKey = typeof dto.requestKey === 'string' ? dto.requestKey.trim() : '';
  if (!requestKey || requestKey.length > 200) throw codedError('CREDIT_REQUEST_KEY_INVALID');
  return { customerId, amount: dto.amount, reason, requestKey };
}

export function validateCustomerCreditUsage(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('CREDIT_USAGE_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !CUSTOMER_CREDIT_USAGE_PROPERTIES.includes(property))) {
    throw codedError('CREDIT_USAGE_PROPERTY_INVALID');
  }
  const creditId = requiredId(dto.creditId, 'CREDIT_USAGE_CREDIT_REQUIRED');
  if (!isSupportedMoneyAmount(dto.amount) || dto.amount <= 0) {
    throw codedError('CREDIT_USAGE_AMOUNT_INVALID');
  }
  const invoiceId = dto.invoiceId === undefined || dto.invoiceId === null
    ? null
    : requiredId(dto.invoiceId, 'CREDIT_USAGE_INVOICE_INVALID');
  const requestKey = typeof dto.requestKey === 'string' ? dto.requestKey.trim() : '';
  if (!requestKey || requestKey.length > 200) throw codedError('CREDIT_USAGE_REQUEST_KEY_INVALID');
  return { creditId, amount: dto.amount, invoiceId, requestKey };
}

export function validateShipmentPayment(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('PAYMENT_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !SHIPMENT_PAYMENT_PROPERTIES.includes(property))) {
    throw codedError('PAYMENT_PROPERTY_INVALID');
  }
  if (!isSupportedMoneyAmount(dto.cashReceivedAmount) || dto.cashReceivedAmount < 0) {
    throw codedError('PAYMENT_CASH_RECEIVED_AMOUNT_INVALID');
  }
  if (dto.paymentNote !== undefined && dto.paymentNote !== null && typeof dto.paymentNote !== 'string') {
    throw codedError('PAYMENT_NOTE_INVALID');
  }
  return {
    cashReceivedAmount: dto.cashReceivedAmount,
    paymentNote: dto.paymentNote === undefined ? null : dto.paymentNote?.trim() || null
  };
}

function requiredDocumentDate(value, requiredCode, invalidCode) {
  if (value === undefined || value === null || value === '') throw codedError(requiredCode);
  try {
    return optionalBookingDate(value);
  } catch {
    throw codedError(invalidCode);
  }
}

function optionalDocumentDate(value, invalidCode) {
  if (value === undefined || value === null) return null;
  try {
    return optionalBookingDate(value);
  } catch {
    throw codedError(invalidCode);
  }
}

export function isDocumentRequirementSatisfied(documents) {
  const value = (camelCase, snakeCase) => documents?.[camelCase] ?? documents?.[snakeCase];
  const allShipDocsDriveUrl = value('allShipDocsDriveUrl', 'all_ship_docs_drive_url');
  const digitalDocsSentDate = value('digitalDocsSentDate', 'digital_docs_sent_date');
  const originalDocsRequired = value('originalDocsRequired', 'original_docs_required');
  const dhlSentDate = value('dhlSentDate', 'dhl_sent_date');
  const dhlTrackingNo = value('dhlTrackingNo', 'dhl_tracking_no');
  return Boolean(
    allShipDocsDriveUrl &&
    digitalDocsSentDate &&
    (!originalDocsRequired || (dhlSentDate && dhlTrackingNo))
  );
}

export function validateShipmentDocuments(dto) {
  if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('SHIPMENT_DOCUMENTS_PAYLOAD_INVALID');
  if (Object.keys(dto).some((property) => !SHIPMENT_DOCUMENT_PROPERTIES.includes(property))) {
    throw codedError('SHIPMENT_DOCUMENTS_PROPERTY_INVALID');
  }

  const allShipDocsDriveUrl = validateGoogleDriveFolderUrl(dto.allShipDocsDriveUrl);
  if (!allShipDocsDriveUrl) throw codedError('ALL_SHIP_DOCS_DRIVE_URL_REQUIRED');
  const digitalDocsSentDate = requiredDocumentDate(
    dto.digitalDocsSentDate,
    'DIGITAL_DOCS_SENT_DATE_REQUIRED',
    'DIGITAL_DOCS_SENT_DATE_INVALID'
  );
  if (typeof dto.originalDocsRequired !== 'boolean') throw codedError('ORIGINAL_DOCS_REQUIRED_INVALID');
  const dhlSentDate = optionalDocumentDate(dto.dhlSentDate, 'DHL_SENT_DATE_INVALID');
  const dhlTrackingNo = dto.dhlTrackingNo === undefined || dto.dhlTrackingNo === null
    ? null
    : optionalBookingText(dto.dhlTrackingNo);
  if (dto.originalDocsRequired && (!dhlSentDate || !dhlTrackingNo)) throw codedError('DHL_DETAILS_REQUIRED');
  if (!dto.originalDocsRequired && (dhlSentDate || dhlTrackingNo)) throw codedError('DHL_DETAILS_NOT_ALLOWED');
  if (dto.docsNote !== undefined && dto.docsNote !== null && typeof dto.docsNote !== 'string') {
    throw codedError('DOCS_NOTE_INVALID');
  }

  const documents = {
    allShipDocsDriveUrl,
    digitalDocsSentDate,
    originalDocsRequired: dto.originalDocsRequired,
    dhlSentDate,
    dhlTrackingNo,
    docsNote: dto.docsNote?.trim() || null
  };
  if (!isDocumentRequirementSatisfied(documents)) throw codedError('DOCUMENT_REQUIREMENT_NOT_SATISFIED');
  return documents;
}

export { codedError };
