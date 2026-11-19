import { createPaymentsRepository } from '../payments/repository.js';
import { createCommissionsRepository } from '../commissions/repository.js';

function addDaysIso(baseIso, days) {
  const d = new Date(`${baseIso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function round3(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function addMonthsIso(monthPrefix, deltaMonths) {
  const [yearStr, monthStr] = String(monthPrefix).split('-');
  const d = new Date(Date.UTC(Number(yearStr), Number(monthStr) - 1 + deltaMonths, 1));
  return d.toISOString().slice(0, 7);
}

function parseContainerPlanCount(plan) {
  const text = String(plan || '').trim();
  if (!text) return 0;
  const matches = [...text.matchAll(/(\d+)\s*[x×]/gi)];
  if (matches.length > 0) {
    return matches.reduce((sum, m) => sum + Number(m[1] || 0), 0);
  }
  if (/^\d+$/.test(text)) return Number(text);
  return 0;
}

function summarizeMonthRows(month, rows) {
  let shippedMt = 0;
  let shippedContainers = 0;
  let shippedCount = 0;
  let remainingMt = 0;
  let remainingContainers = 0;
  let remainingCount = 0;

  for (const row of rows) {
    const effectiveMonth = row.actual_loading_date
      ? String(row.actual_loading_date).slice(0, 7)
      : row.planned_loading_date
        ? String(row.planned_loading_date).slice(0, 7)
        : String(row.shipping_month || '').slice(0, 7);
    if (effectiveMonth !== month) continue;

    const isShipped = Boolean(
      row.actual_loading_date || ['LOADED', 'DOCS_SENT', 'COMPLETED'].includes(row.shipment_status)
    );
    const plannedMt = Number(row.planned_qty_mt || 0);
    const actualMt = Number(row.actual_qty_mt || 0);
    const actualCnt = Number(row.actual_container_count || 0);
    const plannedCnt = parseContainerPlanCount(row.container_plan);

    if (isShipped) {
      shippedMt += actualMt > 0 ? actualMt : plannedMt;
      shippedContainers += actualCnt > 0 ? actualCnt : plannedCnt;
      shippedCount += 1;
    } else {
      remainingMt += plannedMt;
      remainingContainers += plannedCnt > 0 ? plannedCnt : actualCnt;
      remainingCount += 1;
    }
  }

  const roundedShippedMt = round3(shippedMt);
  const roundedRemainingMt = round3(remainingMt);
  return {
    month,
    total_mt: round3(roundedShippedMt + roundedRemainingMt),
    total_containers: shippedContainers + remainingContainers,
    shipment_count: shippedCount + remainingCount,
    shipped_mt: roundedShippedMt,
    shipped_containers: shippedContainers,
    shipped_count: shippedCount,
    remaining_mt: roundedRemainingMt,
    remaining_containers: remainingContainers,
    remaining_count: remainingCount
  };
}

async function buildTeamOverview(db, todayIso) {
  const currentMonth = todayIso.slice(0, 7);
  const nextMonth = addMonthsIso(currentMonth, 1);

  const [activePoCountRow, productRows, shippedByProductRows, monthlyShipmentRows] = await Promise.all([
    db.prepare(`
      SELECT COUNT(*) AS active_po_count
      FROM po_headers
      WHERE header_status IN ('OPEN', 'PARTIALLY_SHIPPED')
        AND current_active_revision_id IS NOT NULL
    `).first(),
    db.prepare(`
      SELECT
        prl.product_id,
        p.product_code,
        p.product_name,
        p.short_name,
        COUNT(DISTINCT ph.po_id) AS po_count,
        ROUND(COALESCE(SUM(prl.contract_qty_mt), 0), 3) AS contract_qty_mt
      FROM po_headers ph
      JOIN po_revisions pr ON pr.revision_id = ph.current_active_revision_id
      JOIN po_revision_lines prl ON prl.po_revision_id = pr.revision_id
      JOIN products p ON p.product_id = prl.product_id
      WHERE ph.header_status IN ('OPEN', 'PARTIALLY_SHIPPED')
        AND ph.current_active_revision_id IS NOT NULL
      GROUP BY prl.product_id, p.product_code, p.product_name, p.short_name
      ORDER BY contract_qty_mt DESC, p.product_code ASC
    `).all(),
    db.prepare(`
      SELECT
        dil.product_id,
        ROUND(COALESCE(SUM(scl.qty_mt), 0), 3) AS actual_shipped_mt
      FROM shipment_container_lines scl
      JOIN shipment_containers sc ON sc.container_id = scl.container_id
      JOIN phase6_shipments s ON s.shipment_id = sc.shipment_id
      JOIN delivery_instructions di ON di.di_id = s.di_id
      JOIN delivery_instruction_lines dil ON dil.di_line_id = scl.delivery_instruction_line_id
      JOIN po_headers ph ON ph.po_id = dil.po_id
      WHERE ph.header_status IN ('OPEN', 'PARTIALLY_SHIPPED')
        AND ph.current_active_revision_id IS NOT NULL
        AND sc.status <> 'CANCELLED'
        AND s.status <> 'CANCELLED'
        AND di.status <> 'CANCELLED'
      GROUP BY dil.product_id
    `).all(),
    db.prepare(`
      SELECT
        di.di_id,
        di.shipping_month,
        di.container_plan,
        di.status AS di_status,
        s.shipment_id,
        s.status AS shipment_status,
        s.planned_loading_date,
        s.actual_loading_date,
        ROUND(COALESCE((
          SELECT SUM(dil.planned_qty_mt)
          FROM delivery_instruction_lines dil
          WHERE dil.di_id = di.di_id
        ), 0), 3) AS planned_qty_mt,
        ROUND(COALESCE((
          SELECT SUM(scl.qty_mt)
          FROM shipment_containers sc
          JOIN shipment_container_lines scl ON scl.container_id = sc.container_id
          WHERE sc.shipment_id = s.shipment_id
            AND sc.status <> 'CANCELLED'
        ), 0), 3) AS actual_qty_mt,
        COALESCE((
          SELECT COUNT(*)
          FROM shipment_containers sc
          WHERE sc.shipment_id = s.shipment_id
            AND sc.status <> 'CANCELLED'
        ), 0) AS actual_container_count
      FROM delivery_instructions di
      LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
      WHERE di.status <> 'CANCELLED'
        AND (s.shipment_id IS NULL OR s.status <> 'CANCELLED')
    `).all()
  ]);

  const shippedByProduct = new Map();
  let totalActualShipped = 0;
  for (const r of shippedByProductRows.results || []) {
    const qty = round3(r.actual_shipped_mt || 0);
    shippedByProduct.set(r.product_id, qty);
    totalActualShipped += qty;
  }
  totalActualShipped = round3(totalActualShipped);

  let totalContractMt = 0;
  const productBreakdown = (productRows.results || []).map((r) => {
    const contractQty = round3(r.contract_qty_mt || 0);
    const shippedQty = shippedByProduct.get(r.product_id) || 0;
    const remainingQty = Math.max(0, round3(contractQty - shippedQty));
    totalContractMt += contractQty;
    return {
      product_id: r.product_id,
      product_code: r.product_code,
      product_name: r.product_name,
      short_name: r.short_name || r.product_code,
      po_count: Number(r.po_count || 0),
      contract_qty_mt: contractQty,
      shipped_qty_mt: shippedQty,
      remaining_qty_mt: remainingQty
    };
  });
  totalContractMt = round3(totalContractMt);

  const remainingContractMt = Math.max(0, round3(totalContractMt - totalActualShipped));
  const shippedPct = totalContractMt > 0
    ? Math.min(100, Math.round((totalActualShipped / totalContractMt) * 1000) / 10)
    : 0;

  const shipmentRows = monthlyShipmentRows.results || [];
  const thisMonth = summarizeMonthRows(currentMonth, shipmentRows);
  const nextBucket = summarizeMonthRows(nextMonth, shipmentRows);

  return {
    active_pos: {
      active_po_count: Number(activePoCountRow?.active_po_count || 0),
      total_contract_mt: totalContractMt,
      product_breakdown: productBreakdown
    },
    fulfillment: {
      total_contract_mt: totalContractMt,
      actual_shipped_mt: totalActualShipped,
      remaining_contract_mt: remainingContractMt,
      shipped_pct: shippedPct
    },
    this_month: thisMonth,
    next_month: {
      month: nextBucket.month,
      planned_mt: nextBucket.total_mt,
      planned_containers: nextBucket.total_containers,
      shipment_count: nextBucket.shipment_count,
      shipped_mt: nextBucket.shipped_mt,
      shipped_containers: nextBucket.shipped_containers,
      shipped_count: nextBucket.shipped_count,
      remaining_mt: nextBucket.remaining_mt,
      remaining_containers: nextBucket.remaining_containers,
      remaining_count: nextBucket.remaining_count
    }
  };
}

async function listUpcomingMilestones(db, todayIso, windowDays, options = {}) {
  const endIso = addDaysIso(todayIso, windowDays);
  let query = `
    SELECT
      s.shipment_id,
      s.di_id,
      di.di_no,
      c.customer_name,
      s.status AS shipment_status,
      s.booking_no,
      s.vessel,
      s.planned_loading_date,
      s.actual_loading_date,
      s.etd,
      s.payment_status,
      di.container_plan
    FROM phase6_shipments s
    JOIN delivery_instructions di ON di.di_id = s.di_id
    JOIN customers c ON c.customer_id = di.customer_id
    WHERE s.status <> 'CANCELLED'
      AND di.status <> 'CANCELLED'
      AND (
        (s.planned_loading_date >= ? AND s.planned_loading_date <= ?)
        OR (s.etd >= ? AND s.etd <= ?)
      )
  `;
  const params = [todayIso, endIso, todayIso, endIso];
  if (options.ownedByUserId) {
    query += ' AND c.owner_user_id = ?';
    params.push(options.ownedByUserId);
  }
  query += ' ORDER BY COALESCE(s.planned_loading_date, s.etd) ASC, di.di_no ASC LIMIT 12';
  const { results } = await db.prepare(query).bind(...params).all();
  return results || [];
}

export function createDashboardRepository(db) {
  const paymentsRepo = createPaymentsRepository(db);
  const commissionsRepo = createCommissionsRepository(db);

  return {
    async getDashboardForCaller(caller, now = new Date()) {
      const todayIso = (now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()).toISOString().slice(0, 10);
      const monthPrefix = todayIso.slice(0, 7);
      const role = caller.role;

      if (role === 'ADMIN') {
        const [
          teamOverview,
          userCounts,
          roleRows,
          customerCounts,
          productCounts,
          partnerCounts,
          poCounts,
          missingOwnerRow,
          partnerNoContactRow,
          payments,
          commissions
        ] = await Promise.all([
          buildTeamOverview(db, todayIso),
          db.prepare(`
            SELECT
              SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_users,
              SUM(CASE WHEN status <> 'ACTIVE' THEN 1 ELSE 0 END) AS inactive_users
            FROM users
          `).first(),
          db.prepare(`
            SELECT role,
                   COUNT(*) AS total_count,
                   SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_count
            FROM users
            GROUP BY role
            ORDER BY role ASC
          `).all(),
          db.prepare(`
            SELECT COUNT(*) AS total_customers,
                   SUM(CASE WHEN status = 'ACTIVE_CUSTOMER' THEN 1 ELSE 0 END) AS active_customers
            FROM customers
          `).first(),
          db.prepare(`
            SELECT COUNT(*) AS total_products,
                   SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_products
            FROM products
          `).first(),
          db.prepare(`
            SELECT COUNT(*) AS total_partners,
                   SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) AS active_partners
            FROM service_partners
          `).first(),
          db.prepare(`
            SELECT SUM(CASE WHEN header_status IN ('OPEN', 'PARTIALLY_SHIPPED') THEN 1 ELSE 0 END) AS open_pos
            FROM po_headers
          `).first(),
          db.prepare(`
            SELECT COUNT(*) AS n
            FROM customers c
            LEFT JOIN users u ON u.user_id = c.owner_user_id
            WHERE c.ownership_type = 'ASSIGNED_SALES'
              AND (c.owner_user_id IS NULL OR u.user_id IS NULL OR u.status <> 'ACTIVE')
          `).first(),
          db.prepare(`
            SELECT COUNT(*) AS n
            FROM service_partners
            WHERE status = 'ACTIVE'
              AND COALESCE(TRIM(contact_name), '') = ''
              AND COALESCE(TRIM(contact_phone), '') = ''
              AND COALESCE(TRIM(contact_email), '') = ''
          `).first(),
          paymentsRepo.listPaymentsDashboard(),
          commissionsRepo.listCommissions()
        ]);

        const unpaidCount = Number(payments.summary.unpaid_count || 0) + Number(payments.summary.partial_count || 0);
        const awaitingFinalInv = Number(payments.summary.awaiting_final_invoice_count || 0);
        const payableCommissions = Number(commissions.summary.payable_count || 0);

        return {
          role: 'ADMIN',
          as_of_date: todayIso,
          team_overview: teamOverview,
          kpis: {
            active_users: Number(userCounts?.active_users || 0),
            inactive_users: Number(userCounts?.inactive_users || 0),
            customers_count: Number(customerCounts?.total_customers || 0),
            active_customers_count: Number(customerCounts?.active_customers || 0),
            total_products: Number(productCounts?.total_products || 0),
            active_products: Number(productCounts?.active_products || 0),
            total_logistics_partners: Number(partnerCounts?.total_partners || 0),
            active_logistics_partners: Number(partnerCounts?.active_partners || 0),
            open_pos: Number(poCounts?.open_pos || 0),
            payable_commissions_count: payableCommissions
          },
          role_breakdown: (roleRows.results || []).map((r) => ({
            role: r.role,
            total_count: Number(r.total_count || 0),
            active_count: Number(r.active_count || 0)
          })),
          health: [
            { key: 'CUSTOMER_OWNER', label: 'Assigned Customers without Active Owner', count: Number(missingOwnerRow?.n || 0), view: 'customers' },
            { key: 'PARTNER_CONTACT', label: 'Active Logistics Partners without Contact Info', count: Number(partnerNoContactRow?.n || 0), view: 'logistics_partners' },
            { key: 'AWAITING_FINAL_INVOICE', label: 'Active Shipments Awaiting Final Invoice', count: awaitingFinalInv, view: 'payments' },
            { key: 'UNPAID_SHIPMENTS', label: 'Shipments Pending Payment Follow-up', count: unpaidCount, view: 'payments' },
            { key: 'PAYABLE_COMMISSIONS', label: 'Payable Commissions Awaiting Settlement', count: payableCommissions, view: 'commissions' }
          ]
        };
      }

      if (role === 'MANAGER') {
        const [teamOverview, customerCounts, poStats, shipmentCounts, payments, commissions, upcoming] = await Promise.all([
          buildTeamOverview(db, todayIso),
          db.prepare(`
            SELECT COUNT(*) AS total_customers,
                   SUM(CASE WHEN status = 'ACTIVE_CUSTOMER' THEN 1 ELSE 0 END) AS active_customers
            FROM customers
          `).first(),
          db.prepare(`
            SELECT
              COUNT(DISTINCT ph.po_id) AS open_pos_count,
              ROUND(COALESCE(SUM(prl.contract_qty_mt), 0), 3) AS active_contract_mt
            FROM po_headers ph
            JOIN po_revisions pr ON pr.revision_id = ph.current_active_revision_id
            LEFT JOIN po_revision_lines prl ON prl.po_revision_id = pr.revision_id
            WHERE ph.header_status IN ('OPEN', 'PARTIALLY_SHIPPED')
          `).first(),
          db.prepare(`
            SELECT
              SUM(CASE WHEN status NOT IN ('COMPLETED', 'CANCELLED') THEN 1 ELSE 0 END) AS active_shipments_count,
              SUM(CASE WHEN status = 'COMPLETED' THEN 1 ELSE 0 END) AS completed_shipments_count
            FROM phase6_shipments
          `).first(),
          paymentsRepo.listPaymentsDashboard(),
          commissionsRepo.listCommissions(),
          listUpcomingMilestones(db, todayIso, 14)
        ]);

        const outstandingItems = payments.items
          .filter((x) => x.invoice_readiness === 'FINALIZED' && x.outstanding_balance > 0)
          .slice(0, 8)
          .map((x) => ({
            shipment_id: x.shipment_id,
            di_id: x.di_id,
            di_no: x.di_no,
            customer_name: x.customer_name,
            currency: x.currency,
            final_invoice_total: x.final_invoice_total,
            payment_total: x.payment_total,
            outstanding_balance: x.outstanding_balance,
            payment_status: x.payment_status
          }));

        return {
          role: 'MANAGER',
          as_of_date: todayIso,
          team_overview: teamOverview,
          kpis: {
            active_customers_count: Number(customerCounts?.active_customers || 0),
            total_customers_count: Number(customerCounts?.total_customers || 0),
            open_pos_count: Number(poStats?.open_pos_count || 0),
            active_contract_mt: round3(poStats?.active_contract_mt || 0),
            active_shipments_count: Number(shipmentCounts?.active_shipments_count || 0),
            completed_shipments_count: Number(shipmentCounts?.completed_shipments_count || 0)
          },
          payments_summary: payments.summary,
          commissions_summary: commissions.summary,
          outstanding_payments: outstandingItems,
          upcoming_milestones: upcoming
        };
      }

      if (role === 'SALES_SUPPORT') {
        const [teamOverview, customerCounts, poCounts, diCounts, payments, upcoming] = await Promise.all([
          buildTeamOverview(db, todayIso),
          db.prepare(`
            SELECT COUNT(*) AS total_customers,
                   SUM(CASE WHEN status = 'ACTIVE_CUSTOMER' THEN 1 ELSE 0 END) AS active_customers
            FROM customers
          `).first(),
          db.prepare(`
            SELECT
              SUM(CASE WHEN header_status IN ('OPEN', 'PARTIALLY_SHIPPED') THEN 1 ELSE 0 END) AS open_pos_count,
              SUM(CASE WHEN current_draft_revision_id IS NOT NULL THEN 1 ELSE 0 END) AS draft_pos_count
            FROM po_headers
            WHERE header_status <> 'CANCELLED'
          `).first(),
          db.prepare(`
            SELECT
              SUM(CASE WHEN di.status NOT IN ('COMPLETED', 'CANCELLED') THEN 1 ELSE 0 END) AS active_dis_count,
              SUM(CASE WHEN di.status NOT IN ('COMPLETED', 'CANCELLED') AND (s.shipment_id IS NULL OR COALESCE(TRIM(s.booking_no), '') = '') THEN 1 ELSE 0 END) AS booking_pending_count
            FROM delivery_instructions di
            LEFT JOIN phase6_shipments s ON s.di_id = di.di_id
          `).first(),
          paymentsRepo.listPaymentsDashboard(),
          listUpcomingMilestones(db, todayIso, 14)
        ]);

        const paymentFollowupCount = Number(payments.summary.unpaid_count || 0) + Number(payments.summary.partial_count || 0);

        return {
          role: 'SALES_SUPPORT',
          as_of_date: todayIso,
          team_overview: teamOverview,
          kpis: {
            active_customers_count: Number(customerCounts?.active_customers || 0),
            open_pos_count: Number(poCounts?.open_pos_count || 0),
            draft_pos_count: Number(poCounts?.draft_pos_count || 0),
            active_dis_count: Number(diCounts?.active_dis_count || 0),
            booking_pending_count: Number(diCounts?.booking_pending_count || 0),
            payment_followup_count: paymentFollowupCount
          },
          payments_summary: payments.summary,
          upcoming_milestones: upcoming
        };
      }

      if (role === 'EXTERNAL_SALES') {
        const [customerCounts, poCounts, payments, commissions, upcoming] = await Promise.all([
          db.prepare(`
            SELECT COUNT(*) AS my_customers_count,
                   SUM(CASE WHEN status = 'ACTIVE_CUSTOMER' THEN 1 ELSE 0 END) AS my_active_customers_count
            FROM customers
            WHERE owner_user_id = ?
          `).bind(caller.user_id).first(),
          db.prepare(`
            SELECT COUNT(*) AS my_open_pos_count
            FROM po_headers ph
            JOIN customers c ON c.customer_id = ph.customer_id
            WHERE c.owner_user_id = ?
              AND ph.header_status IN ('OPEN', 'PARTIALLY_SHIPPED')
              AND ph.current_active_revision_id IS NOT NULL
          `).bind(caller.user_id).first(),
          paymentsRepo.listPaymentsDashboard({
            ownedByUserId: caller.user_id,
            restrictedSearch: true,
            includeCustomerCredits: false
          }),
          commissionsRepo.listCommissions({
            recipientUserId: caller.user_id,
            restrictedSearch: true,
            includeRecipients: false
          }),
          listUpcomingMilestones(db, todayIso, 14, { ownedByUserId: caller.user_id })
        ]);

        const unpaidCount = Number(payments.summary.unpaid_count || 0) + Number(payments.summary.partial_count || 0);

        return {
          role: 'EXTERNAL_SALES',
          as_of_date: todayIso,
          kpis: {
            my_customers_count: Number(customerCounts?.my_customers_count || 0),
            my_active_customers_count: Number(customerCounts?.my_active_customers_count || 0),
            my_open_pos_count: Number(poCounts?.my_open_pos_count || 0),
            my_active_shipments_count: Number(payments.summary.total_shipments || 0),
            my_unpaid_shipments_count: unpaidCount,
            my_commission_pending_usd: commissions.summary.pending_usd,
            my_commission_payable_usd: commissions.summary.payable_usd,
            my_commission_paid_usd: commissions.summary.paid_usd
          },
          recent_shipments: payments.items.slice(0, 10).map((item) => ({
            di_no: item.di_no,
            customer_name: item.customer_name,
            customer_po_no: item.customer_po_no,
            currency: item.currency,
            shipment_status: item.shipment_status,
            etd: item.etd,
            final_invoice_total: item.final_invoice_total,
            payment_total: item.payment_total,
            outstanding_balance: item.outstanding_balance,
            payment_status: item.payment_status,
            commission_ready: item.commission_ready
          })),
          upcoming_milestones: upcoming.map((m) => ({
            di_no: m.di_no,
            customer_name: m.customer_name,
            shipment_status: m.shipment_status,
            planned_loading_date: m.planned_loading_date,
            actual_loading_date: m.actual_loading_date,
            etd: m.etd
          }))
        };
      }

      if (role === 'EXPORT') {
        const [teamOverview, shipStats, partnerCount, payments, upcoming] = await Promise.all([
          buildTeamOverview(db, todayIso),
          db.prepare(`
            SELECT
              SUM(CASE WHEN planned_loading_date = ? OR actual_loading_date = ? THEN 1 ELSE 0 END) AS loading_today_count,
              SUM(CASE WHEN status = 'PLANNING' OR COALESCE(TRIM(booking_no), '') = '' THEN 1 ELSE 0 END) AS booking_pending_count,
              SUM(CASE WHEN status = 'BOOKED' THEN 1 ELSE 0 END) AS awaiting_loading_count,
              SUM(CASE WHEN status = 'LOADED' OR (status IN ('LOADED', 'DOCS_SENT') AND digital_docs_sent_date IS NULL) THEN 1 ELSE 0 END) AS docs_pending_count
            FROM phase6_shipments
            WHERE status <> 'CANCELLED'
          `).bind(todayIso, todayIso).first(),
          db.prepare(`
            SELECT COUNT(*) AS n
            FROM service_partners
            WHERE status = 'ACTIVE'
          `).first(),
          paymentsRepo.listPaymentsDashboard(),
          listUpcomingMilestones(db, todayIso, 14)
        ]);

        const paymentFollowupCount = Number(payments.summary.unpaid_count || 0) + Number(payments.summary.partial_count || 0);

        return {
          role: 'EXPORT',
          as_of_date: todayIso,
          team_overview: teamOverview,
          kpis: {
            loading_today_count: Number(shipStats?.loading_today_count || 0),
            booking_pending_count: Number(shipStats?.booking_pending_count || 0),
            awaiting_loading_count: Number(shipStats?.awaiting_loading_count || 0),
            docs_pending_count: Number(shipStats?.docs_pending_count || 0),
            awaiting_final_invoice_count: Number(payments.summary.awaiting_final_invoice_count || 0),
            payment_followup_count: paymentFollowupCount,
            active_logistics_partners_count: Number(partnerCount?.n || 0)
          },
          upcoming_milestones: upcoming,
          readiness_queue: payments.items
            .filter((x) => x.shipment_status !== 'COMPLETED')
            .slice(0, 10)
            .map((x) => ({
              shipment_id: x.shipment_id,
              di_id: x.di_id,
              di_no: x.di_no,
              customer_name: x.customer_name,
              booking_no: x.booking_no,
              etd: x.etd,
              planned_loading_date: x.planned_loading_date,
              shipment_status: x.shipment_status,
              invoice_readiness: x.invoice_readiness,
              payment_status: x.payment_status
            }))
        };
      }

      if (role === 'PRODUCTION_WAREHOUSE') {
        const next7Iso = addDaysIso(todayIso, 7);
        const { results: shipmentRows } = await db.prepare(`
          SELECT
            s.shipment_id,
            s.di_id,
            s.status AS shipment_status,
            s.planned_loading_date,
            s.actual_loading_date,
            di.container_plan,
            ROUND(COALESCE((SELECT SUM(dil.planned_qty_mt) FROM delivery_instruction_lines dil WHERE dil.di_id = di.di_id), 0), 3) AS planned_qty_mt,
            COALESCE((SELECT COUNT(*) FROM shipment_containers sc WHERE sc.shipment_id = s.shipment_id AND sc.status <> 'CANCELLED'), 0) AS actual_container_count
          FROM phase6_shipments s
          JOIN delivery_instructions di ON di.di_id = s.di_id
          WHERE s.status <> 'CANCELLED'
            AND di.status <> 'CANCELLED'
          ORDER BY COALESCE(s.planned_loading_date, s.actual_loading_date, substr(s.created_at, 1, 10)) ASC
        `).all();

        const rows = shipmentRows || [];
        const loadingToday = rows.filter((r) => r.planned_loading_date === todayIso || r.actual_loading_date === todayIso).length;
        const dueNext7 = rows.filter((r) => !r.actual_loading_date && r.planned_loading_date && r.planned_loading_date >= todayIso && r.planned_loading_date <= next7Iso).length;
        const plannedCount = rows.filter((r) => !r.actual_loading_date && ['PLANNING', 'BOOKED'].includes(r.shipment_status)).length;
        const loadedThisMonth = rows.filter((r) => r.actual_loading_date && r.actual_loading_date.startsWith(monthPrefix)).length;
        const upcomingPlannedRows = rows.filter((r) => !r.actual_loading_date && ['PLANNING', 'BOOKED'].includes(r.shipment_status));
        const upcomingPlannedMt = round3(upcomingPlannedRows.reduce((acc, r) => acc + Number(r.planned_qty_mt || 0), 0));

        const topUpcoming = upcomingPlannedRows.slice(0, 12);
        const upcomingLoadings = [];
        for (const r of topUpcoming) {
          const { results: prodRows } = await db.prepare(`
            SELECT p.product_code, p.product_name, dil.planned_qty_mt, dil.packing_snapshot
            FROM delivery_instruction_lines dil
            JOIN products p ON p.product_id = dil.product_id
            WHERE dil.di_id = ?
            ORDER BY dil.rowid ASC
          `).bind(r.di_id).all();
          // Strict warehouse allowlist: zero customer, DI no, booking, price, payment, or commission fields
          upcomingLoadings.push({
            planned_loading_date: r.planned_loading_date || null,
            actual_loading_date: r.actual_loading_date || null,
            container_plan: r.container_plan,
            planned_qty_mt: round3(r.planned_qty_mt || 0),
            actual_container_count: Number(r.actual_container_count || 0),
            products: (prodRows || []).map((p) => ({
              product_code: p.product_code,
              product_name: p.product_name,
              planned_qty_mt: round3(p.planned_qty_mt || 0),
              packing_snapshot: p.packing_snapshot
            }))
          });
        }

        return {
          role: 'PRODUCTION_WAREHOUSE',
          as_of_date: todayIso,
          kpis: {
            loading_today_count: loadingToday,
            due_next_7_days_count: dueNext7,
            planned_shipments_count: plannedCount,
            loaded_this_month_count: loadedThisMonth,
            upcoming_planned_mt: upcomingPlannedMt
          },
          upcoming_loadings: upcomingLoadings
        };
      }

      return null;
    }
  };
}
