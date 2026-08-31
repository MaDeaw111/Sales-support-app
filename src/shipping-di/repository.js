import crypto from 'node:crypto';
import {
  codedError,
  validateDeliveryInstruction,
  validateDeliveryInstructionContainerPlan,
  validateDeliveryInstructionAvailabilityLines,
  validateDeliveryInstructionUpdate,
  validateCancellationNote,
  validateServicePartner,
  validateShipmentBooking,
  validateShipmentSchedule,
  validateShipmentContainers,
  validateShipmentInvoice,
  validateShipmentInvoiceFinalization,
  validateShipmentDocuments,
  validateCustomerCredit,
  validateCustomerCreditUsage,
  validateShipmentPayment,
  isDocumentRequirementSatisfied,
  calculateScheduleResult
} from './validation.js';

async function nextId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(partner_id, 4) AS INTEGER)), 0) AS max_id
    FROM service_partners
    WHERE partner_id GLOB 'SP-[0-9]*'
  `).first();
  return `SP-${String(Number(row?.max_id || 0) + 1).padStart(3, '0')}`;
}

async function findServicePartner(db, partnerId) {
  return db.prepare(`
    SELECT partner_id, partner_name, partner_type, status, created_by, created_at, updated_by, updated_at
    FROM service_partners
    WHERE partner_id = ?
  `).bind(partnerId).first();
}

async function nextInternalDiNo(db, poId) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(di_no, LENGTH(?) + 2) AS INTEGER)), 0) AS n
    FROM delivery_instructions
    WHERE po_id = ? AND di_no GLOB ?
  `).bind(poId, poId, `${poId}_[0-9]*`).first();
  return `${poId}_${String(Number(row?.n || 0) + 1).padStart(3, '0')}`;
}

function isInternalDiNoUniqueCollision(error) {
  return String(error?.message || '').includes(
    'UNIQUE constraint failed: delivery_instructions.customer_id, delivery_instructions.di_no'
  );
}

function isAvailabilityReservationFailure(error) {
  return String(error?.message || '').includes('CHECK constraint failed: planned_qty_mt > 0');
}

async function findDeliveryInstruction(db, diId) {
  const deliveryInstruction = await db.prepare(`
    SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan,
           status, lifecycle_version, note, cancellation_note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
           created_by, created_at, updated_by, updated_at
    FROM delivery_instructions
    WHERE di_id = ?
  `).bind(diId).first();
  if (!deliveryInstruction) return null;

  const { results: lines } = await db.prepare(`
    SELECT dil.di_line_id, dil.di_id, dil.po_id, dil.po_revision_id, dil.po_revision_line_id,
           dil.product_id, dil.planned_qty_mt, dil.packing_snapshot, dil.created_by,
           dil.created_at, dil.updated_by, dil.updated_at
    FROM delivery_instruction_lines dil
    JOIN po_revision_lines prl ON prl.line_id = dil.po_revision_line_id
    WHERE dil.di_id = ?
    ORDER BY prl.line_no ASC
  `).bind(diId).all();
  return { ...deliveryInstruction, lines: lines || [] };
}

async function findPhase6Shipment(db, identifier) {
  return db.prepare(`
    SELECT shipment_id, di_id, status, booking_no, forwarder_partner_id, shipping_line_partner_id,
           trucking_partner_id, vessel, etd, eta, planned_loading_date, actual_loading_date,
           schedule_result, schedule_note, all_ship_docs_drive_url, digital_docs_sent_date,
           original_docs_required, dhl_sent_date, dhl_tracking_no, docs_note, cash_received_amount,
           payment_status, payment_note, cancellation_note, container_version,
           final_invoice_version, final_invoice_write_token, created_by, created_at, updated_by, updated_at,
           COALESCE((
             SELECT SUM(container_line.qty_mt)
             FROM shipment_containers container
             JOIN shipment_container_lines container_line ON container_line.container_id = container.container_id
             WHERE container.shipment_id = phase6_shipments.shipment_id AND container.status <> 'CANCELLED'
           ), 0) AS actual_qty_mt
    FROM phase6_shipments
    WHERE shipment_id = ? OR di_id = ?
    LIMIT 1
  `).bind(identifier, identifier).first();
}

