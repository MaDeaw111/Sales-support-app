import { getShipmentAttachmentSummaryMap } from '../documents/repository.js';

const CURRENCY_ORDER = ['USD', 'EUR', 'THB'];

function roundMoney(value) {
  return Math.round(Number(value || 0) * 100) / 100;
}

const SHIPMENT_PAYMENT_BASE_SELECT = `
  WITH invoice_totals AS (
    SELECT
      inv.shipment_id,
      SUM(CASE WHEN inv.version = 'FINAL' THEN 1 ELSE 0 END) AS final_invoice_count,
      SUM(CASE WHEN inv.version = 'PRELIMINARY' THEN 1 ELSE 0 END) AS preliminary_invoice_count,
      ROUND(COALESCE(SUM(CASE WHEN inv.version = 'FINAL' THEN line_sum.total_amount ELSE 0 END), 0), 2) AS final_invoice_total,
      ROUND(COALESCE(SUM(CASE WHEN inv.version = 'PRELIMINARY' THEN line_sum.total_amount ELSE 0 END), 0), 2) AS preliminary_invoice_total,
      GROUP_CONCAT(CASE WHEN inv.version = 'FINAL' THEN inv.invoice_no END, ', ') AS final_invoice_nos,
      MAX(CASE WHEN inv.version = 'FINAL' THEN inv.invoice_date END) AS latest_final_invoice_date
    FROM shipment_invoices inv
    LEFT JOIN (
      SELECT invoice_id, SUM(line_amount) AS total_amount
      FROM shipment_invoice_lines
      GROUP BY invoice_id
    ) line_sum ON line_sum.invoice_id = inv.invoice_id
    GROUP BY inv.shipment_id
  ),
  credit_totals AS (
    SELECT shipment_id, ROUND(COALESCE(SUM(amount), 0), 2) AS allocated_credit_amount
    FROM customer_credit_usages
    GROUP BY shipment_id
  ),
  last_payment_audit AS (
    SELECT entity_id AS shipment_id, MAX(created_at) AS last_payment_updated_at
    FROM shipment_audit_events
    WHERE entity_type = 'SHIPMENT' AND event_type = 'PAYMENT_UPDATED'
    GROUP BY entity_id
  )
  SELECT
    s.shipment_id,
    s.di_id,
    di.di_no,
    di.po_id,
    pr.customer_po_no,
    di.customer_id,
    c.customer_code,
    c.customer_name,
    c.owner_user_id,
    pr.payment_term_snapshot,
    s.status AS shipment_status,
    di.status AS di_status,
    s.booking_no,
    s.vessel,
    s.etd,
    s.eta,
    s.planned_loading_date,
    s.actual_loading_date,
    s.payment_status,
    s.payment_note,
    s.created_at,
    s.updated_at,
    COALESCE(it.final_invoice_count, 0) AS final_invoice_count,
    COALESCE(it.preliminary_invoice_count, 0) AS preliminary_invoice_count,
    COALESCE(it.final_invoice_total, 0) AS final_invoice_total,
    COALESCE(it.preliminary_invoice_total, 0) AS preliminary_invoice_total,
    it.final_invoice_nos,
    it.latest_final_invoice_date,
    COALESCE(
      (SELECT inv.currency FROM shipment_invoices inv WHERE inv.shipment_id = s.shipment_id AND inv.version = 'FINAL' ORDER BY inv.invoice_date DESC, inv.rowid DESC LIMIT 1),
      (SELECT inv.currency FROM shipment_invoices inv WHERE inv.shipment_id = s.shipment_id AND inv.version = 'PRELIMINARY' ORDER BY inv.invoice_date DESC, inv.rowid DESC LIMIT 1),
      pr.currency
    ) AS currency,
    ROUND(COALESCE(s.cash_received_amount, 0), 2) AS cash_received_amount,
    COALESCE(ct.allocated_credit_amount, 0) AS allocated_credit_amount,
    lpa.last_payment_updated_at
  FROM phase6_shipments s
  JOIN delivery_instructions di ON di.di_id = s.di_id
  JOIN customers c ON c.customer_id = di.customer_id
  JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
  LEFT JOIN invoice_totals it ON it.shipment_id = s.shipment_id
  LEFT JOIN credit_totals ct ON ct.shipment_id = s.shipment_id
  LEFT JOIN last_payment_audit lpa ON lpa.shipment_id = s.shipment_id
  WHERE s.status <> 'CANCELLED'
    AND di.status <> 'CANCELLED'
`;

