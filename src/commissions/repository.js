import {
  codedError,
  validateSettlePayload,
  validateSettlementNoteUpdate
} from './validation.js';

function round2(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function round4(value) {
  return Math.round(Number(value || 0) * 10000) / 10000;
}

function safeParseJsonArray(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function nextSettlementId(db) {
  const row = await db.prepare(`
    SELECT COALESCE(MAX(CAST(SUBSTR(settlement_id, 4) AS INTEGER)), 0) AS max_id
    FROM commission_settlements
    WHERE settlement_id GLOB 'CS-[0-9]*'
  `).first();
  return `CS-${String(Number(row?.max_id || 0) + 1).padStart(4, '0')}`;
}

async function findSettlementById(db, settlementId) {
  const row = await db.prepare(`
    SELECT
      cs.settlement_id,
      cs.shipment_id,
      cs.di_id,
      di.di_no,
      cs.po_id,
      cs.po_revision_id,
      pr.customer_po_no,
      pr.currency AS po_currency,
      cs.customer_id,
      c.customer_code,
      c.customer_name,
      cs.recipient_user_id,
      rec.full_name AS recipient_name,
      cs.actual_mt_snapshot,
      cs.rate_snapshot_usd_mt,
      cs.amount_usd_snapshot,
      cs.currency,
      cs.line_breakdown_json,
      cs.status,
      cs.paid_date,
      cs.payment_reference,
      cs.note,
      cs.request_key,
      cs.settled_by,
      settler.full_name AS settled_by_name,
      cs.settled_at,
      s.status AS shipment_status,
      s.payment_status,
      s.etd,
      s.actual_loading_date,
      (SELECT GROUP_CONCAT(inv.invoice_no, ', ') FROM shipment_invoices inv WHERE inv.shipment_id = cs.shipment_id AND inv.version = 'FINAL') AS final_invoice_nos
    FROM commission_settlements cs
    JOIN phase6_shipments s ON s.shipment_id = cs.shipment_id
    JOIN delivery_instructions di ON di.di_id = cs.di_id
    JOIN po_revisions pr ON pr.revision_id = cs.po_revision_id
    JOIN customers c ON c.customer_id = cs.customer_id
    JOIN users rec ON rec.user_id = cs.recipient_user_id
    JOIN users settler ON settler.user_id = cs.settled_by
    WHERE cs.settlement_id = ?
    LIMIT 1
  `).bind(settlementId).first();
  if (!row) return null;
  return normalizeSettlementRecord(row);
}

async function findSettlementByRequestKey(db, requestKey) {
  const row = await db.prepare(`
    SELECT settlement_id
    FROM commission_settlements
    WHERE request_key = ?
    LIMIT 1
  `).bind(requestKey).first();
  if (!row) return null;
  return findSettlementById(db, row.settlement_id);
}

async function findSettlementByShipmentAndRecipient(db, shipmentId, recipientUserId) {
  const row = await db.prepare(`
    SELECT settlement_id
    FROM commission_settlements
    WHERE shipment_id = ? AND recipient_user_id = ?
    LIMIT 1
  `).bind(shipmentId, recipientUserId).first();
  if (!row) return null;
  return findSettlementById(db, row.settlement_id);
}

function normalizeSettlementRecord(row) {
  return {
    settlement_id: row.settlement_id,
    shipment_id: row.shipment_id,
    di_id: row.di_id,
    di_no: row.di_no,
    po_id: row.po_id,
    po_revision_id: row.po_revision_id,
    customer_po_no: row.customer_po_no || null,
    po_currency: row.po_currency || 'USD',
    customer_id: row.customer_id,
    customer_code: row.customer_code || null,
    customer_name: row.customer_name,
    recipient_user_id: row.recipient_user_id,
    recipient_name: row.recipient_name,
    actual_mt_snapshot: round3(row.actual_mt_snapshot),
    rate_snapshot_usd_mt: round4(row.rate_snapshot_usd_mt),
    amount_usd_snapshot: round2(row.amount_usd_snapshot),
    currency: row.currency || 'USD',
    line_breakdown: safeParseJsonArray(row.line_breakdown_json),
    status: row.status,
    paid_date: row.paid_date,
    payment_reference: row.payment_reference || null,
    note: row.note || null,
    settled_by: row.settled_by,
    settled_by_name: row.settled_by_name || null,
    settled_at: row.settled_at,
    shipment_status: row.shipment_status,
    payment_status: row.payment_status,
    etd: row.etd || null,
    actual_loading_date: row.actual_loading_date || null,
    final_invoice_nos: row.final_invoice_nos || null
  };
}

async function loadAllCommissionItems(db, scope = {}) {
  let lineQuery = `
    SELECT
      s.shipment_id,
      s.di_id,
      di.di_no,
      di.po_id,
      di.po_revision_id,
      pr.customer_po_no,
      pr.currency AS po_currency,
      di.customer_id,
      c.customer_code,
      c.customer_name,
      prl.line_id AS po_revision_line_id,
      prl.commission_recipient_user_id AS recipient_user_id,
      rec.full_name AS recipient_name,
      prl.commission_rate_usd_mt,
      p.product_code,
      p.product_name,
      dil.planned_qty_mt,
      s.status AS shipment_status,
      s.payment_status,
      s.etd,
      s.actual_loading_date,
      s.created_at,
      ROUND(COALESCE((
        SELECT SUM(scl.qty_mt)
        FROM shipment_container_lines scl
        JOIN shipment_containers sc ON sc.container_id = scl.container_id
        WHERE scl.delivery_instruction_line_id = dil.di_line_id
          AND sc.shipment_id = s.shipment_id
          AND sc.status <> 'CANCELLED'
      ), 0), 3) AS actual_mt,
      (SELECT COUNT(*) FROM shipment_invoices inv WHERE inv.shipment_id = s.shipment_id AND inv.version = 'FINAL') AS final_invoice_count,
      (SELECT GROUP_CONCAT(inv.invoice_no, ', ') FROM shipment_invoices inv WHERE inv.shipment_id = s.shipment_id AND inv.version = 'FINAL') AS final_invoice_nos
    FROM phase6_shipments s
    JOIN delivery_instructions di ON di.di_id = s.di_id
    JOIN delivery_instruction_lines dil ON dil.di_id = di.di_id
    JOIN po_revision_lines prl ON prl.line_id = dil.po_revision_line_id
    JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
    JOIN customers c ON c.customer_id = di.customer_id
    JOIN products p ON p.product_id = dil.product_id
    JOIN users rec ON rec.user_id = prl.commission_recipient_user_id
    WHERE s.status <> 'CANCELLED'
      AND di.status <> 'CANCELLED'
      AND prl.commission_recipient_user_id IS NOT NULL
      AND prl.commission_rate_usd_mt > 0
  `;
  const lineParams = [];
  if (scope.shipmentId) {
    lineQuery += ' AND s.shipment_id = ?';
    lineParams.push(scope.shipmentId);
  }
  if (scope.recipientUserId) {
    lineQuery += ' AND prl.commission_recipient_user_id = ?';
    lineParams.push(scope.recipientUserId);
  }
  if (scope.customerId) {
    lineQuery += ' AND di.customer_id = ?';
    lineParams.push(scope.customerId);
  }
  lineQuery += ' ORDER BY s.shipment_id ASC, prl.line_no ASC';

  const { results: lineRows } = await db.prepare(lineQuery).bind(...lineParams).all();

  let settlementQuery = `
    SELECT
      cs.settlement_id,
      cs.shipment_id,
      cs.di_id,
      di.di_no,
      cs.po_id,
      cs.po_revision_id,
      pr.customer_po_no,
      pr.currency AS po_currency,
      cs.customer_id,
      c.customer_code,
      c.customer_name,
      cs.recipient_user_id,
      rec.full_name AS recipient_name,
      cs.actual_mt_snapshot,
      cs.rate_snapshot_usd_mt,
      cs.amount_usd_snapshot,
      cs.currency,
      cs.line_breakdown_json,
      cs.status,
      cs.paid_date,
      cs.payment_reference,
      cs.note,
      cs.settled_by,
      settler.full_name AS settled_by_name,
      cs.settled_at,
      s.status AS shipment_status,
      s.payment_status,
      s.etd,
      s.actual_loading_date,
      s.created_at,
      (SELECT GROUP_CONCAT(inv.invoice_no, ', ') FROM shipment_invoices inv WHERE inv.shipment_id = cs.shipment_id AND inv.version = 'FINAL') AS final_invoice_nos
    FROM commission_settlements cs
    JOIN phase6_shipments s ON s.shipment_id = cs.shipment_id
    JOIN delivery_instructions di ON di.di_id = cs.di_id
    JOIN po_revisions pr ON pr.revision_id = cs.po_revision_id
    JOIN customers c ON c.customer_id = cs.customer_id
    JOIN users rec ON rec.user_id = cs.recipient_user_id
    JOIN users settler ON settler.user_id = cs.settled_by
    WHERE 1 = 1
  `;
  const settlementParams = [];
  if (scope.shipmentId) {
    settlementQuery += ' AND cs.shipment_id = ?';
    settlementParams.push(scope.shipmentId);
  }
  if (scope.recipientUserId) {
    settlementQuery += ' AND cs.recipient_user_id = ?';
    settlementParams.push(scope.recipientUserId);
  }
  if (scope.customerId) {
    settlementQuery += ' AND cs.customer_id = ?';
    settlementParams.push(scope.customerId);
  }

  const { results: settlementRows } = await db.prepare(settlementQuery).bind(...settlementParams).all();
  const settlementMap = new Map();
  for (const row of (settlementRows || [])) {
    settlementMap.set(`${row.shipment_id}::${row.recipient_user_id}`, row);
  }

  const grouped = new Map();
  for (const line of (lineRows || [])) {
    const key = `${line.shipment_id}::${line.recipient_user_id}`;
    if (!grouped.has(key)) {
      grouped.set(key, { base: line, lines: [] });
    }
    grouped.get(key).lines.push(line);
  }

  // Ensure settled rows always appear even if underlying PO lines were modified later
  for (const [key, sRow] of settlementMap.entries()) {
    if (!grouped.has(key)) {
      grouped.set(key, { base: sRow, lines: [] });
    }
  }

  const items = [];
  for (const [key, entry] of grouped.entries()) {
    const settlement = settlementMap.get(key);
    const base = entry.base;
    const plannedQtyMt = round3(entry.lines.reduce((acc, l) => acc + Number(l.planned_qty_mt || 0), 0));

    if (settlement) {
      items.push({
        settlement_id: settlement.settlement_id,
        shipment_id: settlement.shipment_id,
        di_id: settlement.di_id,
        di_no: settlement.di_no,
        po_id: settlement.po_id,
        po_revision_id: settlement.po_revision_id,
        customer_po_no: settlement.customer_po_no || null,
    po_currency: settlement.po_currency || 'USD',
        customer_id: settlement.customer_id,
        customer_code: settlement.customer_code || null,
        customer_name: settlement.customer_name,
        recipient_user_id: settlement.recipient_user_id,
        recipient_name: settlement.recipient_name,
        final_invoice_nos: settlement.final_invoice_nos || null,
        planned_qty_mt: plannedQtyMt || round3(settlement.actual_mt_snapshot),
        actual_shipped_mt: round3(settlement.actual_mt_snapshot),
        rate_usd_mt: round4(settlement.rate_snapshot_usd_mt),
        commission_amount_usd: round2(settlement.amount_usd_snapshot),
        currency: settlement.currency || 'USD',
        payment_status: settlement.payment_status,
        shipment_status: settlement.shipment_status,
        etd: settlement.etd || null,
        actual_loading_date: settlement.actual_loading_date || null,
        status: 'PAID',
        paid_date: settlement.paid_date,
        payment_reference: settlement.payment_reference || null,
        note: settlement.note || null,
        settled_by: settlement.settled_by,
        settled_by_name: settlement.settled_by_name || null,
        settled_at: settlement.settled_at,
        line_breakdown: safeParseJsonArray(settlement.line_breakdown_json),
        created_at: settlement.created_at
      });
    } else {
      const breakdown = entry.lines.map((l) => {
        const actualMt = round3(l.actual_mt);
        const rate = round4(l.commission_rate_usd_mt);
        return {
          po_revision_line_id: l.po_revision_line_id,
          product_code: l.product_code,
          product_name: l.product_name,
          planned_qty_mt: round3(l.planned_qty_mt),
          actual_mt: actualMt,
          rate_usd_mt: rate,
          amount_usd: round2(actualMt * rate)
        };
      });
      const actualShippedMt = round3(breakdown.reduce((acc, l) => acc + l.actual_mt, 0));
      const commissionAmountUsd = round2(breakdown.reduce((acc, l) => acc + l.amount_usd, 0));
      const weightedPlannedUsd = breakdown.reduce((acc, l) => acc + (l.planned_qty_mt * l.rate_usd_mt), 0);
      const effectiveRate = actualShippedMt > 0
        ? round4(commissionAmountUsd / actualShippedMt)
        : (plannedQtyMt > 0 ? round4(weightedPlannedUsd / plannedQtyMt) : round4(breakdown[0]?.rate_usd_mt || 0));

      const finalInvoiceCount = Number(base.final_invoice_count || 0);
      const isPayable = actualShippedMt > 0 &&
        commissionAmountUsd > 0 &&
        finalInvoiceCount > 0 &&
        base.payment_status === 'PAID';

      items.push({
        settlement_id: null,
        shipment_id: base.shipment_id,
        di_id: base.di_id,
        di_no: base.di_no,
        po_id: base.po_id,
        po_revision_id: base.po_revision_id,
        customer_po_no: base.customer_po_no || null,
    po_currency: base.po_currency || 'USD',
        customer_id: base.customer_id,
        customer_code: base.customer_code || null,
        customer_name: base.customer_name,
        recipient_user_id: base.recipient_user_id,
        recipient_name: base.recipient_name,
        final_invoice_nos: base.final_invoice_nos || null,
        planned_qty_mt: plannedQtyMt,
        actual_shipped_mt: actualShippedMt,
        rate_usd_mt: effectiveRate,
        commission_amount_usd: commissionAmountUsd,
        currency: 'USD',
        payment_status: base.payment_status,
        shipment_status: base.shipment_status,
        etd: base.etd || null,
        actual_loading_date: base.actual_loading_date || null,
        status: isPayable ? 'PAYABLE' : 'PENDING',
        paid_date: null,
        payment_reference: null,
        note: null,
        settled_by: null,
        settled_by_name: null,
        settled_at: null,
        line_breakdown: breakdown,
        created_at: base.created_at
      });
    }
  }

  const statusRank = { PAYABLE: 1, PENDING: 2, PAID: 3 };
  items.sort((a, b) => {
    const rankDiff = (statusRank[a.status] || 9) - (statusRank[b.status] || 9);
    if (rankDiff !== 0) return rankDiff;
    const dateA = a.paid_date || a.actual_loading_date || a.etd || String(a.created_at || '').slice(0, 10);
    const dateB = b.paid_date || b.actual_loading_date || b.etd || String(b.created_at || '').slice(0, 10);
    if (dateA !== dateB) return String(dateB).localeCompare(String(dateA));
    return String(b.di_no || '').localeCompare(String(a.di_no || ''));
  });

  return items;
}

function buildSummary(items) {
  const pending = items.filter((x) => x.status === 'PENDING');
  const payable = items.filter((x) => x.status === 'PAYABLE');
  const paid = items.filter((x) => x.status === 'PAID');
  const pendingUsd = round2(pending.reduce((acc, x) => acc + x.commission_amount_usd, 0));
  const payableUsd = round2(payable.reduce((acc, x) => acc + x.commission_amount_usd, 0));
  const paidUsd = round2(paid.reduce((acc, x) => acc + x.commission_amount_usd, 0));

  return {
    total_count: items.length,
    pending_count: pending.length,
    payable_count: payable.length,
    paid_count: paid.length,
    pending_usd: pendingUsd,
    payable_usd: payableUsd,
    paid_usd: paidUsd,
    total_usd: round2(pendingUsd + payableUsd + paidUsd)
  };
}

function buildRecipientsSummary(items) {
  const map = new Map();
  for (const item of items) {
    if (!map.has(item.recipient_user_id)) {
      map.set(item.recipient_user_id, {
        user_id: item.recipient_user_id,
        full_name: item.recipient_name,
        pending_usd: 0,
        payable_usd: 0,
        paid_usd: 0,
        payable_count: 0,
        total_count: 0
      });
    }
    const r = map.get(item.recipient_user_id);
    r.total_count += 1;
    if (item.status === 'PENDING') r.pending_usd = round2(r.pending_usd + item.commission_amount_usd);
    else if (item.status === 'PAYABLE') {
      r.payable_usd = round2(r.payable_usd + item.commission_amount_usd);
      r.payable_count += 1;
    } else if (item.status === 'PAID') {
      r.paid_usd = round2(r.paid_usd + item.commission_amount_usd);
    }
  }
  return Array.from(map.values()).sort((a, b) => a.full_name.localeCompare(b.full_name));
}

export function createCommissionsRepository(db) {
  return {
    async listCommissions(options = {}) {
      const includeRecipients = options.includeRecipients !== false;
      let items = await loadAllCommissionItems(db, {
        recipientUserId: options.recipientUserId,
        customerId: options.customerId
      });

      if (options.status) {
        items = items.filter((x) => x.status === options.status);
      }
      if (options.paidDateFrom) {
        items = items.filter((x) => x.paid_date && x.paid_date >= options.paidDateFrom);
      }
      if (options.paidDateTo) {
        items = items.filter((x) => x.paid_date && x.paid_date <= options.paidDateTo);
      }
      if (options.search) {
        const needle = options.search.toLowerCase();
        items = items.filter((item) => {
          const fields = options.restrictedSearch
            ? [item.di_no, item.customer_name, item.customer_po_no, item.final_invoice_nos, item.settlement_id, item.payment_reference]
            : [item.di_no, item.customer_name, item.customer_po_no, item.final_invoice_nos, item.settlement_id, item.payment_reference, item.recipient_name, item.po_id];
          return fields.some((f) => String(f || '').toLowerCase().includes(needle));
        });
      }

      return {
        summary: buildSummary(items),
        items,
        recipients: includeRecipients ? buildRecipientsSummary(items) : []
      };
    },

    async getSettlementDetail(settlementId) {
      const settlement = await findSettlementById(db, settlementId);
      if (!settlement) return null;

      const { results: auditRows } = await db.prepare(`
        SELECT
          e.event_id,
          e.settlement_id,
          e.event_type,
          e.actor_id,
          u.full_name AS actor_name,
          e.metadata_json,
          e.created_at
        FROM commission_audit_events e
        LEFT JOIN users u ON u.user_id = e.actor_id
        WHERE e.settlement_id = ?
        ORDER BY e.created_at DESC, e.rowid DESC
      `).bind(settlementId).all();

      return {
        settlement,
        auditHistory: auditRows || []
      };
    },

    async settleCommission(dto, actorId) {
      const input = validateSettlePayload(dto);

      const priorByKey = await findSettlementByRequestKey(db, input.requestKey);
      if (priorByKey) {
        if (
          priorByKey.shipment_id !== input.shipmentId ||
          priorByKey.recipient_user_id !== input.recipientUserId ||
          priorByKey.paid_date !== input.paidDate
        ) {
          throw codedError('COMMISSION_REQUEST_KEY_CONFLICT');
        }
        return priorByKey;
      }

      const existing = await findSettlementByShipmentAndRecipient(db, input.shipmentId, input.recipientUserId);
      if (existing) {
        throw codedError('COMMISSION_ALREADY_SETTLED');
      }

      const candidates = await loadAllCommissionItems(db, {
        shipmentId: input.shipmentId,
        recipientUserId: input.recipientUserId
      });
      const candidate = candidates[0];
      if (!candidate || candidate.status !== 'PAYABLE') {
        throw codedError('COMMISSION_NOT_PAYABLE');
      }

      const settlementId = await nextSettlementId(db);
      const eventId = `CEVT-${crypto.randomUUID()}`;
      const breakdownJson = JSON.stringify(candidate.line_breakdown);

      try {
        await db.batch([
          db.prepare(`
            INSERT INTO commission_settlements (
              settlement_id, shipment_id, di_id, po_id, po_revision_id, customer_id, recipient_user_id,
              actual_mt_snapshot, rate_snapshot_usd_mt, amount_usd_snapshot, currency, line_breakdown_json,
              status, paid_date, payment_reference, note, request_key, settled_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?, 'PAID', ?, ?, ?, ?, ?)
          `).bind(
            settlementId,
            candidate.shipment_id,
            candidate.di_id,
            candidate.po_id,
            candidate.po_revision_id,
            candidate.customer_id,
            candidate.recipient_user_id,
            candidate.actual_shipped_mt,
            candidate.rate_usd_mt,
            candidate.commission_amount_usd,
            breakdownJson,
            input.paidDate,
            input.paymentReference,
            input.note,
            input.requestKey,
            actorId
          ),
          db.prepare(`
            INSERT INTO commission_audit_events (event_id, settlement_id, event_type, actor_id, metadata_json)
            VALUES (?, ?, 'COMMISSION_SETTLED', ?, ?)
          `).bind(
            eventId,
            settlementId,
            actorId,
            JSON.stringify({
              shipmentId: candidate.shipment_id,
              recipientUserId: candidate.recipient_user_id,
              actualMt: candidate.actual_shipped_mt,
              rateUsdMt: candidate.rate_usd_mt,
              amountUsd: candidate.commission_amount_usd,
              paidDate: input.paidDate,
              paymentReference: input.paymentReference
            })
          )
        ]);
      } catch (error) {
        const msg = String(error?.message || '');
        if (msg.includes('UNIQUE constraint failed: commission_settlements.request_key')) {
          const dup = await findSettlementByRequestKey(db, input.requestKey);
          if (dup) {
            if (
              dup.shipment_id !== input.shipmentId ||
              dup.recipient_user_id !== input.recipientUserId ||
              dup.paid_date !== input.paidDate
            ) {
              throw codedError('COMMISSION_REQUEST_KEY_CONFLICT');
            }
            return dup;
          }
        }
        if (msg.includes('UNIQUE constraint failed: commission_settlements.shipment_id, commission_settlements.recipient_user_id')) {
          throw codedError('COMMISSION_ALREADY_SETTLED');
        }
        throw error;
      }

      return findSettlementById(db, settlementId);
    },

    async updateSettlementMetadata(settlementId, dto, actorId) {
      const patch = validateSettlementNoteUpdate(dto);
      const existing = await findSettlementById(db, settlementId);
      if (!existing) throw codedError('COMMISSION_NOT_FOUND');

      const nextRef = patch.hasPaymentReference ? patch.paymentReference : existing.payment_reference;
      const nextNote = patch.hasNote ? patch.note : existing.note;
      const eventId = `CEVT-${crypto.randomUUID()}`;

      await db.batch([
        db.prepare(`
          UPDATE commission_settlements
          SET payment_reference = ?, note = ?
          WHERE settlement_id = ?
        `).bind(nextRef, nextNote, settlementId),
        db.prepare(`
          INSERT INTO commission_audit_events (event_id, settlement_id, event_type, actor_id, metadata_json)
          VALUES (?, ?, 'COMMISSION_NOTE_UPDATED', ?, ?)
        `).bind(
          eventId,
          settlementId,
          actorId,
          JSON.stringify({ paymentReference: nextRef, note: nextNote })
        )
      ]);

      return findSettlementById(db, settlementId);
    }
  };
}