async function findShipmentContainerLineReferences(db, diId, containers) {
  const lineIds = [...new Set(containers.flatMap((container) => container.lines.map((line) => line.poRevisionLineId)))];
  const placeholders = lineIds.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    SELECT di_line_id, po_revision_line_id, planned_qty_mt
    FROM delivery_instruction_lines
    WHERE di_id = ? AND po_revision_line_id IN (${placeholders})
  `).bind(diId, ...lineIds).all();
  const references = new Map((results || []).map((line) => [line.po_revision_line_id, line]));
  for (const lineId of lineIds) {
    if (!references.has(lineId)) throw codedError('SHIPMENT_CONTAINER_LINE_PO_LINE_INVALID');
  }
  return references;
}

async function listShipmentContainers(db, shipmentId) {
  const { results: containers } = await db.prepare(`
    SELECT container_id, container_no, seal_no
    FROM shipment_containers
    WHERE shipment_id = ? AND status <> 'CANCELLED'
    ORDER BY rowid ASC
  `).bind(shipmentId).all();
  return Promise.all((containers || []).map(async (container) => {
    const { results: lines } = await db.prepare(`
      SELECT dil.po_revision_line_id, scl.number_of_bags, scl.qty_mt AS net_weight_mt
      FROM shipment_container_lines scl
      JOIN delivery_instruction_lines dil ON dil.di_line_id = scl.delivery_instruction_line_id
      WHERE scl.container_id = ?
      ORDER BY dil.po_revision_line_id ASC
    `).bind(container.container_id).all();
    const containerLines = (lines || []).map((line) => ({ ...line }));
    return {
      container_no: container.container_no,
      seal_no: container.seal_no,
      total_net_weight_mt: containerLines.reduce((total, line) => total + Number(line.net_weight_mt), 0),
      lines: containerLines
    };
  }));
}

function containerPoLineCapacityGuard(diLines, quantitiesByPoLine) {
  const clauses = [];
  const parameters = [];
  for (const line of diLines) {
    const poRevisionLineId = line.po_revision_line_id;
    const proposedActualQtyMt = Number(quantitiesByPoLine.get(poRevisionLineId) || 0);
    const proposedContribution = proposedActualQtyMt > 0
      ? proposedActualQtyMt
      : Number(line.planned_qty_mt);
    clauses.push(`
      AND ? + COALESCE((
        SELECT SUM(other_container_line.qty_mt)
        FROM shipment_container_lines other_container_line
        JOIN shipment_containers other_container ON other_container.container_id = other_container_line.container_id
        JOIN phase6_shipments other_shipment ON other_shipment.shipment_id = other_container.shipment_id
        JOIN delivery_instruction_lines other_actual_line
          ON other_actual_line.di_line_id = other_container_line.delivery_instruction_line_id
        WHERE other_actual_line.po_revision_line_id = ?
          AND other_shipment.shipment_id <> phase6_shipments.shipment_id
          AND other_shipment.status <> 'CANCELLED'
          AND other_container.status <> 'CANCELLED'
      ), 0) + COALESCE((
        SELECT SUM(other_planned_line.planned_qty_mt)
        FROM delivery_instruction_lines other_planned_line
        JOIN delivery_instructions other_planned_di ON other_planned_di.di_id = other_planned_line.di_id
        WHERE other_planned_line.po_revision_line_id = ?
          AND other_planned_line.di_id <> phase6_shipments.di_id
          AND other_planned_di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
          AND NOT EXISTS (
            SELECT 1
            FROM shipment_container_lines represented_line
            JOIN shipment_containers represented_container ON represented_container.container_id = represented_line.container_id
            JOIN phase6_shipments represented_shipment ON represented_shipment.shipment_id = represented_container.shipment_id
            WHERE represented_line.delivery_instruction_line_id = other_planned_line.di_line_id
              AND represented_shipment.status <> 'CANCELLED'
              AND represented_container.status <> 'CANCELLED'
          )
      ), 0) <= COALESCE((
        SELECT max_qty_mt FROM po_revision_lines WHERE line_id = ?
      ), -1) + 0.000001
    `);
    parameters.push(proposedContribution, poRevisionLineId, poRevisionLineId, poRevisionLineId);
  }
  return { sql: clauses.join(''), parameters };
}

async function assertContainerPoLineCapacity(db, shipment, diLines, quantitiesByPoLine) {
  for (const line of diLines) {
    const poRevisionLineId = line.po_revision_line_id;
    const proposedActualQtyMt = Number(quantitiesByPoLine.get(poRevisionLineId) || 0);
    const proposedContribution = proposedActualQtyMt > 0
      ? proposedActualQtyMt
      : Number(line.planned_qty_mt);
    const capacity = await db.prepare(`
      SELECT po_line.max_qty_mt
        - COALESCE((
          SELECT SUM(other_container_line.qty_mt)
          FROM shipment_container_lines other_container_line
          JOIN shipment_containers other_container ON other_container.container_id = other_container_line.container_id
          JOIN phase6_shipments other_shipment ON other_shipment.shipment_id = other_container.shipment_id
          JOIN delivery_instruction_lines other_actual_line
            ON other_actual_line.di_line_id = other_container_line.delivery_instruction_line_id
          WHERE other_actual_line.po_revision_line_id = po_line.line_id
            AND other_shipment.shipment_id <> ?
            AND other_shipment.status <> 'CANCELLED'
            AND other_container.status <> 'CANCELLED'
        ), 0)
        - COALESCE((
          SELECT SUM(other_planned_line.planned_qty_mt)
          FROM delivery_instruction_lines other_planned_line
          JOIN delivery_instructions other_planned_di ON other_planned_di.di_id = other_planned_line.di_id
          WHERE other_planned_line.po_revision_line_id = po_line.line_id
            AND other_planned_line.di_id <> ?
            AND other_planned_di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
            AND NOT EXISTS (
              SELECT 1
              FROM shipment_container_lines represented_line
              JOIN shipment_containers represented_container ON represented_container.container_id = represented_line.container_id
              JOIN phase6_shipments represented_shipment ON represented_shipment.shipment_id = represented_container.shipment_id
              WHERE represented_line.delivery_instruction_line_id = other_planned_line.di_line_id
                AND represented_shipment.status <> 'CANCELLED'
                AND represented_container.status <> 'CANCELLED'
            )
        ), 0) AS available_contribution_mt
      FROM po_revision_lines po_line
      WHERE po_line.line_id = ?
    `).bind(shipment.shipment_id, shipment.di_id, poRevisionLineId).first();
    if (!capacity || proposedContribution > Number(capacity.available_contribution_mt) + 0.000001) {
      throw codedError('CONTAINER_PO_LINE_QTY_EXCEEDS_MAX');
    }
  }
}

async function findPhase6ShipmentReadModel(db, identifier, lookupField) {
  const shipment = await db.prepare(`
    SELECT shipment.shipment_id, shipment.di_id, instruction.customer_id, instruction.di_no, instruction.container_plan,
           shipment.status, shipment.booking_no, shipment.forwarder_partner_id,
           shipment.shipping_line_partner_id, shipment.trucking_partner_id, shipment.vessel,
           shipment.etd, shipment.eta, shipment.planned_loading_date, shipment.actual_loading_date,
           shipment.schedule_result, shipment.schedule_note, shipment.all_ship_docs_drive_url,
           shipment.digital_docs_sent_date, shipment.original_docs_required, shipment.dhl_sent_date,
            shipment.dhl_tracking_no, shipment.docs_note, shipment.cash_received_amount,
            shipment.payment_status, shipment.payment_note, shipment.cancellation_note,
            ${finalInvoiceTotalExpression('shipment.shipment_id')} AS final_invoice_total,
            ${allocatedCreditExpression('shipment.shipment_id')} AS allocated_credit_amount,
            ROUND(shipment.cash_received_amount + ${allocatedCreditExpression('shipment.shipment_id')}, 2) AS payment_total,
            shipment.created_by, shipment.created_at, shipment.updated_by, shipment.updated_at
    FROM phase6_shipments shipment
    JOIN delivery_instructions instruction ON instruction.di_id = shipment.di_id
    WHERE shipment.${lookupField} = ?
  `).bind(identifier).first();
  if (!shipment) return null;

  const { results: products } = await db.prepare(`
    SELECT product.product_code, product.product_name, instruction_line.planned_qty_mt,
           instruction_line.packing_snapshot
    FROM delivery_instruction_lines instruction_line
    JOIN products product ON product.product_id = instruction_line.product_id
    WHERE instruction_line.di_id = ?
    ORDER BY instruction_line.di_line_id ASC
  `).bind(shipment.di_id).all();

  const { results: containerRows } = await db.prepare(`
    SELECT container.container_no, container.container_type, container.seal_no,
           product.product_code, product.product_name, container_line.number_of_bags,
           container_line.qty_mt
    FROM shipment_containers container
    LEFT JOIN shipment_container_lines container_line ON container_line.container_id = container.container_id
    LEFT JOIN delivery_instruction_lines instruction_line ON instruction_line.di_line_id = container_line.delivery_instruction_line_id
    LEFT JOIN products product ON product.product_id = instruction_line.product_id
    WHERE container.shipment_id = ? AND container.status <> 'CANCELLED'
    ORDER BY container.rowid ASC, container_line.rowid ASC
  `).bind(shipment.shipment_id).all();
  const containersByNumber = new Map();
  for (const row of containerRows || []) {
    if (!containersByNumber.has(row.container_no)) {
      containersByNumber.set(row.container_no, {
        container_no: row.container_no,
        container_type: row.container_type,
        seal_no: row.seal_no,
        lines: []
      });
    }
    if (row.product_code) {
      containersByNumber.get(row.container_no).lines.push({
        product_code: row.product_code,
        product_name: row.product_name,
        number_of_bags: Number(row.number_of_bags),
        qty_mt: Number(row.qty_mt)
      });
    }
  }
  const containers = [...containersByNumber.values()];
  return {
    ...shipment,
    final_invoice_total: Number(shipment.final_invoice_total),
    allocated_credit_amount: Number(shipment.allocated_credit_amount),
    payment_total: Number(shipment.payment_total),
    products: (products || []).map((product) => ({ ...product, planned_qty_mt: Number(product.planned_qty_mt) })),
    containers
  };
}

async function findShipmentInvoice(db, invoiceId) {
  const invoice = await db.prepare(`
    SELECT invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_version, invoice_write_token, final_container_version,
           created_by, created_at, updated_by, updated_at,
           COALESCE((SELECT SUM(line_amount) FROM shipment_invoice_lines WHERE invoice_id = shipment_invoices.invoice_id), 0) AS total_amount
    FROM shipment_invoices
    WHERE invoice_id = ?
  `).bind(invoiceId).first();
  if (!invoice) return null;
  const { results } = await db.prepare(`
    SELECT po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount
    FROM shipment_invoice_lines
    WHERE invoice_id = ?
    ORDER BY rowid ASC
  `).bind(invoiceId).all();
  return {
    ...invoice,
    total_amount: Number(invoice.total_amount),
    lines: (results || []).map((line) => ({
      ...line,
      qty_mt: Number(line.qty_mt),
      unit_price_snapshot: Number(line.unit_price_snapshot),
      line_amount: Number(line.line_amount)
    }))
  };
}

async function findShipmentInvoiceLineReferences(db, shipment, lines) {
  const lineIds = lines.map((line) => line.poRevisionLineId);
  const placeholders = lineIds.map(() => '?').join(', ');
  const { results } = await db.prepare(`
    WITH actual_by_line AS (
      SELECT dil.po_revision_line_id, SUM(scl.qty_mt) AS actual_qty_mt
      FROM shipment_container_lines scl
      JOIN shipment_containers sc ON sc.container_id = scl.container_id
      JOIN delivery_instruction_lines dil ON dil.di_line_id = scl.delivery_instruction_line_id
      WHERE sc.shipment_id = ? AND sc.status <> 'CANCELLED'
      GROUP BY dil.po_revision_line_id
    ), final_by_line AS (
      SELECT invoice_line.po_revision_line_id, SUM(invoice_line.qty_mt) AS final_qty_mt
      FROM shipment_invoice_lines invoice_line
      JOIN shipment_invoices invoice ON invoice.invoice_id = invoice_line.invoice_id
      WHERE invoice.shipment_id = ? AND invoice.version = 'FINAL'
      GROUP BY invoice_line.po_revision_line_id
    )
    SELECT dil.po_revision_line_id, prl.unit_price, revision.currency, prl.max_qty_mt, prl.tolerance_pct,
           COALESCE(actual.actual_qty_mt, 0) AS actual_qty_mt,
           COALESCE(finals.final_qty_mt, 0) AS final_qty_mt
    FROM delivery_instruction_lines dil
    JOIN po_revision_lines prl ON prl.line_id = dil.po_revision_line_id
    JOIN po_revisions revision ON revision.revision_id = prl.po_revision_id
    LEFT JOIN actual_by_line actual ON actual.po_revision_line_id = dil.po_revision_line_id
    LEFT JOIN final_by_line finals ON finals.po_revision_line_id = dil.po_revision_line_id
    WHERE dil.di_id = ? AND dil.po_revision_line_id IN (${placeholders})
  `).bind(shipment.shipment_id, shipment.shipment_id, shipment.di_id, ...lineIds).all();
  const references = new Map((results || []).map((line) => [line.po_revision_line_id, line]));
  for (const lineId of lineIds) {
    if (!references.has(lineId)) throw codedError('INVOICE_LINE_PO_LINE_INVALID');
  }
  return references;
}

async function resolveShipmentInvoiceLines(db, shipment, lines, { final, preliminary } = {}) {
  const references = await findShipmentInvoiceLineReferences(db, shipment, lines);
  let currency = null;
  const resolved = lines.map((line) => {
    const reference = references.get(line.poRevisionLineId);
    const maxQtyMt = Number(reference.max_qty_mt);
    const actualQtyMt = Number(reference.actual_qty_mt);
    if (preliminary) {
      if (Number(reference.tolerance_pct) <= 0) throw codedError('INVOICE_PRELIMINARY_FIXED_WEIGHT');
      if (Math.abs(line.qtyMt - maxQtyMt) > 0.000001) throw codedError('INVOICE_PRELIMINARY_QTY_INVALID');
    }
    if (final) {
      if (line.qtyMt > maxQtyMt + 0.000001) throw codedError('INVOICE_FINAL_QTY_EXCEEDS_PO_MAX');
      const remainingActualQtyMt = actualQtyMt - Number(reference.final_qty_mt);
      if (line.qtyMt > remainingActualQtyMt + 0.000001) throw codedError('INVOICE_FINAL_QTY_EXCEEDS_REMAINING_ACTUAL');
    }
    if (currency && currency !== reference.currency) throw codedError('INVOICE_CURRENCY_MISMATCH');
    currency = reference.currency;
    const unitPriceSnapshot = Number(reference.unit_price);
    return {
      poRevisionLineId: line.poRevisionLineId,
      qtyMt: line.qtyMt,
      unitPriceSnapshot,
      currency: reference.currency,
      lineAmount: line.qtyMt * unitPriceSnapshot
    };
  });
  return { currency, lines: resolved };
}

function finalInvoiceReservationStatement(db, shipment, lines, reservation) {
  const incomingFinalTotal = lines.reduce((total, line) => total + line.lineAmount, 0);
  const quantityGuards = lines.map(() => `
    AND (
      COALESCE((
        SELECT SUM(invoice_line.qty_mt)
        FROM shipment_invoice_lines invoice_line
        JOIN shipment_invoices invoice ON invoice.invoice_id = invoice_line.invoice_id
        WHERE invoice.shipment_id = phase6_shipments.shipment_id
          AND invoice.version = 'FINAL'
          AND invoice_line.po_revision_line_id = ?
      ), 0) + ?
    ) <= COALESCE((
      SELECT SUM(container_line.qty_mt)
      FROM shipment_container_lines container_line
      JOIN shipment_containers container ON container.container_id = container_line.container_id
      JOIN delivery_instruction_lines instruction_line ON instruction_line.di_line_id = container_line.delivery_instruction_line_id
      WHERE container.shipment_id = phase6_shipments.shipment_id
        AND container.status <> 'CANCELLED'
        AND instruction_line.po_revision_line_id = ?
    ), 0) + 0.000001
  `).join('');
  return db.prepare(`
    UPDATE phase6_shipments
    SET final_invoice_version = ?, final_invoice_write_token = ?, updated_at = CURRENT_TIMESTAMP
    WHERE shipment_id = ? AND status IN ('LOADED', 'DOCS_SENT') AND container_version = ?
      AND final_invoice_version = ? AND final_invoice_write_token IS ?
      AND ROUND(cash_received_amount + ${allocatedCreditExpression()}, 2)
        <= ROUND(${finalInvoiceTotalExpression()} + ?, 2)
      ${quantityGuards}
  `).bind(
    reservation.version,
    reservation.writeToken,
    shipment.shipment_id,
    shipment.container_version,
    shipment.final_invoice_version,
    shipment.final_invoice_write_token,
    incomingFinalTotal,
    ...lines.flatMap((line) => [line.poRevisionLineId, line.qtyMt, line.poRevisionLineId])
  );
}

function shipmentInvoiceLineStatements(db, invoiceId, lines, actorId, invoiceState = null) {
  return lines.map((line) => db.prepare(`
    INSERT INTO shipment_invoice_lines (
      invoice_line_id, invoice_id, po_revision_line_id, qty_mt, unit_price_snapshot, currency, line_amount, created_by, updated_by
    ) ${invoiceState ? `
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM shipment_invoices
        WHERE invoice_id = ? AND version = ? AND invoice_version = ? AND invoice_write_token = ?
          ${invoiceState.finalContainerVersion === null ? 'AND final_container_version IS NULL' : 'AND final_container_version = ?'}
      )
    ` : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'}
  `).bind(
    `INVL-${crypto.randomUUID()}`,
    invoiceId,
    line.poRevisionLineId,
    line.qtyMt,
    line.unitPriceSnapshot,
    line.currency,
    line.lineAmount,
    actorId,
    actorId,
    ...(invoiceState ? [
      invoiceId,
      invoiceState.version,
      invoiceState.invoiceVersion,
      invoiceState.writeToken,
      ...(invoiceState.finalContainerVersion === null ? [] : [invoiceState.finalContainerVersion])
    ] : [])
  ));
}

function invoiceAuditForStateStatement(db, invoiceId, invoiceState, eventType, actorId, metadata = {}) {
  return db.prepare(`
    INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
    SELECT ?, 'INVOICE', ?, ?, ?, ?
    WHERE EXISTS (
      SELECT 1
      FROM shipment_invoices
      WHERE invoice_id = ? AND version = ? AND invoice_version = ? AND invoice_write_token = ?
        ${invoiceState.finalContainerVersion === null ? 'AND final_container_version IS NULL' : 'AND final_container_version = ?'}
    )
  `).bind(
    `EVT-${crypto.randomUUID()}`,
    invoiceId,
    eventType,
    actorId,
    JSON.stringify(metadata),
    invoiceId,
    invoiceState.version,
    invoiceState.invoiceVersion,
    invoiceState.writeToken,
    ...(invoiceState.finalContainerVersion === null ? [] : [invoiceState.finalContainerVersion])
  );
}

function shipmentCreationStatement(db, diId, actorId, requirePreviousMutation = false) {
  const shipmentId = `SHP-${crypto.randomUUID()}`;
  return db.prepare(`
    INSERT INTO phase6_shipments (shipment_id, di_id, status, created_by, updated_by)
    SELECT ?, di_id, 'PLANNING', ?, ?
    FROM delivery_instructions
    WHERE di_id = ? AND status = 'CONFIRMED'
      ${requirePreviousMutation ? 'AND changes() = 1' : ''}
  `).bind(shipmentId, actorId, actorId, diId);
}

function isShipmentAlreadyExists(error) {
  return String(error?.message || '').includes('UNIQUE constraint failed: phase6_shipments.di_id');
}

async function validateSelectedPartner(db, partnerId, partnerType, code) {
  if (!partnerId) return;
  const partner = await db.prepare(`
    SELECT partner_type
    FROM service_partners
    WHERE partner_id = ?
  `).bind(partnerId).first();
  if (!partner || partner.partner_type !== partnerType) throw codedError(code);
}

function deliveryInstructionSnapshot(deliveryInstruction) {
  const value = (camelCase, snakeCase) => Object.hasOwn(deliveryInstruction, camelCase)
    ? deliveryInstruction[camelCase]
    : deliveryInstruction[snakeCase];
  return {
    customerId: value('customerId', 'customer_id'),
    poId: value('poId', 'po_id'),
    poRevisionId: value('poRevisionId', 'po_revision_id'),
    diNo: value('diNo', 'di_no'),
    shippingMonth: value('shippingMonth', 'shipping_month'),
    shippingPeriod: value('shippingPeriod', 'shipping_period'),
    containerPlan: value('containerPlan', 'container_plan'),
    note: deliveryInstruction.note,
    googleDriveUrl: value('googleDriveUrl', 'di_drive_url'),
    surveyorPartnerId: value('surveyorPartnerId', 'surveyor_partner_id'),
    forwarderPartnerId: value('forwarderPartnerId', 'forwarder_partner_id'),
    lines: (deliveryInstruction.lines || []).map((line) => ({
      poRevisionLineId: line.poRevisionLineId ?? line.po_revision_line_id,
      plannedQtyMt: line.plannedQtyMt ?? line.planned_qty_mt,
      packingSnapshot: line.packingSnapshot ?? line.packing_snapshot
    }))
  };
}

function auditStatement(db, entityType, entityId, eventType, actorId, metadata = {}) {
  return db.prepare(`
    INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).bind(`EVT-${crypto.randomUUID()}`, entityType, entityId, eventType, actorId, JSON.stringify(metadata));
}