function normalizeShipmentPaymentRow(row) {
  const finalInvoiceCount = Number(row.final_invoice_count || 0);
  const preliminaryInvoiceCount = Number(row.preliminary_invoice_count || 0);
  const finalInvoiceTotal = roundMoney(row.final_invoice_total);
  const preliminaryInvoiceTotal = roundMoney(row.preliminary_invoice_total);
  const cashReceivedAmount = roundMoney(row.cash_received_amount);
  const allocatedCreditAmount = roundMoney(row.allocated_credit_amount);
  const paymentTotal = roundMoney(cashReceivedAmount + allocatedCreditAmount);
  const outstandingBalance = finalInvoiceCount > 0
    ? roundMoney(Math.max(0, finalInvoiceTotal - paymentTotal))
    : 0;
  const invoiceReadiness = finalInvoiceCount > 0
    ? 'FINALIZED'
    : preliminaryInvoiceCount > 0
      ? 'PRELIMINARY_ONLY'
      : 'NO_INVOICE';

  return {
    shipment_id: row.shipment_id,
    di_id: row.di_id,
    di_no: row.di_no,
    po_id: row.po_id,
    customer_po_no: row.customer_po_no || null,
    customer_id: row.customer_id,
    customer_code: row.customer_code || null,
    customer_name: row.customer_name,
    payment_term_snapshot: row.payment_term_snapshot || null,
    shipment_status: row.shipment_status,
    di_status: row.di_status,
    booking_no: row.booking_no || null,
    vessel: row.vessel || null,
    etd: row.etd || null,
    eta: row.eta || null,
    planned_loading_date: row.planned_loading_date || null,
    actual_loading_date: row.actual_loading_date || null,
    currency: row.currency || 'USD',
    invoice_readiness: invoiceReadiness,
    final_invoice_count: finalInvoiceCount,
    preliminary_invoice_count: preliminaryInvoiceCount,
    final_invoice_nos: row.final_invoice_nos || null,
    latest_final_invoice_date: row.latest_final_invoice_date || null,
    final_invoice_total: finalInvoiceTotal,
    preliminary_invoice_total: preliminaryInvoiceTotal,
    cash_received_amount: cashReceivedAmount,
    allocated_credit_amount: allocatedCreditAmount,
    payment_total: paymentTotal,
    outstanding_balance: outstandingBalance,
    payment_status: row.payment_status,
    payment_note: row.payment_note || null,
    last_payment_updated_at: row.last_payment_updated_at || null,
    commission_ready: row.shipment_status !== 'CANCELLED' && row.payment_status === 'PAID',
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function buildCurrencyTotals(items) {
  const map = new Map();
  for (const item of items) {
    const cur = item.currency || 'USD';
    if (!map.has(cur)) {
      map.set(cur, {
        currency: cur,
        shipment_count: 0,
        final_invoice_total: 0,
        cash_received_total: 0,
        allocated_credit_total: 0,
        payment_total: 0,
        outstanding_total: 0
      });
    }
    const bucket = map.get(cur);
    bucket.shipment_count += 1;
    bucket.final_invoice_total = roundMoney(bucket.final_invoice_total + item.final_invoice_total);
    bucket.cash_received_total = roundMoney(bucket.cash_received_total + item.cash_received_amount);
    bucket.allocated_credit_total = roundMoney(bucket.allocated_credit_total + item.allocated_credit_amount);
    bucket.payment_total = roundMoney(bucket.payment_total + item.payment_total);
    bucket.outstanding_total = roundMoney(bucket.outstanding_total + item.outstanding_balance);
  }
  return Array.from(map.values()).sort((a, b) => {
    const ia = CURRENCY_ORDER.indexOf(a.currency);
    const ib = CURRENCY_ORDER.indexOf(b.currency);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.currency.localeCompare(b.currency);
  });
}

export function createPaymentsRepository(db) {
  return {
    async listPaymentsDashboard(options = {}) {
      const includeCustomerCredits = options.includeCustomerCredits !== false;
      let query = SHIPMENT_PAYMENT_BASE_SELECT;
      const params = [];

      if (options.ownedByUserId) {
        query += " AND c.owner_user_id = ? AND c.ownership_type = 'ASSIGNED_SALES'";
        params.push(options.ownedByUserId);
      }
      if (options.customerId) {
        query += ' AND di.customer_id = ?';
        params.push(options.customerId);
      }
      if (options.paymentStatus) {
        query += ' AND s.payment_status = ?';
        params.push(options.paymentStatus);
      }
      if (options.shipmentStatus) {
        query += ' AND s.status = ?';
        params.push(options.shipmentStatus);
      }

      query += `
        ORDER BY
          CASE s.payment_status WHEN 'PARTIAL' THEN 1 WHEN 'UNPAID' THEN 2 ELSE 3 END ASC,
          COALESCE(it.latest_final_invoice_date, s.etd, substr(s.created_at, 1, 10)) DESC,
          di.di_no DESC
      `;

      const { results } = await db.prepare(query).bind(...params).all();
      let items = (results || []).map(normalizeShipmentPaymentRow);
      const docSummaryMap = await getShipmentAttachmentSummaryMap(db, items.map((x) => x.shipment_id));
      if (docSummaryMap.size > 0) {
        items = items.map((item) => {
          const docs = docSummaryMap.get(item.shipment_id);
          if (!docs) return item;
          return {
            ...item,
            all_ship_doc_uploaded_at: docs.all_ship_doc_uploaded_at || null,
            payment_slip_count: Number(docs.payment_slip_count || 0)
          };
        });
      }

      if (options.invoiceReadiness) {
        items = items.filter((item) => item.invoice_readiness === options.invoiceReadiness);
      }
      if (options.currency) {
        items = items.filter((item) => item.currency === options.currency);
      }
      if (options.search) {
        const needle = options.search.toLowerCase();
        items = items.filter((item) => {
          const fields = options.restrictedSearch
            ? [item.di_no, item.customer_name, item.customer_po_no, item.final_invoice_nos]
            : [item.di_no, item.customer_name, item.customer_po_no, item.final_invoice_nos, item.booking_no, item.vessel, item.payment_note];
          return fields.some((field) => String(field || '').toLowerCase().includes(needle));
        });
      }

      const summary = {
        total_shipments: items.length,
        paid_count: items.filter((x) => x.payment_status === 'PAID').length,
        partial_count: items.filter((x) => x.payment_status === 'PARTIAL').length,
        unpaid_count: items.filter((x) => x.payment_status === 'UNPAID').length,
        final_invoiced_count: items.filter((x) => x.invoice_readiness === 'FINALIZED').length,
        awaiting_final_invoice_count: items.filter((x) => x.invoice_readiness !== 'FINALIZED').length,
        totals_by_currency: buildCurrencyTotals(items)
      };

      let customerCredits = [];
      if (includeCustomerCredits) {
        let creditQuery = `
          SELECT
            cc.credit_id,
            cc.customer_id,
            c.customer_code,
            c.customer_name,
            cc.amount,
            cc.remaining_amount,
            cc.reason,
            cc.created_by,
            cc.created_at,
            COALESCE((SELECT COUNT(*) FROM customer_credit_usages u WHERE u.credit_id = cc.credit_id), 0) AS usage_count
          FROM customer_credits cc
          JOIN customers c ON c.customer_id = cc.customer_id
          WHERE 1 = 1
        `;
        const creditParams = [];
        if (options.customerId) {
          creditQuery += ' AND cc.customer_id = ?';
          creditParams.push(options.customerId);
        }
        creditQuery += ' ORDER BY CASE WHEN cc.remaining_amount > 0 THEN 0 ELSE 1 END ASC, cc.created_at DESC, cc.rowid DESC';
        const { results: creditRows } = await db.prepare(creditQuery).bind(...creditParams).all();
        customerCredits = (creditRows || []).map((row) => {
          const amount = roundMoney(row.amount);
          const remaining = roundMoney(row.remaining_amount);
          return {
            credit_id: row.credit_id,
            customer_id: row.customer_id,
            customer_code: row.customer_code || null,
            customer_name: row.customer_name,
            amount,
            remaining_amount: remaining,
            used_amount: roundMoney(Math.max(0, amount - remaining)),
            usage_count: Number(row.usage_count || 0),
            reason: row.reason,
            created_by: row.created_by,
            created_at: row.created_at
          };
        });
        summary.customer_credits_summary = {
          total_credits: customerCredits.length,
          active_credits_count: customerCredits.filter((c) => c.remaining_amount > 0).length,
          total_remaining_amount: roundMoney(customerCredits.reduce((acc, c) => acc + c.remaining_amount, 0))
        };
      }

      return { summary, items, customerCredits };
    },

    async getShipmentPaymentDetail(shipmentId) {
      const row = await db.prepare(`
        ${SHIPMENT_PAYMENT_BASE_SELECT}
        AND s.shipment_id = ?
        LIMIT 1
      `).bind(shipmentId).first();
      if (!row) return null;

      const shipment = normalizeShipmentPaymentRow(row);
      const detailDocMap = await getShipmentAttachmentSummaryMap(db, [shipment.shipment_id]);
      const detailDocs = detailDocMap.get(shipment.shipment_id);
      if (detailDocs) {
        shipment.all_ship_doc_uploaded_at = detailDocs.all_ship_doc_uploaded_at || null;
        shipment.payment_slip_count = Number(detailDocs.payment_slip_count || 0);
      }

      const { results: invoiceRows } = await db.prepare(`
        SELECT
          inv.invoice_id,
          inv.shipment_id,
          inv.invoice_no,
          inv.invoice_date,
          inv.currency,
          inv.version,
          inv.created_at,
          inv.updated_at,
          ROUND(COALESCE(SUM(l.line_amount), 0), 2) AS invoice_total,
          ROUND(COALESCE(SUM(l.qty_mt), 0), 3) AS total_qty_mt
        FROM shipment_invoices inv
        LEFT JOIN shipment_invoice_lines l ON l.invoice_id = inv.invoice_id
        WHERE inv.shipment_id = ?
        GROUP BY inv.invoice_id
        ORDER BY CASE inv.version WHEN 'FINAL' THEN 1 ELSE 2 END ASC, inv.invoice_date DESC, inv.created_at DESC
      `).bind(shipmentId).all();

      const { results: creditUsageRows } = await db.prepare(`
        SELECT
          u.credit_usage_id,
          u.credit_id,
          u.shipment_id,
          u.invoice_id,
          inv.invoice_no,
          u.amount,
          cc.reason,
          u.actor_id,
          u.created_at
        FROM customer_credit_usages u
        JOIN customer_credits cc ON cc.credit_id = u.credit_id
        LEFT JOIN shipment_invoices inv ON inv.invoice_id = u.invoice_id
        WHERE u.shipment_id = ?
        ORDER BY u.created_at DESC, u.rowid DESC
      `).bind(shipmentId).all();

      const { results: availableCreditRows } = await db.prepare(`
        SELECT credit_id, customer_id, amount, remaining_amount, reason, created_at
        FROM customer_credits
        WHERE customer_id = ? AND remaining_amount > 0
        ORDER BY created_at DESC, rowid DESC
      `).bind(shipment.customer_id).all();

      const { results: historyRows } = await db.prepare(`
        SELECT
          e.event_id,
          e.entity_type,
          e.entity_id,
          e.event_type,
          e.actor_id,
          u.full_name AS actor_name,
          e.metadata_json,
          e.created_at
        FROM shipment_audit_events e
        LEFT JOIN users u ON u.user_id = e.actor_id
        WHERE e.entity_type = 'SHIPMENT'
          AND e.entity_id = ?
          AND e.event_type IN ('PAYMENT_UPDATED', 'INVOICE_RECORDED', 'INVOICE_FINALIZED', 'CUSTOMER_CREDIT_USED', 'SHIPMENT_COMPLETED')
        ORDER BY e.created_at DESC, e.rowid DESC
      `).bind(shipmentId).all();

      return {
        shipment,
        invoices: (invoiceRows || []).map((inv) => ({
          ...inv,
          invoice_total: roundMoney(inv.invoice_total),
          total_qty_mt: Number(inv.total_qty_mt || 0)
        })),
        creditUsages: (creditUsageRows || []).map((u) => ({
          ...u,
          amount: roundMoney(u.amount)
        })),
        availableCustomerCredits: (availableCreditRows || []).map((c) => ({
          ...c,
          amount: roundMoney(c.amount),
          remaining_amount: roundMoney(c.remaining_amount)
        })),
        paymentHistory: historyRows || []
      };
    }
  };
}
