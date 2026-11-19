import { PO_EVENT_TYPES, SHIPMENT_EVENT_TYPES, WAREHOUSE_EVENT_TYPES } from './validation.js';

const EVENT_TYPE_RANK = {
  LOADING_ACTUAL: 1,
  LOADING_PLANNED: 2,
  ETD: 3,
  ETA: 4,
  PO_DELIVERY_START: 5,
  PO_DELIVERY_END: 6
};

function roundQty(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}

function inRange(dateStr, from, to) {
  return typeof dateStr === 'string' && dateStr.length === 10 && dateStr >= from && dateStr <= to;
}

function parseJsonSafe(raw) {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function queryByIds(db, buildSql, ids) {
  if (!ids.length) return [];
  const rows = [];
  const chunkSize = 80;
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(', ');
    const { results } = await db.prepare(buildSql(placeholders)).bind(...chunk).all();
    rows.push(...(results || []));
  }
  return rows;
}

export function createCalendarRepository(db) {
  if (!db) throw new Error('D1 DB binding is required.');

  return {
    async listCalendarData({
      from,
      to,
      eventType,
      customerId,
      salesOwnerId,
      productId,
      status,
      ownedByUserId,
      loadingOnly = false
    }) {
      const includeShipments = !eventType || SHIPMENT_EVENT_TYPES.includes(eventType);
      const includePOs = !loadingOnly && (!eventType || PO_EVENT_TYPES.includes(eventType));
      const events = [];

      if (includeShipments) {
        const datePredicates = loadingOnly
          ? '(s.planned_loading_date BETWEEN ? AND ? OR s.actual_loading_date BETWEEN ? AND ?)'
          : '(s.planned_loading_date BETWEEN ? AND ? OR s.actual_loading_date BETWEEN ? AND ? OR s.etd BETWEEN ? AND ? OR s.eta BETWEEN ? AND ?)';
        const params = loadingOnly
          ? [from, to, from, to]
          : [from, to, from, to, from, to, from, to];
        const where = [
          "di.status <> 'CANCELLED'",
          "s.status <> 'CANCELLED'",
          datePredicates
        ];

        if (ownedByUserId) {
          where.push('c.owner_user_id = ?');
          params.push(ownedByUserId);
        }
        if (customerId) {
          where.push('di.customer_id = ?');
          params.push(customerId);
        }
        if (salesOwnerId) {
          where.push('c.owner_user_id = ?');
          params.push(salesOwnerId);
        }
        if (status) {
          where.push('s.status = ?');
          params.push(status);
        }
        if (productId) {
          where.push('EXISTS (SELECT 1 FROM delivery_instruction_lines dil_f WHERE dil_f.di_id = di.di_id AND dil_f.product_id = ?)');
          params.push(productId);
        }

        const { results: shipments } = await db.prepare(`
          SELECT
            s.shipment_id,
            s.di_id,
            s.status AS shipment_status,
            s.booking_no,
            s.vessel,
            s.etd,
            s.eta,
            s.planned_loading_date,
            s.actual_loading_date,
            s.schedule_result,
            di.di_no,
            di.status AS di_status,
            di.container_plan,
            di.po_id,
            di.customer_id,
            c.customer_name,
            c.owner_user_id AS sales_owner_user_id,
            pr.customer_po_no
          FROM phase6_shipments s
          JOIN delivery_instructions di ON di.di_id = s.di_id
          JOIN customers c ON c.customer_id = di.customer_id
          LEFT JOIN po_revisions pr ON pr.revision_id = di.po_revision_id
          WHERE ${where.join(' AND ')}
        `).bind(...params).all();

        const matchedShipments = shipments || [];
        const diIds = [...new Set(matchedShipments.map((s) => s.di_id))];
        const shipmentIds = [...new Set(matchedShipments.map((s) => s.shipment_id))];

        const [diLines, containerRows, containerLineRows, auditRows] = await Promise.all([
          queryByIds(
            db,
            (ph) => `
              SELECT
                dil.di_id,
                dil.product_id,
                p.product_code,
                p.product_name,
                dil.planned_qty_mt,
                dil.packing_snapshot
              FROM delivery_instruction_lines dil
              JOIN products p ON p.product_id = dil.product_id
              WHERE dil.di_id IN (${ph})
              ORDER BY dil.di_line_id ASC
            `,
            diIds
          ),
          queryByIds(
            db,
            (ph) => `
              SELECT
                sc.container_id,
                sc.shipment_id,
                sc.container_no,
                sc.seal_no
              FROM shipment_containers sc
              WHERE sc.shipment_id IN (${ph})
                AND sc.status <> 'CANCELLED'
              ORDER BY sc.created_at ASC, sc.container_no ASC
            `,
            shipmentIds
          ),
          queryByIds(
            db,
            (ph) => `
              SELECT
                scl.container_id,
                sc.shipment_id,
                p.product_code,
                p.product_name,
                scl.number_of_bags,
                scl.qty_mt
              FROM shipment_container_lines scl
              JOIN shipment_containers sc ON sc.container_id = scl.container_id
              JOIN delivery_instruction_lines dil ON dil.di_line_id = scl.delivery_instruction_line_id
              JOIN products p ON p.product_id = dil.product_id
              WHERE sc.shipment_id IN (${ph})
                AND sc.status <> 'CANCELLED'
              ORDER BY scl.container_line_id ASC
            `,
            shipmentIds
          ),
          queryByIds(
            db,
            (ph) => `
              SELECT
                ae.entity_id AS shipment_id,
                ae.event_type,
                ae.metadata_json,
                ae.created_at,
                COALESCE(u.full_name, ae.actor_id) AS actor_name
              FROM shipment_audit_events ae
              LEFT JOIN users u ON u.user_id = ae.actor_id
              WHERE ae.entity_type = 'SHIPMENT'
                AND ae.entity_id IN (${ph})
                AND ae.event_type IN ('PLANNED_LOADING_DATE_UPDATED', 'ACTUAL_LOADING_DATE_RECORDED')
              ORDER BY ae.created_at DESC, ae.event_id DESC
            `,
            shipmentIds
          )
        ]);

        const productsByDi = new Map();
        for (const line of diLines) {
          const list = productsByDi.get(line.di_id) || [];
          list.push({
            product_id: line.product_id,
            product_code: line.product_code,
            product_name: line.product_name,
            planned_qty_mt: roundQty(line.planned_qty_mt),
            packing_snapshot: line.packing_snapshot
          });
          productsByDi.set(line.di_id, list);
        }

        const linesByContainer = new Map();
        for (const cl of containerLineRows) {
          const list = linesByContainer.get(cl.container_id) || [];
          list.push({
            product_code: cl.product_code,
            product_name: cl.product_name,
            number_of_bags: Number(cl.number_of_bags || 0),
            qty_mt: roundQty(cl.qty_mt)
          });
          linesByContainer.set(cl.container_id, list);
        }

        const containersByShipment = new Map();
        for (const cont of containerRows) {
          const list = containersByShipment.get(cont.shipment_id) || [];
          list.push({
            container_no: cont.container_no,
            seal_no: cont.seal_no || null,
            lines: linesByContainer.get(cont.container_id) || []
          });
          containersByShipment.set(cont.shipment_id, list);
        }

        const historyByShipment = new Map();
        for (const audit of auditRows) {
          const meta = parseJsonSafe(audit.metadata_json);
          const list = historyByShipment.get(audit.shipment_id) || [];
          list.push({
            event_type: audit.event_type,
            old_date: meta.old ?? meta.old_date ?? null,
            new_date: meta.new ?? meta.new_date ?? meta.actualLoadingDate ?? meta.actual_loading_date ?? null,
            actor_name: audit.actor_name,
            created_at: audit.created_at
          });
          historyByShipment.set(audit.shipment_id, list);
        }

        for (const s of matchedShipments) {
          const products = productsByDi.get(s.di_id) || [];
          const plannedQtyMt = roundQty(products.reduce((sum, p) => sum + Number(p.planned_qty_mt || 0), 0));
          const containers = containersByShipment.get(s.shipment_id) || [];
          const loadingDateHistory = historyByShipment.get(s.shipment_id) || [];

          const base = {
            shipment_id: s.shipment_id,
            di_id: s.di_id,
            di_no: s.di_no,
            po_id: s.po_id,
            customer_po_no: s.customer_po_no || null,
            customer_id: s.customer_id,
            customer_name: s.customer_name,
            sales_owner_user_id: s.sales_owner_user_id || null,
            di_status: s.di_status,
            shipment_status: s.shipment_status,
            booking_no: s.booking_no || null,
            vessel: s.vessel || null,
            etd: s.etd || null,
            eta: s.eta || null,
            planned_loading_date: s.planned_loading_date || null,
            actual_loading_date: s.actual_loading_date || null,
            schedule_result: s.schedule_result || null,
            container_plan: s.container_plan,
            planned_qty_mt: plannedQtyMt,
            actual_container_count: containers.length,
            products,
            containers,
            loading_date_history: loadingDateHistory
          };

          const emit = (type, date) => {
            if (!inRange(date, from, to)) return;
            if (loadingOnly && !WAREHOUSE_EVENT_TYPES.includes(type)) return;
            if (eventType && eventType !== type) return;
            events.push({
              ...base,
              event_id: `${type}:${s.shipment_id}`,
              event_type: type,
              event_date: date
            });
          };

          // Suppress duplicate same-day LOADING_PLANNED when actual loading is already recorded on the same date
          if (s.planned_loading_date && s.actual_loading_date !== s.planned_loading_date) {
            emit('LOADING_PLANNED', s.planned_loading_date);
          }
          if (s.actual_loading_date) {
            emit('LOADING_ACTUAL', s.actual_loading_date);
          }
          if (!loadingOnly) {
            if (s.etd) emit('ETD', s.etd);
            if (s.eta) emit('ETA', s.eta);
          }
        }
      }

      if (includePOs) {
        const params = [from, to, from, to];
        const where = [
          "ph.header_status <> 'CANCELLED'",
          "pr.status = 'ACTIVE'",
          '(pr.delivery_start BETWEEN ? AND ? OR pr.delivery_end BETWEEN ? AND ?)'
        ];

        if (ownedByUserId) {
          where.push("pr.ownership_type_snapshot = 'ASSIGNED_SALES'");
          where.push('pr.sales_owner_user_id_snapshot = ?');
          where.push('c.owner_user_id = ?');
          params.push(ownedByUserId, ownedByUserId);
        }
        if (customerId) {
          where.push('ph.customer_id = ?');
          params.push(customerId);
        }
        if (salesOwnerId) {
          where.push('COALESCE(pr.sales_owner_user_id_snapshot, c.owner_user_id) = ?');
          params.push(salesOwnerId);
        }
        if (status) {
          where.push('ph.header_status = ?');
          params.push(status);
        }
        if (productId) {
          where.push('EXISTS (SELECT 1 FROM po_revision_lines prl_f WHERE prl_f.po_revision_id = pr.revision_id AND prl_f.product_id = ?)');
          params.push(productId);
        }

        const { results: poRows } = await db.prepare(`
          SELECT
            ph.po_id,
            ph.customer_id,
            ph.header_status AS po_status,
            pr.revision_id,
            pr.customer_po_no,
            pr.incoterm,
            pr.destination,
            pr.delivery_start,
            pr.delivery_end,
            COALESCE(pr.sales_owner_user_id_snapshot, c.owner_user_id) AS sales_owner_user_id,
            c.customer_name
          FROM po_headers ph
          JOIN po_revisions pr ON pr.po_id = ph.po_id AND pr.status = 'ACTIVE'
          JOIN customers c ON c.customer_id = ph.customer_id
          WHERE ${where.join(' AND ')}
        `).bind(...params).all();

        const matchedPOs = poRows || [];
        const revisionIds = [...new Set(matchedPOs.map((po) => po.revision_id))];
        const poLines = await queryByIds(
          db,
          (ph) => `
            SELECT
              prl.po_revision_id,
              prl.product_id,
              p.product_code,
              p.product_name,
              prl.contract_qty_mt,
              prl.packaging
            FROM po_revision_lines prl
            JOIN products p ON p.product_id = prl.product_id
            WHERE prl.po_revision_id IN (${ph})
            ORDER BY prl.line_no ASC
          `,
          revisionIds
        );

        const productsByRev = new Map();
        for (const line of poLines) {
          const list = productsByRev.get(line.po_revision_id) || [];
          list.push({
            product_id: line.product_id,
            product_code: line.product_code,
            product_name: line.product_name,
            contract_qty_mt: roundQty(line.contract_qty_mt),
            packaging: line.packaging
          });
          productsByRev.set(line.po_revision_id, list);
        }

        for (const po of matchedPOs) {
          const products = productsByRev.get(po.revision_id) || [];
          const totalContractQtyMt = roundQty(products.reduce((sum, p) => sum + Number(p.contract_qty_mt || 0), 0));
          const base = {
            po_id: po.po_id,
            customer_po_no: po.customer_po_no || po.po_id,
            customer_id: po.customer_id,
            customer_name: po.customer_name,
            sales_owner_user_id: po.sales_owner_user_id || null,
            po_status: po.po_status,
            incoterm: po.incoterm,
            destination: po.destination || null,
            delivery_start: po.delivery_start,
            delivery_end: po.delivery_end,
            total_contract_qty_mt: totalContractQtyMt,
            products
          };

          const emit = (type, date) => {
            if (!inRange(date, from, to)) return;
            if (eventType && eventType !== type) return;
            events.push({
              ...base,
              event_id: `${type}:${po.po_id}`,
              event_type: type,
              event_date: date
            });
          };

          if (po.delivery_start) emit('PO_DELIVERY_START', po.delivery_start);
          if (po.delivery_end) emit('PO_DELIVERY_END', po.delivery_end);
        }
      }

      events.sort((a, b) => {
        if (a.event_date !== b.event_date) return a.event_date.localeCompare(b.event_date);
        const rankDiff = (EVENT_TYPE_RANK[a.event_type] || 99) - (EVENT_TYPE_RANK[b.event_type] || 99);
        if (rankDiff !== 0) return rankDiff;
        const refA = a.di_no || a.customer_po_no || a.event_id;
        const refB = b.di_no || b.customer_po_no || b.event_id;
        return String(refA).localeCompare(String(refB)) || String(a.event_id).localeCompare(String(b.event_id));
      });

      const summaryMap = new Map();
      for (const e of events) {
        if (e.event_type !== 'LOADING_PLANNED' && e.event_type !== 'LOADING_ACTUAL') continue;
        let bucket = summaryMap.get(e.event_date);
        if (!bucket) {
          bucket = {
            date: e.event_date,
            shipmentIds: new Set(),
            actual_container_count: 0,
            planned_qty_mt: 0
          };
          summaryMap.set(e.event_date, bucket);
        }
        if (!bucket.shipmentIds.has(e.shipment_id)) {
          bucket.shipmentIds.add(e.shipment_id);
          bucket.actual_container_count += Number(e.actual_container_count || 0);
          bucket.planned_qty_mt = roundQty(bucket.planned_qty_mt + Number(e.planned_qty_mt || 0));
        }
      }

      const dailyLoadingSummary = [...summaryMap.values()]
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((b) => ({
          date: b.date,
          shipment_count: b.shipmentIds.size,
          actual_container_count: b.actual_container_count,
          planned_qty_mt: b.planned_qty_mt
        }));

      return { events, dailyLoadingSummary };
    }
  };
}