function auditAfterMutationStatement(db, entityType, entityId, eventType, actorId, metadata = {}) {
  return db.prepare(`
    INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
    SELECT ?, ?, ?, ?, ?, ?
    WHERE changes() = 1
  `).bind(`EVT-${crypto.randomUUID()}`, entityType, entityId, eventType, actorId, JSON.stringify(metadata));
}

async function findCustomerCredit(db, creditId) {
  return db.prepare(`
    SELECT credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by, created_at
    FROM customer_credits
    WHERE credit_id = ?
  `).bind(creditId).first();
}

async function findCustomerCreditByRequestKey(db, requestKey) {
  return db.prepare(`
    SELECT credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by, created_at
    FROM customer_credits
    WHERE request_key = ?
  `).bind(requestKey).first();
}

async function findCustomerCreditUsageByRequestKey(db, requestKey) {
  return db.prepare(`
    SELECT credit_usage_id, credit_id, shipment_id, invoice_id, amount
    FROM customer_credit_usages
    WHERE request_key = ?
  `).bind(requestKey).first();
}

async function findShipmentCustomer(db, shipmentId) {
  return db.prepare(`
    SELECT shipment.shipment_id, instruction.customer_id
    FROM phase6_shipments shipment
    JOIN delivery_instructions instruction ON instruction.di_id = shipment.di_id
    WHERE shipment.shipment_id = ?
  `).bind(shipmentId).first();
}

function finalInvoiceCountExpression(shipmentExpression = 'phase6_shipments.shipment_id') {
  return `(SELECT COUNT(*) FROM shipment_invoices invoice WHERE invoice.shipment_id = ${shipmentExpression} AND invoice.version = 'FINAL')`;
}

function finalInvoiceTotalExpression(shipmentExpression = 'phase6_shipments.shipment_id') {
  return `ROUND(COALESCE((
    SELECT SUM(invoice_line.line_amount)
    FROM shipment_invoice_lines invoice_line
    JOIN shipment_invoices invoice ON invoice.invoice_id = invoice_line.invoice_id
    WHERE invoice.shipment_id = ${shipmentExpression} AND invoice.version = 'FINAL'
  ), 0), 2)`;
}

function allocatedCreditExpression(shipmentExpression = 'phase6_shipments.shipment_id') {
  return `ROUND(COALESCE((
    SELECT SUM(usage.amount)
    FROM customer_credit_usages usage
    WHERE usage.shipment_id = ${shipmentExpression}
  ), 0), 2)`;
}

function finalInvoicesMatchActualCargoExpression(
  shipmentExpression = 'phase6_shipments.shipment_id',
  diExpression = 'phase6_shipments.di_id'
) {
  return `NOT EXISTS (
    SELECT 1
    FROM delivery_instruction_lines completion_line
    WHERE completion_line.di_id = ${diExpression}
      AND ABS(
        COALESCE((
          SELECT SUM(actual_line.qty_mt)
          FROM shipment_container_lines actual_line
          JOIN shipment_containers actual_container ON actual_container.container_id = actual_line.container_id
          JOIN delivery_instruction_lines actual_di_line
            ON actual_di_line.di_line_id = actual_line.delivery_instruction_line_id
          WHERE actual_container.shipment_id = ${shipmentExpression}
            AND actual_container.status <> 'CANCELLED'
            AND actual_di_line.po_revision_line_id = completion_line.po_revision_line_id
        ), 0)
        - COALESCE((
          SELECT SUM(final_line.qty_mt)
          FROM shipment_invoice_lines final_line
          JOIN shipment_invoices final_invoice ON final_invoice.invoice_id = final_line.invoice_id
          WHERE final_invoice.shipment_id = ${shipmentExpression}
            AND final_invoice.version = 'FINAL'
            AND final_line.po_revision_line_id = completion_line.po_revision_line_id
        ), 0)
      ) > 0.000001
  )`;
}

function paymentStatusExpression(cashExpression) {
  const finalInvoiceCount = finalInvoiceCountExpression();
  const finalTotal = finalInvoiceTotalExpression();
  const allocatedCredit = allocatedCreditExpression();
  const covered = `ROUND(${cashExpression} + ${allocatedCredit}, 2)`;
  return `CASE
    WHEN ${finalInvoiceCount} = 0 THEN 'UNPAID'
    WHEN ${finalTotal} = 0 THEN 'PAID'
    WHEN ${covered} <= 0 THEN 'UNPAID'
    WHEN ${covered} = ${finalTotal} THEN 'PAID'
    ELSE 'PARTIAL'
  END`;
}

function paymentUpdateStatement(db, shipmentId, actorId, payment = null, requiredCreditUsageId = null, requiredInvoiceState = null) {
  const cashExpression = payment ? '?' : 'cash_received_amount';
  const fields = payment
    ? `cash_received_amount = ?, payment_note = ?,`
    : '';
  const parameters = payment
    ? [
      payment.cashReceivedAmount,
      payment.paymentNote,
      payment.cashReceivedAmount,
      payment.cashReceivedAmount
    ]
    : [];
  return db.prepare(`
    UPDATE phase6_shipments
    SET ${fields} payment_status = ${paymentStatusExpression(cashExpression)},
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE shipment_id = ?
      ${payment ? `AND (
        ${finalInvoiceCountExpression()} = 0 OR
        ROUND(? + ${allocatedCreditExpression()}, 2) <= ${finalInvoiceTotalExpression()}
      )
      AND (
        status <> 'COMPLETED' OR
        ROUND(? + ${allocatedCreditExpression()}, 2) = ${finalInvoiceTotalExpression()}
      )` : ''}
      ${requiredCreditUsageId ? 'AND EXISTS (SELECT 1 FROM customer_credit_usages WHERE credit_usage_id = ?)' : ''}
      ${requiredInvoiceState ? `AND EXISTS (
        SELECT 1 FROM shipment_invoices
        WHERE invoice_id = ? AND version = ? AND invoice_version = ? AND invoice_write_token = ?
          ${requiredInvoiceState.finalContainerVersion === null ? 'AND final_container_version IS NULL' : 'AND final_container_version = ?'}
      )` : ''}
  `).bind(
    ...parameters,
    actorId,
    shipmentId,
    ...(payment ? [payment.cashReceivedAmount, payment.cashReceivedAmount] : []),
    ...(requiredCreditUsageId ? [requiredCreditUsageId] : []),
    ...(requiredInvoiceState ? [
      requiredInvoiceState.invoiceId,
      requiredInvoiceState.version,
      requiredInvoiceState.invoiceVersion,
      requiredInvoiceState.writeToken,
      ...(requiredInvoiceState.finalContainerVersion === null ? [] : [requiredInvoiceState.finalContainerVersion])
    ] : [])
  );
}

async function recomputeShipmentCompletion(db, shipmentId, actorId) {
  const shipment = await findPhase6Shipment(db, shipmentId);
  if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
  if (!isDocumentRequirementSatisfied(shipment) || shipment.payment_status !== 'PAID') return shipment;

  await db.batch([
    db.prepare(`
      UPDATE phase6_shipments
      SET status = 'COMPLETED', updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE shipment_id = ?
        AND status = 'DOCS_SENT'
        AND payment_status = 'PAID'
        AND all_ship_docs_drive_url IS NOT NULL
        AND digital_docs_sent_date IS NOT NULL
        AND (original_docs_required = 0 OR (dhl_sent_date IS NOT NULL AND dhl_tracking_no IS NOT NULL))
        AND ${finalInvoicesMatchActualCargoExpression()}
        AND EXISTS (
          SELECT 1
          FROM delivery_instructions
          WHERE di_id = phase6_shipments.di_id AND status = 'IN_PROGRESS'
        )
    `).bind(actorId, shipmentId),
    db.prepare(`
      UPDATE delivery_instructions
      SET status = 'COMPLETED', lifecycle_version = lifecycle_version + 1,
          updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE di_id = (SELECT di_id FROM phase6_shipments WHERE shipment_id = ?)
        AND status = 'IN_PROGRESS'
        AND EXISTS (
          SELECT 1
          FROM phase6_shipments
          WHERE shipment_id = ? AND status = 'COMPLETED'
        )
    `).bind(actorId, shipmentId, shipmentId),
    db.prepare(`
      INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
      SELECT ?, 'SHIPMENT', ?, 'SHIPMENT_COMPLETED', ?, ?
      WHERE EXISTS (
        SELECT 1
        FROM phase6_shipments shipment
        JOIN delivery_instructions instruction ON instruction.di_id = shipment.di_id
        WHERE shipment.shipment_id = ? AND shipment.status = 'COMPLETED' AND instruction.status = 'COMPLETED'
      )
        AND NOT EXISTS (
          SELECT 1
          FROM shipment_audit_events
          WHERE entity_type = 'SHIPMENT' AND entity_id = ? AND event_type = 'SHIPMENT_COMPLETED'
        )
    `).bind(
      `EVT-${crypto.randomUUID()}`,
      shipmentId,
      actorId,
      JSON.stringify({ documentRequirementSatisfied: true, paymentStatus: 'PAID' }),
      shipmentId,
      shipmentId
    )
  ]);
  return findPhase6Shipment(db, shipmentId);
}

async function findShipmentPaymentSummary(db, shipmentId) {
  return db.prepare(`
    SELECT shipment.status, cash_received_amount,
           ${finalInvoiceCountExpression('shipment.shipment_id')} AS final_invoice_count,
           ${finalInvoiceTotalExpression('shipment.shipment_id')} AS final_total,
           ${allocatedCreditExpression('shipment.shipment_id')} AS allocated_credit
    FROM phase6_shipments shipment
    WHERE shipment.shipment_id = ?
  `).bind(shipmentId).first();
}

async function assertFinalInvoicePaymentObligation(db, shipmentId, lines) {
  const paymentSummary = await findShipmentPaymentSummary(db, shipmentId);
  if (!paymentSummary) throw codedError('SHIPMENT_NOT_FOUND');
  const incomingFinalTotal = lines.reduce((total, line) => total + line.lineAmount, 0);
  const proposed = await db.prepare(`
    SELECT ROUND(${finalInvoiceTotalExpression('shipment.shipment_id')} + ?, 2) AS final_total
    FROM phase6_shipments shipment
    WHERE shipment_id = ?
  `).bind(incomingFinalTotal, shipmentId).first();
  const coveredCents = moneyCents(paymentSummary.cash_received_amount) + moneyCents(paymentSummary.allocated_credit);
  if (coveredCents > moneyCents(proposed.final_total)) throw codedError('PAYMENT_SETTLEMENT_EXCEEDED');
}

function assertShipmentPaymentChangeAllowed(paymentSummary, cashReceivedAmount) {
  if (!paymentSummary) throw codedError('SHIPMENT_NOT_FOUND');
  if (Number(paymentSummary.final_invoice_count) === 0) return;
  const coveredCents = moneyCents(cashReceivedAmount) + moneyCents(paymentSummary.allocated_credit);
  const finalTotalCents = moneyCents(paymentSummary.final_total);
  if (paymentSummary.status === 'COMPLETED' && coveredCents !== finalTotalCents) {
    throw codedError('PAYMENT_COMPLETED_INVALIDATION');
  }
  if (coveredCents > finalTotalCents) throw codedError('PAYMENT_SETTLEMENT_EXCEEDED');
}

function moneyCents(value) {
  return Math.round(Number(value || 0) * 100);
}

function creditUsageReservationStatement(db, shipmentId, creditId, customerId, amount) {
  const finalInvoiceCount = finalInvoiceCountExpression('shipment.shipment_id');
  const finalTotal = finalInvoiceTotalExpression('shipment.shipment_id');
  const allocatedCredit = allocatedCreditExpression('shipment.shipment_id');
  return db.prepare(`
    UPDATE customer_credits
    SET remaining_amount = ROUND(remaining_amount - ?, 2)
    WHERE credit_id = ? AND customer_id = ? AND ROUND(remaining_amount, 2) >= ROUND(?, 2)
      AND EXISTS (
        SELECT 1
        FROM phase6_shipments shipment
        WHERE shipment.shipment_id = ?
          AND ${finalInvoiceCount} > 0
          AND ROUND(${finalTotal} - ROUND(shipment.cash_received_amount + ${allocatedCredit}, 2), 2) >= ROUND(?, 2)
      )
  `).bind(amount, creditId, customerId, amount, shipmentId, amount);
}

function mutationApplied(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0) === 1;
}

function deliveryInstructionUpdateDto(existing, dto) {
  const patch = validateDeliveryInstructionUpdate(dto);
  const existingDto = {
    customerId: existing.customer_id,
    poId: existing.po_id,
    poRevisionId: existing.po_revision_id,
    diNo: existing.di_no,
    shippingMonth: existing.shipping_month,
    shippingPeriod: existing.shipping_period,
    containerPlan: existing.container_plan,
    note: existing.note,
    googleDriveUrl: existing.di_drive_url,
    surveyorPartnerId: existing.surveyor_partner_id,
    forwarderPartnerId: existing.forwarder_partner_id,
    lines: existing.lines.map((line) => ({
      poId: line.po_id,
      poRevisionId: line.po_revision_id,
      poRevisionLineId: line.po_revision_line_id,
      plannedQtyMt: line.planned_qty_mt,
      packingSnapshot: line.packing_snapshot
    }))
  };
  return validateDeliveryInstruction({ ...existingDto, ...patch });
}

async function validateDeliveryInstructionReferences(db, deliveryInstruction) {
  const header = await db.prepare(`
    SELECT customer_id
    FROM po_headers
    WHERE po_id = ?
  `).bind(deliveryInstruction.poId).first();
  if (!header || header.customer_id !== deliveryInstruction.customerId) throw codedError('DI_PO_LINEAGE_INVALID');

  const revision = await db.prepare(`
    SELECT revision_id
    FROM po_revisions
    WHERE revision_id = ? AND po_id = ?
  `).bind(deliveryInstruction.poRevisionId, deliveryInstruction.poId).first();
  if (!revision) throw codedError('DI_PO_REVISION_LINEAGE_INVALID');

  const seenLineIds = new Set();
  for (const line of deliveryInstruction.lines) {
    if (
      line.poId !== deliveryInstruction.poId ||
      line.poRevisionId !== deliveryInstruction.poRevisionId ||
      seenLineIds.has(line.poRevisionLineId)
    ) throw codedError('DI_LINE_PO_LINEAGE_INVALID');
    seenLineIds.add(line.poRevisionLineId);

    const exactLine = await db.prepare(`
      SELECT l.product_id
      FROM po_headers h
      JOIN po_revisions r ON r.po_id = h.po_id
      JOIN po_revision_lines l ON l.po_revision_id = r.revision_id
      WHERE h.po_id = ? AND h.customer_id = ? AND r.revision_id = ? AND l.line_id = ?
    `).bind(
      deliveryInstruction.poId,
      deliveryInstruction.customerId,
      deliveryInstruction.poRevisionId,
      line.poRevisionLineId
    ).first();
    if (!exactLine) throw codedError('DI_LINE_PO_LINEAGE_INVALID');
    line.productId = exactLine.product_id;
  }
}

function deliveryInstructionLineReservationStatement(db, diId, deliveryInstruction, line, actorId, lifecycleVersion) {
  return db.prepare(`
    WITH requested_line (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
      planned_qty_mt, packing_snapshot, created_by, updated_by
    ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
    INSERT INTO delivery_instruction_lines (
      di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
      planned_qty_mt, packing_snapshot, created_by, updated_by
    )
    SELECT requested.di_line_id, requested.di_id, requested.po_id, requested.po_revision_id,
           requested.po_revision_line_id, requested.product_id,
           CASE
             WHEN requested.planned_qty_mt <= COALESCE((
               SELECT line.max_qty_mt
                 - COALESCE((
                   SELECT SUM(container_line.qty_mt)
                   FROM delivery_instruction_lines actual_di_line
                   JOIN shipment_container_lines container_line
                     ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                   JOIN shipment_containers container
                     ON container.container_id = container_line.container_id
                   JOIN phase6_shipments shipment
                     ON shipment.shipment_id = container.shipment_id
                   WHERE actual_di_line.po_revision_line_id = requested.po_revision_line_id
                     AND shipment.status <> 'CANCELLED'
                     AND container.status <> 'CANCELLED'
                 ), 0)
                 - COALESCE((
                   SELECT SUM(planned_di_line.planned_qty_mt)
                   FROM delivery_instruction_lines planned_di_line
                   JOIN delivery_instructions planned_di
                     ON planned_di.di_id = planned_di_line.di_id
                   WHERE planned_di_line.po_revision_line_id = requested.po_revision_line_id
                     AND planned_di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
                     AND NOT EXISTS (
                       SELECT 1
                       FROM delivery_instruction_lines actual_di_line
                       JOIN shipment_container_lines container_line
                         ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                       JOIN shipment_containers container
                         ON container.container_id = container_line.container_id
                       JOIN phase6_shipments shipment
                         ON shipment.shipment_id = container.shipment_id
                       WHERE actual_di_line.di_line_id = planned_di_line.di_line_id
                         AND shipment.status <> 'CANCELLED'
                         AND container.status <> 'CANCELLED'
                     )
                 ), 0)
               FROM po_revision_lines line
               WHERE line.line_id = requested.po_revision_line_id
             ), -1) + 0.000001
             THEN requested.planned_qty_mt
             ELSE -1
           END,
           requested.packing_snapshot, requested.created_by, requested.updated_by
    FROM requested_line requested
    WHERE changes() > 0
      AND EXISTS (
      SELECT 1
      FROM delivery_instructions current_di
      WHERE current_di.di_id = requested.di_id
        AND current_di.status = 'DRAFT'
        AND current_di.lifecycle_version = ?
    )
  `).bind(
    `DIL-${crypto.randomUUID()}`,
    diId,
    deliveryInstruction.poId,
    deliveryInstruction.poRevisionId,
    line.poRevisionLineId,
    line.productId,
    line.plannedQtyMt,
    line.packingSnapshot,
    actorId,
    actorId,
    lifecycleVersion
  );
}

export function createShippingDiRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listServicePartners(filters = {}) {
      let query = `
        SELECT partner_id, partner_name, partner_type, status, created_by, created_at, updated_by, updated_at
        FROM service_partners
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }
      if (filters.partnerType) {
        query += ' AND partner_type = ?';
        params.push(filters.partnerType);
      }
      query += ' ORDER BY partner_name COLLATE NOCASE ASC';
      const { results } = await db.prepare(query).bind(...params).all();
      return results || [];
    },

    async createServicePartner(dto, actorId) {
      const partner = validateServicePartner(dto);
      const partnerId = await nextId(db);
      await db.prepare(`
        INSERT INTO service_partners (partner_id, partner_type, partner_name, status, created_by, updated_by)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(partnerId, partner.partnerType, partner.companyName, partner.status, actorId, actorId).run();
      return findServicePartner(db, partnerId);
    },

    async updateServicePartner(partnerId, dto, actorId) {
      if (!dto || typeof dto !== 'object' || Array.isArray(dto)) throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
      if (Object.keys(dto).length === 0) throw codedError('SERVICE_PARTNER_PAYLOAD_INVALID');
      const existing = await findServicePartner(db, partnerId);
      if (!existing) throw codedError('SERVICE_PARTNER_NOT_FOUND');
      if (dto.partnerType !== undefined && dto.partnerType !== existing.partner_type) {
        throw codedError('SERVICE_PARTNER_TYPE_IMMUTABLE');
      }
      const partner = validateServicePartner({
        companyName: dto.companyName === undefined ? existing.partner_name : dto.companyName,
        partnerType: dto.partnerType === undefined ? existing.partner_type : dto.partnerType,
        status: dto.status === undefined ? existing.status : dto.status,
        ...dto
      });
      await db.prepare(`
        UPDATE service_partners
        SET partner_name = ?, partner_type = ?, status = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE partner_id = ?
      `).bind(partner.companyName, partner.partnerType, partner.status, actorId, partnerId).run();
      return findServicePartner(db, partnerId);
    },

    async createDeliveryInstruction(dto, actorId) {
      const deliveryInstruction = validateDeliveryInstruction(dto);
      await validateDeliveryInstructionReferences(db, deliveryInstruction);

      await this.assertDeliveryInstructionAvailability(deliveryInstruction.lines);

      await validateSelectedPartner(db, deliveryInstruction.surveyorPartnerId, 'SURVEYOR', 'DI_SURVEYOR_INVALID');
      await validateSelectedPartner(db, deliveryInstruction.forwarderPartnerId, 'FORWARDER', 'DI_FORWARDER_INVALID');

      const maxInternalNumberAttempts = 3;
      const hasCustomerDiNo = deliveryInstruction.diNo !== null;
      for (let attempt = 0; attempt < (hasCustomerDiNo ? 1 : maxInternalNumberAttempts); attempt += 1) {
        const diId = `DI-${crypto.randomUUID()}`;
        const diNo = hasCustomerDiNo
          ? deliveryInstruction.diNo
          : await nextInternalDiNo(db, deliveryInstruction.poId);
        const statements = [db.prepare(`
          INSERT INTO delivery_instructions (
            di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period,
            container_plan, status, note, di_drive_url, surveyor_partner_id, forwarder_partner_id, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?)
        `).bind(
          diId,
          deliveryInstruction.customerId,
          deliveryInstruction.poId,
          deliveryInstruction.poRevisionId,
          diNo,
          deliveryInstruction.shippingMonth,
          deliveryInstruction.shippingPeriod,
          deliveryInstruction.containerPlan,
          deliveryInstruction.note,
          deliveryInstruction.googleDriveUrl,
          deliveryInstruction.surveyorPartnerId,
          deliveryInstruction.forwarderPartnerId,
          actorId,
          actorId
        )];

        statements.push(auditStatement(db, 'DI', diId, 'DI_CREATED', actorId, {
          new: { ...deliveryInstructionSnapshot(deliveryInstruction), status: 'DRAFT', diNo }
        }));

        for (const line of deliveryInstruction.lines) {
          statements.push(db.prepare(`
            WITH requested_line (
              di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
              planned_qty_mt, packing_snapshot, created_by, updated_by
            ) AS (VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?))
            INSERT INTO delivery_instruction_lines (
              di_line_id, di_id, po_id, po_revision_id, po_revision_line_id, product_id,
              planned_qty_mt, packing_snapshot, created_by, updated_by
            )
            SELECT requested.di_line_id, requested.di_id, requested.po_id, requested.po_revision_id,
                   requested.po_revision_line_id, requested.product_id,
                   CASE
                     WHEN requested.planned_qty_mt <= COALESCE((
                       SELECT line.max_qty_mt
                         - COALESCE((
                           SELECT SUM(container_line.qty_mt)
                           FROM delivery_instruction_lines actual_di_line
                           JOIN shipment_container_lines container_line
                             ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                           JOIN shipment_containers container
                             ON container.container_id = container_line.container_id
                           JOIN phase6_shipments shipment
                             ON shipment.shipment_id = container.shipment_id
                           WHERE actual_di_line.po_revision_line_id = requested.po_revision_line_id
                             AND shipment.status <> 'CANCELLED'
                             AND container.status <> 'CANCELLED'
                         ), 0)
                         - COALESCE((
                           SELECT SUM(planned_di_line.planned_qty_mt)
                           FROM delivery_instruction_lines planned_di_line
                           JOIN delivery_instructions planned_di
                             ON planned_di.di_id = planned_di_line.di_id
                           WHERE planned_di_line.po_revision_line_id = requested.po_revision_line_id
                             AND planned_di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
                             AND NOT EXISTS (
                               SELECT 1
                               FROM delivery_instruction_lines actual_di_line
                               JOIN shipment_container_lines container_line
                                 ON container_line.delivery_instruction_line_id = actual_di_line.di_line_id
                               JOIN shipment_containers container
                                 ON container.container_id = container_line.container_id
                               JOIN phase6_shipments shipment
                                 ON shipment.shipment_id = container.shipment_id
                               WHERE actual_di_line.di_line_id = planned_di_line.di_line_id
                                 AND shipment.status <> 'CANCELLED'
                                 AND container.status <> 'CANCELLED'
                             )
                         ), 0)
                       FROM po_revision_lines line
                       WHERE line.line_id = requested.po_revision_line_id
                     ), -1) + 0.000001
                     THEN requested.planned_qty_mt
                     ELSE -1
                   END,
                   requested.packing_snapshot, requested.created_by, requested.updated_by
            FROM requested_line requested
          `).bind(
            `DIL-${crypto.randomUUID()}`,
            diId,
            deliveryInstruction.poId,
            deliveryInstruction.poRevisionId,
            line.poRevisionLineId,
            line.productId,
            line.plannedQtyMt,
            line.packingSnapshot,
            actorId,
            actorId
          ));
        }

        try {
          await db.batch(statements);
          return findDeliveryInstruction(db, diId);
        } catch (error) {
          if (isAvailabilityReservationFailure(error)) {
            throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
          }
          if (!hasCustomerDiNo && attempt + 1 < maxInternalNumberAttempts && isInternalDiNoUniqueCollision(error)) {
            continue;
          }
          throw error;
        }
      }
    },

    async updateDraftDeliveryInstruction(diId, dto, actorId) {
      const existing = await findDeliveryInstruction(db, diId);
      if (!existing) throw codedError('DI_NOT_FOUND');
      if (existing.status !== 'DRAFT') throw codedError('DI_NOT_DRAFT');

      const deliveryInstruction = deliveryInstructionUpdateDto(existing, dto);
      await validateDeliveryInstructionReferences(db, deliveryInstruction);
      await this.assertDeliveryInstructionAvailability(deliveryInstruction.lines, diId);
      await validateSelectedPartner(db, deliveryInstruction.surveyorPartnerId, 'SURVEYOR', 'DI_SURVEYOR_INVALID');
      await validateSelectedPartner(db, deliveryInstruction.forwarderPartnerId, 'FORWARDER', 'DI_FORWARDER_INVALID');

      const statements = [
        db.prepare(`
          UPDATE delivery_instructions
          SET customer_id = ?, po_id = ?, po_revision_id = ?, di_no = ?, shipping_month = ?, shipping_period = ?,
              container_plan = ?, note = ?, di_drive_url = ?, surveyor_partner_id = ?, forwarder_partner_id = ?,
              lifecycle_version = lifecycle_version + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'DRAFT' AND lifecycle_version = ?
        `).bind(
          deliveryInstruction.customerId,
          deliveryInstruction.poId,
          deliveryInstruction.poRevisionId,
          deliveryInstruction.diNo,
          deliveryInstruction.shippingMonth,
          deliveryInstruction.shippingPeriod,
          deliveryInstruction.containerPlan,
          deliveryInstruction.note,
          deliveryInstruction.googleDriveUrl,
          deliveryInstruction.surveyorPartnerId,
          deliveryInstruction.forwarderPartnerId,
          actorId,
          diId,
          existing.lifecycle_version
        ),
        db.prepare(`
          DELETE FROM delivery_instruction_lines
          WHERE changes() = 1
            AND di_id = ?
            AND EXISTS (
              SELECT 1 FROM delivery_instructions
              WHERE di_id = ? AND status = 'DRAFT' AND lifecycle_version = ?
            )
        `).bind(diId, diId, existing.lifecycle_version + 1)
      ];
      for (const line of deliveryInstruction.lines) {
        statements.push(deliveryInstructionLineReservationStatement(
          db,
          diId,
          deliveryInstruction,
          line,
          actorId,
          existing.lifecycle_version + 1
        ));
      }
      statements.push(auditAfterMutationStatement(db, 'DI', diId, 'DI_UPDATED', actorId, {
        old: deliveryInstructionSnapshot(existing),
        new: deliveryInstructionSnapshot(deliveryInstruction)
      }));
      try {
        const results = await db.batch(statements);
        if (!mutationApplied(results[0])) throw codedError('DI_NOT_DRAFT');
      } catch (error) {
        if (isAvailabilityReservationFailure(error)) throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
        throw error;
      }
      return findDeliveryInstruction(db, diId);
    },

    async confirmDeliveryInstruction(diId, actorId) {
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'DRAFT') throw codedError('DI_NOT_DRAFT');
      validateDeliveryInstructionContainerPlan(deliveryInstruction.container_plan);

      const results = await db.batch([
        db.prepare(`
          UPDATE delivery_instructions
          SET status = 'CONFIRMED', lifecycle_version = lifecycle_version + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'DRAFT' AND lifecycle_version = ?
        `).bind(actorId, diId, deliveryInstruction.lifecycle_version),
        shipmentCreationStatement(db, diId, actorId, true),
        auditAfterMutationStatement(db, 'DI', diId, 'DI_CONFIRMED', actorId, {
          oldStatus: deliveryInstruction.status,
          newStatus: 'CONFIRMED'
        })
      ]);
      if (!mutationApplied(results[0])) throw codedError('DI_NOT_DRAFT');
      return findDeliveryInstruction(db, diId);
    },

    async cancelDeliveryInstruction(diId, note, actorId) {
      const cancellationNote = validateCancellationNote(note);
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      const shipment = await findPhase6Shipment(db, diId);
      const cancellablePair = (
        deliveryInstruction.status === 'CONFIRMED' && shipment?.status === 'PLANNING'
      ) || (
        deliveryInstruction.status === 'IN_PROGRESS' && shipment?.status === 'BOOKED'
      );
      if (!cancellablePair) throw codedError('DI_NOT_CONFIRMED');

      const results = await db.batch([
        db.prepare(`
          UPDATE delivery_instructions
          SET status = 'CANCELLED', cancellation_note = ?, lifecycle_version = lifecycle_version + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = ? AND lifecycle_version = ?
            AND EXISTS (
              SELECT 1 FROM phase6_shipments
              WHERE di_id = ? AND status = ?
            )
        `).bind(
          cancellationNote,
          actorId,
          diId,
          deliveryInstruction.status,
          deliveryInstruction.lifecycle_version,
          diId,
          shipment.status
        ),
        auditAfterMutationStatement(db, 'DI', diId, 'DI_CANCELLED', actorId, {
          oldStatus: deliveryInstruction.status,
          newStatus: 'CANCELLED',
          cancellationNote
        }),
        db.prepare(`
          UPDATE phase6_shipments
          SET status = 'CANCELLED', cancellation_note = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = ? AND changes() = 1
        `).bind(cancellationNote, actorId, diId, shipment.status),
        ...(shipment ? [auditAfterMutationStatement(
          db, 'SHIPMENT', shipment.shipment_id, 'SHIPMENT_CANCELLED', actorId, { cancellationNote }
        )] : [])
      ]);
      if (!mutationApplied(results[0]) || !mutationApplied(results[2])) throw codedError('DI_NOT_CONFIRMED');
      return findDeliveryInstruction(db, diId);
    },

    async deleteDraftDeliveryInstruction(diId) {
      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'DRAFT') throw codedError('DI_HARD_DELETE_FORBIDDEN');
      const result = await db.prepare(`
        DELETE FROM delivery_instructions
        WHERE di_id = ? AND status = 'DRAFT' AND lifecycle_version = ?
      `).bind(diId, deliveryInstruction.lifecycle_version).run();
      if (!mutationApplied(result)) {
        const current = await findDeliveryInstruction(db, diId);
        if (!current) throw codedError('DI_NOT_FOUND');
        throw codedError('DI_HARD_DELETE_FORBIDDEN');
      }
    },

    async getShippingDiHistory(diId) {
      const { results } = await db.prepare(`
        SELECT event_id, entity_type, entity_id, event_type, actor_id, metadata_json, created_at
        FROM shipment_audit_events
        WHERE entity_type = 'DI' AND entity_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).bind(diId).all();
      return results || [];
    },

    async getDeliveryInstruction(diId) {
      return findDeliveryInstruction(db, diId);
    },

    async createShipmentForDeliveryInstruction(diId, actorId) {
      const existing = await findPhase6Shipment(db, diId);
      if (existing) throw codedError('SHIPMENT_ALREADY_EXISTS');

      const deliveryInstruction = await findDeliveryInstruction(db, diId);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      if (deliveryInstruction.status !== 'CONFIRMED') throw codedError('DI_NOT_CONFIRMED');

      try {
        const result = await shipmentCreationStatement(db, diId, actorId).run();
        if (!mutationApplied(result)) throw codedError('DI_NOT_CONFIRMED');
      } catch (error) {
        if (isShipmentAlreadyExists(error)) throw codedError('SHIPMENT_ALREADY_EXISTS');
        throw error;
      }
      return findPhase6Shipment(db, diId);
    },

    async recordShipmentBooking(shipmentId, dto, actorId) {
      const booking = validateShipmentBooking(dto);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      if (shipment.status !== 'PLANNING') throw codedError('SHIPMENT_NOT_PLANNING');

      const deliveryInstruction = await findDeliveryInstruction(db, shipment.di_id);
      if (!deliveryInstruction || deliveryInstruction.status !== 'CONFIRMED') throw codedError('DI_NOT_CONFIRMED');
      await validateSelectedPartner(db, booking.forwarderPartnerId, 'FORWARDER', 'SHIPMENT_FORWARDER_INVALID');
      await validateSelectedPartner(db, booking.shippingLinePartnerId, 'SHIPPING_LINE', 'SHIPMENT_SHIPPING_LINE_INVALID');
      await validateSelectedPartner(db, booking.truckingPartnerId, 'TRUCKING', 'SHIPMENT_TRUCKING_INVALID');

      const results = await db.batch([
        db.prepare(`
          UPDATE phase6_shipments
          SET status = 'BOOKED', booking_no = ?, forwarder_partner_id = ?, shipping_line_partner_id = ?,
              trucking_partner_id = ?, vessel = ?, etd = ?, eta = ?, planned_loading_date = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE shipment_id = ? AND status = 'PLANNING'
            AND EXISTS (
              SELECT 1 FROM delivery_instructions
              WHERE di_id = phase6_shipments.di_id AND status = 'CONFIRMED'
            )
        `).bind(
          booking.bookingNo,
          booking.forwarderPartnerId,
          booking.shippingLinePartnerId,
          booking.truckingPartnerId,
          booking.vessel,
          booking.etd,
          booking.eta,
          booking.plannedLoadingDate,
          actorId,
          shipmentId
        ),
        db.prepare(`
          UPDATE delivery_instructions
          SET status = 'IN_PROGRESS', lifecycle_version = lifecycle_version + 1,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE di_id = ? AND status = 'CONFIRMED' AND changes() = 1
        `).bind(actorId, shipment.di_id),
        auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'BOOKING_RECORDED', actorId, booking)
      ]);
      if (!mutationApplied(results[0]) || !mutationApplied(results[1])) throw codedError('SHIPMENT_NOT_PLANNING');
      return findPhase6Shipment(db, shipmentId);
    },

    async updateShipmentSchedule(shipmentId, dto, actorId) {
      const schedule = validateShipmentSchedule(dto);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      if (shipment.status !== 'BOOKED') throw codedError('SHIPMENT_NOT_BOOKED');

      const deliveryInstruction = await findDeliveryInstruction(db, shipment.di_id);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');

      if (schedule.plannedLoadingDate !== undefined) {
        const results = await db.batch([
          db.prepare(`
            UPDATE phase6_shipments
            SET planned_loading_date = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE shipment_id = ? AND status = 'BOOKED'
              AND planned_loading_date IS ?
              AND planned_loading_date IS NOT ?
          `).bind(schedule.plannedLoadingDate, actorId, shipmentId, shipment.planned_loading_date, schedule.plannedLoadingDate),
          auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'PLANNED_LOADING_DATE_UPDATED', actorId, {
            old: shipment.planned_loading_date,
            new: schedule.plannedLoadingDate
          })
        ]);
        if (!mutationApplied(results[0])) throw codedError('SHIPMENT_SCHEDULE_STALE');
      } else {
        const scheduleResult = calculateScheduleResult(
          deliveryInstruction.shipping_month,
          deliveryInstruction.shipping_period,
          schedule.actualLoadingDate
        );
        const scheduleNote = schedule.scheduleNote === undefined ? shipment.schedule_note : schedule.scheduleNote;
        const results = await db.batch([
          db.prepare(`
            UPDATE phase6_shipments
            SET status = CASE WHEN EXISTS (
                  SELECT 1
                  FROM shipment_containers container
                  JOIN shipment_container_lines container_line ON container_line.container_id = container.container_id
                  WHERE container.shipment_id = phase6_shipments.shipment_id
                    AND container.status <> 'CANCELLED'
                ) THEN 'LOADED' ELSE 'BOOKED' END,
                actual_loading_date = ?, schedule_result = ?, schedule_note = ?,
                updated_by = ?, updated_at = CURRENT_TIMESTAMP
            WHERE shipment_id = ? AND status = 'BOOKED'
          `).bind(schedule.actualLoadingDate, scheduleResult, scheduleNote, actorId, shipmentId),
          auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'ACTUAL_LOADING_DATE_RECORDED', actorId, {
            actualLoadingDate: schedule.actualLoadingDate,
            scheduleResult,
            scheduleNote
          })
        ]);
        if (!mutationApplied(results[0])) throw codedError('SHIPMENT_NOT_BOOKED');
      }
      return findPhase6Shipment(db, shipmentId);
    },

    async replaceShipmentContainers(shipmentId, containerInput, actorId) {
      const containers = validateShipmentContainers(containerInput);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      if (!['BOOKED', 'LOADED'].includes(shipment.status)) throw codedError('SHIPMENT_NOT_BOOKED');

      const lineReferences = await findShipmentContainerLineReferences(db, shipment.di_id, containers);
      const quantitiesByPoLine = new Map();
      for (const container of containers) {
        for (const line of container.lines) {
          quantitiesByPoLine.set(
            line.poRevisionLineId,
            Number(quantitiesByPoLine.get(line.poRevisionLineId) || 0) + line.netWeightMt
          );
        }
      }
      for (const [poRevisionLineId, actualQtyMt] of quantitiesByPoLine) {
        const reference = lineReferences.get(poRevisionLineId);
        if (actualQtyMt > Number(reference.planned_qty_mt) + 0.000001) {
          throw codedError('CONTAINER_LINE_QTY_EXCEEDS_PLANNED');
        }
      }

      const deliveryInstruction = await findDeliveryInstruction(db, shipment.di_id);
      if (!deliveryInstruction) throw codedError('DI_NOT_FOUND');
      await assertContainerPoLineCapacity(db, shipment, deliveryInstruction.lines, quantitiesByPoLine);

      const existingContainers = await listShipmentContainers(db, shipmentId);
      const nextContainerVersion = Number(shipment.container_version) + 1;
      const containerWriteToken = crypto.randomUUID();
      const eventType = existingContainers.length ? 'CONTAINER_UPDATED' : 'CONTAINER_ADDED';
      const capacityGuard = containerPoLineCapacityGuard(deliveryInstruction.lines, quantitiesByPoLine);
      const statements = [
        db.prepare(`
          UPDATE phase6_shipments
          SET container_version = ?, container_write_token = ?,
              status = CASE WHEN actual_loading_date IS NOT NULL THEN 'LOADED' ELSE 'BOOKED' END,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE shipment_id = ? AND status IN ('BOOKED', 'LOADED') AND container_version = ?
            AND NOT EXISTS (
              SELECT 1
              FROM shipment_invoices
              WHERE shipment_id = phase6_shipments.shipment_id AND version = 'FINAL'
            )
            ${capacityGuard.sql}
        `).bind(
          nextContainerVersion,
          containerWriteToken,
          actorId,
          shipmentId,
          shipment.container_version,
          ...capacityGuard.parameters
        ),
        db.prepare(`
          DELETE FROM shipment_containers
          WHERE shipment_id = ?
            AND EXISTS (
              SELECT 1 FROM phase6_shipments
              WHERE shipment_id = ? AND container_version = ? AND container_write_token = ?
            )
        `).bind(shipmentId, shipmentId, nextContainerVersion, containerWriteToken)
      ];

      for (const container of containers) {
        const containerId = `CTR-${crypto.randomUUID()}`;
        statements.push(db.prepare(`
          INSERT INTO shipment_containers (container_id, shipment_id, container_no, seal_no, status, created_by, updated_by)
          SELECT ?, ?, ?, ?, 'LOADED', ?, ?
          WHERE EXISTS (
            SELECT 1 FROM phase6_shipments
            WHERE shipment_id = ? AND container_version = ? AND container_write_token = ?
          )
        `).bind(containerId, shipmentId, container.containerNo, container.sealNo, actorId, actorId, shipmentId, nextContainerVersion, containerWriteToken));
        for (const line of container.lines) {
          const reference = lineReferences.get(line.poRevisionLineId);
          statements.push(db.prepare(`
            INSERT INTO shipment_container_lines (
              container_line_id, container_id, delivery_instruction_line_id, number_of_bags, qty_mt, created_by, updated_by
            )
            SELECT ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM phase6_shipments
              WHERE shipment_id = ? AND container_version = ? AND container_write_token = ?
            )
          `).bind(
            `CTRL-${crypto.randomUUID()}`,
            containerId,
            reference.di_line_id,
            line.numberOfBags,
            line.netWeightMt,
            actorId,
            actorId,
            shipmentId,
            nextContainerVersion,
            containerWriteToken
          ));
        }
      }
      statements.push(db.prepare(`
        INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
        SELECT ?, 'SHIPMENT', ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM phase6_shipments
          WHERE shipment_id = ? AND container_version = ? AND container_write_token = ?
        )
      `).bind(
        `EVT-${crypto.randomUUID()}`,
        shipmentId,
        eventType,
        actorId,
        JSON.stringify({ containers }),
        shipmentId,
        nextContainerVersion,
        containerWriteToken
      ));

      const results = await db.batch(statements);
      if (!mutationApplied(results[0])) {
        const finalInvoice = await db.prepare(`
          SELECT 1
          FROM shipment_invoices
          WHERE shipment_id = ? AND version = 'FINAL'
          LIMIT 1
        `).bind(shipmentId).first();
        if (finalInvoice) throw codedError('SHIPMENT_CONTAINERS_FINALIZED');
        await assertContainerPoLineCapacity(db, shipment, deliveryInstruction.lines, quantitiesByPoLine);
        throw codedError('SHIPMENT_CONTAINERS_STALE');
      }
      const updatedShipment = await findPhase6Shipment(db, shipmentId);
      return {
        actual_qty_mt: Number(updatedShipment.actual_qty_mt),
        shipment: updatedShipment
      };
    },

    async getShipmentActualQty(shipmentId) {
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      return Number(shipment.actual_qty_mt);
    },

    async listShipmentContainers(shipmentId) {
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      return listShipmentContainers(db, shipmentId);
    },

    async updateShipmentDocuments(shipmentId, dto, actorId) {
      const documents = validateShipmentDocuments(dto);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      if (shipment.status !== 'LOADED') throw codedError('SHIPMENT_NOT_LOADED');
      if (!isDocumentRequirementSatisfied(documents)) throw codedError('DOCUMENT_REQUIREMENT_NOT_SATISFIED');

      const results = await db.batch([
        db.prepare(`
          UPDATE phase6_shipments
          SET status = 'DOCS_SENT', all_ship_docs_drive_url = ?, digital_docs_sent_date = ?,
              original_docs_required = ?, dhl_sent_date = ?, dhl_tracking_no = ?, docs_note = ?,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE shipment_id = ? AND status = 'LOADED'
        `).bind(
          documents.allShipDocsDriveUrl,
          documents.digitalDocsSentDate,
          documents.originalDocsRequired ? 1 : 0,
          documents.dhlSentDate,
          documents.dhlTrackingNo,
          documents.docsNote,
          actorId,
          shipmentId
        ),
        auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'DOCS_EMAIL_SENT', actorId, {
          allShipDocsDriveUrl: documents.allShipDocsDriveUrl,
          digitalDocsSentDate: documents.digitalDocsSentDate
        }),
        ...(documents.originalDocsRequired ? [
          auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'DOCS_DHL_SENT', actorId, {
            dhlSentDate: documents.dhlSentDate,
            dhlTrackingNo: documents.dhlTrackingNo
          })
        ] : [])
      ]);
      if (!mutationApplied(results[0])) throw codedError('SHIPMENT_NOT_LOADED');
      return recomputeShipmentCompletion(db, shipmentId, actorId);
    },

    async createCustomerCredit(dto, actorId) {
      const credit = validateCustomerCredit(dto);
      const prior = await findCustomerCreditByRequestKey(db, credit.requestKey);
      if (prior) {
        if (
          prior.customer_id !== credit.customerId ||
          moneyCents(prior.amount) !== moneyCents(credit.amount) ||
          prior.reason !== credit.reason
        ) throw codedError('CREDIT_REQUEST_KEY_CONFLICT');
        return prior;
      }
      const customer = await db.prepare('SELECT customer_id FROM customers WHERE customer_id = ?').bind(credit.customerId).first();
      if (!customer) throw codedError('CREDIT_CUSTOMER_NOT_FOUND');
      const creditId = `CR-${crypto.randomUUID()}`;
      try {
        await db.batch([
          db.prepare(`
            INSERT INTO customer_credits (credit_id, customer_id, amount, reason, remaining_amount, request_key, created_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(creditId, credit.customerId, credit.amount, credit.reason, credit.amount, credit.requestKey, actorId),
          auditStatement(db, 'CREDIT', creditId, 'CUSTOMER_CREDIT_CREATED', actorId, {
            customerId: credit.customerId,
            amount: credit.amount,
            reason: credit.reason
          })
        ]);
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE constraint failed: customer_credits.request_key')) throw error;
        const duplicate = await findCustomerCreditByRequestKey(db, credit.requestKey);
        if (duplicate) {
          if (
            duplicate.customer_id !== credit.customerId ||
            moneyCents(duplicate.amount) !== moneyCents(credit.amount) ||
            duplicate.reason !== credit.reason
          ) throw codedError('CREDIT_REQUEST_KEY_CONFLICT');
          return duplicate;
        }
        throw error;
      }
      return findCustomerCredit(db, creditId);
    },

    async listCustomerCredits(filters = {}) {
      let query = `
        SELECT credit_id, customer_id, amount, reason, remaining_amount, created_by, created_at
        FROM customer_credits
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.customerId) {
        query += ' AND customer_id = ?';
        params.push(filters.customerId);
      }
      query += ' ORDER BY created_at DESC, rowid DESC';
      const { results } = await db.prepare(query).bind(...params).all();
      return (results || []).map((credit) => ({
        ...credit,
        amount: Number(credit.amount),
        remaining_amount: Number(credit.remaining_amount)
      }));
    },

    async recalculateShipmentPayment(shipmentId, actorId) {
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      await db.batch([paymentUpdateStatement(db, shipmentId, actorId)]);
      return recomputeShipmentCompletion(db, shipmentId, actorId);
    },

    async recomputeShipmentCompletion(shipmentId, actorId) {
      return recomputeShipmentCompletion(db, shipmentId, actorId);
    },

    async updateShipmentPayment(shipmentId, dto, actorId) {
      const payment = validateShipmentPayment(dto);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      await assertShipmentPaymentChangeAllowed(
        await findShipmentPaymentSummary(db, shipmentId),
        payment.cashReceivedAmount
      );
      const results = await db.batch([
        paymentUpdateStatement(db, shipmentId, actorId, payment),
        auditAfterMutationStatement(db, 'SHIPMENT', shipmentId, 'PAYMENT_UPDATED', actorId, {
          cashReceivedAmount: payment.cashReceivedAmount,
          paymentNote: payment.paymentNote
        })
      ]);
      if (!mutationApplied(results[0])) throw codedError('SHIPMENT_NOT_FOUND');
      return recomputeShipmentCompletion(db, shipmentId, actorId);
    },

    async useCustomerCredit(shipmentId, dto, actorId) {
      const usage = validateCustomerCreditUsage(dto);
      const priorUsage = await findCustomerCreditUsageByRequestKey(db, usage.requestKey);
      if (priorUsage) {
        if (
          priorUsage.shipment_id !== shipmentId ||
          priorUsage.credit_id !== usage.creditId ||
          priorUsage.invoice_id !== usage.invoiceId ||
          moneyCents(priorUsage.amount) !== moneyCents(usage.amount)
        ) throw codedError('CREDIT_USAGE_REQUEST_KEY_CONFLICT');
        return recomputeShipmentCompletion(db, priorUsage.shipment_id, actorId);
      }
      const shipment = await findShipmentCustomer(db, shipmentId);
      if (!shipment) throw codedError('SHIPMENT_NOT_FOUND');
      const credit = await findCustomerCredit(db, usage.creditId);
      if (!credit) throw codedError('CREDIT_NOT_FOUND');
      if (credit.customer_id !== shipment.customer_id) throw codedError('CREDIT_CUSTOMER_MISMATCH');
      if (usage.invoiceId) {
        const invoice = await db.prepare(`
          SELECT invoice_id
          FROM shipment_invoices
          WHERE invoice_id = ? AND shipment_id = ?
        `).bind(usage.invoiceId, shipmentId).first();
        if (!invoice) throw codedError('CREDIT_INVOICE_SHIPMENT_MISMATCH');
      }
      if (Number(credit.remaining_amount) < usage.amount) throw codedError('CREDIT_BALANCE_EXCEEDED');
      const paymentSummary = await findShipmentPaymentSummary(db, shipmentId);
      if (!paymentSummary || Number(paymentSummary.final_invoice_count) === 0 ||
        moneyCents(usage.amount) > moneyCents(paymentSummary.final_total) - moneyCents(paymentSummary.cash_received_amount) - moneyCents(paymentSummary.allocated_credit)) {
        throw codedError('CREDIT_SHIPMENT_BALANCE_EXCEEDED');
      }

      const usageId = `CRU-${crypto.randomUUID()}`;
      let results;
      try {
        results = await db.batch([
        creditUsageReservationStatement(db, shipmentId, usage.creditId, shipment.customer_id, usage.amount),
        db.prepare(`
          INSERT INTO customer_credit_usages (credit_usage_id, credit_id, shipment_id, invoice_id, amount, request_key, actor_id)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE changes() = 1
        `).bind(usageId, usage.creditId, shipmentId, usage.invoiceId, usage.amount, usage.requestKey, actorId),
        paymentUpdateStatement(db, shipmentId, actorId, null, usageId),
        db.prepare(`
          INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
          SELECT ?, 'CREDIT', ?, 'CUSTOMER_CREDIT_USED', ?, ?
          WHERE EXISTS (SELECT 1 FROM customer_credit_usages WHERE credit_usage_id = ?)
        `).bind(
          `EVT-${crypto.randomUUID()}`,
          usage.creditId,
          actorId,
          JSON.stringify({ shipmentId, invoiceId: usage.invoiceId, amount: usage.amount }),
          usageId
        ),
        db.prepare(`
          INSERT INTO shipment_audit_events (event_id, entity_type, entity_id, event_type, actor_id, metadata_json)
          SELECT ?, 'SHIPMENT', ?, 'PAYMENT_UPDATED', ?, ?
          WHERE EXISTS (SELECT 1 FROM customer_credit_usages WHERE credit_usage_id = ?)
        `).bind(
          `EVT-${crypto.randomUUID()}`,
          shipmentId,
          actorId,
          JSON.stringify({ creditId: usage.creditId, amount: usage.amount }),
          usageId
        )
        ]);
      } catch (error) {
        if (!String(error?.message || '').includes('UNIQUE constraint failed: customer_credit_usages.request_key')) throw error;
        const duplicate = await findCustomerCreditUsageByRequestKey(db, usage.requestKey);
        if (duplicate) {
          if (
            duplicate.shipment_id !== shipmentId ||
            duplicate.credit_id !== usage.creditId ||
            duplicate.invoice_id !== usage.invoiceId ||
            moneyCents(duplicate.amount) !== moneyCents(usage.amount)
          ) throw codedError('CREDIT_USAGE_REQUEST_KEY_CONFLICT');
          return recomputeShipmentCompletion(db, duplicate.shipment_id, actorId);
        }
        throw error;
      }
      if (!mutationApplied(results[0]) || !mutationApplied(results[1])) {
        const afterCredit = await findCustomerCredit(db, usage.creditId);
        if (moneyCents(afterCredit?.remaining_amount) < moneyCents(usage.amount)) throw codedError('CREDIT_BALANCE_EXCEEDED');
        throw codedError('CREDIT_SHIPMENT_BALANCE_EXCEEDED');
      }
      return recomputeShipmentCompletion(db, shipmentId, actorId);
    },

    async createShipmentInvoice(shipmentId, dto, actorId) {
      const invoice = validateShipmentInvoice(dto);
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      if (!['BOOKED', 'LOADED', 'DOCS_SENT'].includes(shipment.status)) {
        throw codedError('SHIPMENT_NOT_BOOKED');
      }
      if (invoice.version === 'FINAL' && !['LOADED', 'DOCS_SENT'].includes(shipment.status)) throw codedError('INVOICE_FINAL_REQUIRES_ACTUAL_QTY');

      const resolved = await resolveShipmentInvoiceLines(db, shipment, invoice.lines, {
        preliminary: invoice.version === 'PRELIMINARY',
        final: invoice.version === 'FINAL'
      });
      if (invoice.version === 'FINAL') {
        const references = await findShipmentInvoiceLineReferences(db, shipment, invoice.lines);
        if ([...references.values()].some((reference) => Number(reference.tolerance_pct) > 0)) {
          throw codedError('INVOICE_FINALIZATION_REQUIRED');
        }
        await assertFinalInvoicePaymentObligation(db, shipmentId, resolved.lines);
      }

      const invoiceId = `INV-${crypto.randomUUID()}`;
      const invoiceWriteToken = crypto.randomUUID();
      const finalContainerVersion = invoice.version === 'FINAL' ? Number(shipment.container_version) : null;
      const finalReservation = invoice.version === 'FINAL' ? {
        version: Number(shipment.final_invoice_version) + 1,
        writeToken: crypto.randomUUID()
      } : null;
      const invoiceState = {
        invoiceId,
        version: invoice.version,
        invoiceVersion: 0,
        writeToken: invoiceWriteToken,
        finalContainerVersion
      };
      const statements = [
        ...(finalReservation ? [finalInvoiceReservationStatement(db, shipment, resolved.lines, finalReservation)] : []),
        db.prepare(`
          INSERT INTO shipment_invoices (
            invoice_id, shipment_id, invoice_no, invoice_date, currency, version, invoice_write_token, final_container_version, created_by, updated_by
          ) ${invoice.version === 'FINAL' ? `
            SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
            WHERE EXISTS (
              SELECT 1
              FROM phase6_shipments
              WHERE shipment_id = ? AND status IN ('LOADED', 'DOCS_SENT') AND container_version = ?
                AND final_invoice_version = ? AND final_invoice_write_token = ?
            )
          ` : 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'}
        `).bind(
          invoiceId,
          shipmentId,
          invoice.invoiceNo,
          invoice.invoiceDate,
          resolved.currency,
          invoice.version,
          invoiceWriteToken,
          finalContainerVersion,
          actorId,
          actorId,
          ...(invoice.version === 'FINAL' ? [shipmentId, finalContainerVersion, finalReservation.version, finalReservation.writeToken] : [])
        ),
        ...shipmentInvoiceLineStatements(db, invoiceId, resolved.lines, actorId, invoice.version === 'FINAL' ? invoiceState : null),
        invoice.version === 'FINAL'
          ? invoiceAuditForStateStatement(db, invoiceId, invoiceState, 'INVOICE_RECORDED', actorId, { shipmentId, invoiceNo: invoice.invoiceNo, version: invoice.version })
          : auditStatement(db, 'INVOICE', invoiceId, 'INVOICE_RECORDED', actorId, { shipmentId, invoiceNo: invoice.invoiceNo, version: invoice.version })
      ];
      if (invoice.version === 'FINAL') {
        statements.push(invoiceAuditForStateStatement(db, invoiceId, invoiceState, 'INVOICE_FINALIZED', actorId, { shipmentId }));
        statements.push(paymentUpdateStatement(db, shipmentId, actorId, null, null, invoiceState));
      }
      try {
        const results = await db.batch(statements);
        const headerResultIndex = invoice.version === 'FINAL' ? 1 : 0;
        if ((invoice.version === 'FINAL' && !mutationApplied(results[0])) || !mutationApplied(results[headerResultIndex])) {
          if (invoice.version === 'FINAL') await assertFinalInvoicePaymentObligation(db, shipmentId, resolved.lines);
          throw codedError(invoice.version === 'FINAL' ? 'INVOICE_FINAL_STALE' : 'INVOICE_NOT_CREATED');
        }
      } catch (error) {
        if (String(error?.message || '').includes('UNIQUE constraint failed: shipment_invoices.shipment_id, shipment_invoices.invoice_no')) {
          throw codedError('INVOICE_NUMBER_DUPLICATE');
        }
        throw error;
      }
      if (invoice.version === 'FINAL') await recomputeShipmentCompletion(db, shipmentId, actorId);
      return findShipmentInvoice(db, invoiceId);
    },

    async updateShipmentInvoice(invoiceId, dto, actorId, expectedShipmentId = null) {
      const invoice = validateShipmentInvoice(dto);
      const existing = await findShipmentInvoice(db, invoiceId);
      if (!existing) throw codedError('INVOICE_NOT_FOUND');
      if (expectedShipmentId && existing.shipment_id !== expectedShipmentId) throw codedError('INVOICE_NOT_FOUND');
      if (existing.version !== 'PRELIMINARY' || invoice.version !== 'PRELIMINARY') throw codedError('INVOICE_NOT_PRELIMINARY');
      const shipment = await findPhase6Shipment(db, existing.shipment_id);
      if (!shipment || shipment.shipment_id !== existing.shipment_id) throw codedError('SHIPMENT_NOT_FOUND');
      const resolved = await resolveShipmentInvoiceLines(db, shipment, invoice.lines, { preliminary: true });
      const nextInvoiceVersion = Number(existing.invoice_version) + 1;
      const nextInvoiceWriteToken = crypto.randomUUID();
      const invoiceState = { version: 'PRELIMINARY', invoiceVersion: nextInvoiceVersion, writeToken: nextInvoiceWriteToken, finalContainerVersion: null };
      const results = await db.batch([
        db.prepare(`
          UPDATE shipment_invoices
          SET invoice_no = ?, invoice_date = ?, currency = ?, invoice_version = ?, invoice_write_token = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE invoice_id = ? AND version = 'PRELIMINARY' AND invoice_version = ? AND invoice_write_token = ?
        `).bind(invoice.invoiceNo, invoice.invoiceDate, resolved.currency, nextInvoiceVersion, nextInvoiceWriteToken, actorId, invoiceId, existing.invoice_version, existing.invoice_write_token),
        db.prepare(`
          DELETE FROM shipment_invoice_lines
          WHERE invoice_id = ? AND EXISTS (
            SELECT 1 FROM shipment_invoices
            WHERE invoice_id = ? AND version = 'PRELIMINARY' AND invoice_version = ? AND invoice_write_token = ? AND final_container_version IS NULL
          )
        `).bind(invoiceId, invoiceId, nextInvoiceVersion, nextInvoiceWriteToken),
        ...shipmentInvoiceLineStatements(db, invoiceId, resolved.lines, actorId, invoiceState)
      ]);
      if (!mutationApplied(results[0])) throw codedError('INVOICE_NOT_PRELIMINARY');
      return findShipmentInvoice(db, invoiceId);
    },

    async finalizeShipmentInvoice(invoiceId, lines, actorId, expectedShipmentId = null) {
      const finalLines = validateShipmentInvoiceFinalization(lines);
      const existing = await findShipmentInvoice(db, invoiceId);
      if (!existing) throw codedError('INVOICE_NOT_FOUND');
      if (expectedShipmentId && existing.shipment_id !== expectedShipmentId) throw codedError('INVOICE_NOT_FOUND');
      if (existing.version !== 'PRELIMINARY') throw codedError('INVOICE_NOT_PRELIMINARY');
      const shipment = await findPhase6Shipment(db, existing.shipment_id);
      if (!shipment || shipment.shipment_id !== existing.shipment_id) throw codedError('SHIPMENT_NOT_FOUND');
      if (!['LOADED', 'DOCS_SENT'].includes(shipment.status)) throw codedError('INVOICE_FINAL_REQUIRES_ACTUAL_QTY');
      const resolved = await resolveShipmentInvoiceLines(db, shipment, finalLines, { final: true });
      await assertFinalInvoicePaymentObligation(db, shipment.shipment_id, resolved.lines);
      const finalContainerVersion = Number(shipment.container_version);
      const nextInvoiceVersion = Number(existing.invoice_version) + 1;
      const nextInvoiceWriteToken = crypto.randomUUID();
      const finalReservation = {
        version: Number(shipment.final_invoice_version) + 1,
        writeToken: crypto.randomUUID()
      };
      const invoiceState = { invoiceId, version: 'FINAL', invoiceVersion: nextInvoiceVersion, writeToken: nextInvoiceWriteToken, finalContainerVersion };
      const results = await db.batch([
        finalInvoiceReservationStatement(db, shipment, resolved.lines, finalReservation),
        db.prepare(`
          UPDATE shipment_invoices
          SET version = 'FINAL', currency = ?, invoice_version = ?, invoice_write_token = ?, final_container_version = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE invoice_id = ? AND version = 'PRELIMINARY' AND invoice_version = ? AND invoice_write_token = ?
            AND EXISTS (
              SELECT 1
              FROM phase6_shipments
              WHERE shipment_id = ? AND status IN ('LOADED', 'DOCS_SENT') AND container_version = ?
                AND final_invoice_version = ? AND final_invoice_write_token = ?
            )
        `).bind(resolved.currency, nextInvoiceVersion, nextInvoiceWriteToken, finalContainerVersion, actorId, invoiceId, existing.invoice_version, existing.invoice_write_token, shipment.shipment_id, finalContainerVersion, finalReservation.version, finalReservation.writeToken),
        db.prepare(`
          DELETE FROM shipment_invoice_lines
          WHERE invoice_id = ? AND EXISTS (
            SELECT 1 FROM shipment_invoices
            WHERE invoice_id = ? AND version = 'FINAL' AND invoice_version = ? AND invoice_write_token = ? AND final_container_version = ?
          )
        `).bind(invoiceId, invoiceId, nextInvoiceVersion, nextInvoiceWriteToken, finalContainerVersion),
        ...shipmentInvoiceLineStatements(db, invoiceId, resolved.lines, actorId, invoiceState),
        invoiceAuditForStateStatement(db, invoiceId, invoiceState, 'INVOICE_FINALIZED', actorId, {
          shipmentId: shipment.shipment_id,
          invoiceNo: existing.invoice_no
        }),
        paymentUpdateStatement(db, shipment.shipment_id, actorId, null, null, invoiceState)
      ]);
      if (!mutationApplied(results[0]) || !mutationApplied(results[1])) {
        await assertFinalInvoicePaymentObligation(db, shipment.shipment_id, resolved.lines);
        throw codedError('INVOICE_NOT_PRELIMINARY');
      }
      await recomputeShipmentCompletion(db, shipment.shipment_id, actorId);
      return findShipmentInvoice(db, invoiceId);
    },

    async getShipmentInvoices(shipmentId) {
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      const { results } = await db.prepare(`
        SELECT invoice_id
        FROM shipment_invoices
        WHERE shipment_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).bind(shipmentId).all();
      return Promise.all((results || []).map((invoice) => findShipmentInvoice(db, invoice.invoice_id)));
    },

    async getPhase6Shipment(identifier) {
      return findPhase6Shipment(db, identifier);
    },

    async getPhase6ShipmentByShipmentId(shipmentId) {
      return findPhase6ShipmentReadModel(db, shipmentId, 'shipment_id');
    },

    async getPhase6ShipmentByDeliveryInstructionId(diId) {
      return findPhase6ShipmentReadModel(db, diId, 'di_id');
    },

    async getPhase6ShipmentHistoryByShipmentId(shipmentId) {
      const shipment = await findPhase6Shipment(db, shipmentId);
      if (!shipment || shipment.shipment_id !== shipmentId) throw codedError('SHIPMENT_NOT_FOUND');
      const { results } = await db.prepare(`
        SELECT event_id, entity_type, entity_id, event_type, actor_id, metadata_json, created_at
        FROM shipment_audit_events
        WHERE entity_type = 'SHIPMENT' AND entity_id = ?
        ORDER BY created_at ASC, rowid ASC
      `).bind(shipmentId).all();
      return results || [];
    },

    async listDeliveryInstructions(filters = {}) {
      let query = `
        SELECT di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan,
               status, lifecycle_version, note, cancellation_note, di_drive_url, surveyor_partner_id, forwarder_partner_id,
               created_by, created_at, updated_by, updated_at
        FROM delivery_instructions
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.customerId) {
        query += ' AND customer_id = ?';
        params.push(filters.customerId);
      }
      if (filters.poId) {
        query += ' AND po_id = ?';
        params.push(filters.poId);
      }
      if (filters.status) {
        query += ' AND status = ?';
        params.push(filters.status);
      }
      query += ' ORDER BY created_at DESC, di_id DESC';
      const { results } = await db.prepare(query).bind(...params).all();
      return results || [];
    },

    async listDeliveryInstructionWorkspace(filters = {}) {
      let query = `
        SELECT
          di.di_id, di.di_no, di.customer_id, customer.customer_name, di.po_id,
          revision.customer_po_no, di.shipping_month, di.shipping_period, di.container_plan,
          di.status AS di_status,
          COALESCE((SELECT SUM(line.planned_qty_mt) FROM delivery_instruction_lines line WHERE line.di_id = di.di_id), 0) AS planned_qty_mt,
          COALESCE((SELECT GROUP_CONCAT(product.product_name, ', ') FROM delivery_instruction_lines line JOIN products product ON product.product_id = line.product_id WHERE line.di_id = di.di_id), '') AS product_summary,
          COALESCE((SELECT GROUP_CONCAT(line.packing_snapshot, ', ') FROM delivery_instruction_lines line WHERE line.di_id = di.di_id), '') AS packing_summary,
          shipment.shipment_id, shipment.booking_no, shipment.planned_loading_date, shipment.actual_loading_date,
          shipment.schedule_result, shipment.status AS shipment_status, shipment.payment_status
        FROM delivery_instructions di
        JOIN customers customer ON customer.customer_id = di.customer_id
        LEFT JOIN po_revisions revision ON revision.revision_id = di.po_revision_id
        LEFT JOIN phase6_shipments shipment ON shipment.di_id = di.di_id
        WHERE 1 = 1
      `;
      const params = [];
      if (filters.diStatus) { query += ' AND di.status = ?'; params.push(filters.diStatus); }
      if (filters.shipmentStatus) { query += ' AND shipment.status = ?'; params.push(filters.shipmentStatus); }
      if (filters.shippingMonth) { query += ' AND di.shipping_month = ?'; params.push(filters.shippingMonth); }
      if (filters.scheduleResult) { query += ' AND shipment.schedule_result = ?'; params.push(filters.scheduleResult); }
      if (filters.paymentStatus) { query += ' AND shipment.payment_status = ?'; params.push(filters.paymentStatus); }
      if (filters.search) {
        const like = `%${filters.search}%`;
        query += ` AND (
          di.di_no LIKE ? COLLATE NOCASE OR di.po_id LIKE ? COLLATE NOCASE OR revision.customer_po_no LIKE ? COLLATE NOCASE OR
          customer.customer_name LIKE ? COLLATE NOCASE OR shipment.booking_no LIKE ? COLLATE NOCASE OR
          EXISTS (SELECT 1 FROM shipment_invoices invoice WHERE invoice.shipment_id = shipment.shipment_id AND invoice.invoice_no LIKE ? COLLATE NOCASE) OR
          EXISTS (SELECT 1 FROM shipment_containers container WHERE container.shipment_id = shipment.shipment_id AND container.container_no LIKE ? COLLATE NOCASE)
        )`;
        params.push(like, like, like, like, like, like, like);
      }
      query += ' ORDER BY di.created_at DESC, di.di_id DESC';
      const { results } = await db.prepare(query).bind(...params).all();
      return (results || []).map((row) => ({ ...row, planned_qty_mt: Number(row.planned_qty_mt) }));
    },

    async suggestPartnersForCustomer(customerId) {
      const latest = await db.prepare(`
        SELECT surveyor_partner_id, forwarder_partner_id
        FROM delivery_instructions
        WHERE customer_id = ? AND status <> 'CANCELLED'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `).bind(customerId).first();
      return {
        surveyor_partner_id: latest?.surveyor_partner_id || null,
        forwarder_partner_id: latest?.forwarder_partner_id || null
      };
    },

    async getPoLineBalances(poId) {
      const { results } = await db.prepare(`
        WITH actual_by_line AS (
          SELECT dil.po_revision_line_id, SUM(scl.qty_mt) AS actual_qty_mt
          FROM delivery_instruction_lines dil
          JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = dil.di_line_id
          JOIN shipment_containers sc ON sc.container_id = scl.container_id
          JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
          WHERE s.status <> 'CANCELLED' AND sc.status <> 'CANCELLED'
          GROUP BY dil.po_revision_line_id
        ),
        unrepresented_planned_by_line AS (
          SELECT dil.po_revision_line_id, SUM(dil.planned_qty_mt) AS unrepresented_planned_qty_mt
          FROM delivery_instruction_lines dil
          JOIN delivery_instructions di ON di.di_id = dil.di_id
          WHERE di.po_id = ?
            AND di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
            AND NOT EXISTS (
              SELECT 1
              FROM delivery_instruction_lines actual_dil
              JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = actual_dil.di_line_id
              JOIN shipment_containers sc ON sc.container_id = scl.container_id
              JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
              WHERE actual_dil.di_line_id = dil.di_line_id
                AND s.status <> 'CANCELLED'
                AND sc.status <> 'CANCELLED'
            )
          GROUP BY dil.po_revision_line_id
        )
        SELECT l.line_id AS po_revision_line_id, l.po_revision_id, l.line_no, l.product_id,
               l.contract_qty_mt, l.max_qty_mt,
               COALESCE(a.actual_qty_mt, 0) AS actual_qty_mt,
               COALESCE(p.unrepresented_planned_qty_mt, 0) AS unrepresented_planned_qty_mt,
               l.max_qty_mt - COALESCE(a.actual_qty_mt, 0) - COALESCE(p.unrepresented_planned_qty_mt, 0) AS available_qty_mt
        FROM po_revision_lines l
        JOIN po_revisions r ON r.revision_id = l.po_revision_id
        LEFT JOIN actual_by_line a ON a.po_revision_line_id = l.line_id
        LEFT JOIN unrepresented_planned_by_line p ON p.po_revision_line_id = l.line_id
        WHERE r.po_id = ?
        ORDER BY l.line_no ASC
      `).bind(poId, poId).all();
      return results || [];
    },

    async assertDeliveryInstructionAvailability(lines, excludedDiId = null) {
      const requestedLines = validateDeliveryInstructionAvailabilityLines(lines);
      const balancesByPoId = new Map();
      const priorAllocationByLineId = new Map();

      if (excludedDiId) {
        const { results } = await db.prepare(`
          SELECT dil.po_revision_line_id, SUM(dil.planned_qty_mt) AS planned_qty_mt
          FROM delivery_instruction_lines dil
          JOIN delivery_instructions di ON di.di_id = dil.di_id
          WHERE dil.di_id = ?
            AND di.status IN ('DRAFT', 'CONFIRMED', 'IN_PROGRESS')
            AND NOT EXISTS (
              SELECT 1
              FROM delivery_instruction_lines actual_dil
              JOIN shipment_container_lines scl ON scl.delivery_instruction_line_id = actual_dil.di_line_id
              JOIN shipment_containers sc ON sc.container_id = scl.container_id
              JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
              WHERE actual_dil.di_line_id = dil.di_line_id
                AND s.status <> 'CANCELLED'
                AND sc.status <> 'CANCELLED'
            )
          GROUP BY dil.po_revision_line_id
        `).bind(excludedDiId).all();
        for (const allocation of results || []) {
          priorAllocationByLineId.set(allocation.po_revision_line_id, allocation.planned_qty_mt);
        }
      }

      for (const line of requestedLines) {
        if (!balancesByPoId.has(line.poId)) {
          balancesByPoId.set(line.poId, await this.getPoLineBalances(line.poId));
        }
        const balance = balancesByPoId.get(line.poId)
          .find((candidate) => candidate.po_revision_line_id === line.poRevisionLineId);
        if (!balance || balance.po_revision_id !== line.poRevisionId) throw codedError('DI_LINE_PO_LINEAGE_INVALID');

        const priorAllocation = Number(priorAllocationByLineId.get(line.poRevisionLineId) || 0);
        if (line.plannedQtyMt > balance.available_qty_mt + priorAllocation + 0.000001) {
          throw codedError('DI_QTY_EXCEEDS_MAX_ALLOWED');
        }
      }
    }
  };
}
