import { scopedWorkspaceDetailReference } from '../shipping-di/routes.js';

const financialRoles = new Set(['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT']);
const sum = (rows, key) => rows.reduce((total, row) => total + Number(row[key] || 0), 0);
const roundMoney = value => Math.round(value * 100) / 100;

function currencyTotals(rows, key) {
  const totals = {};
  for (const row of rows) totals[row.currency] = (totals[row.currency] || 0) + Number(row[key] || 0);
  return Object.fromEntries(Object.entries(totals).map(([currency, value]) => [currency, roundMoney(value)]));
}

export async function buildExecutiveDashboard(db, caller, now, period = 'all') {
  const warehouse = caller.role === 'PRODUCTION_WAREHOUSE';
  const finance = financialRoles.has(caller.role);
  const external = caller.role === 'EXTERNAL_SALES';
  const scope = external ? "AND c.ownership_type = 'ASSIGNED_SALES' AND c.owner_user_id = ?" : '';
  if (external && !caller.user_id) return null;
  const date = value => new Date(value + 7 * 3600000).toISOString().slice(0, 10);
  const today = date(now.getTime());
  const until = date(now.getTime() + 30 * 86400000);
  const query = async sql => (await db.prepare(sql).bind(...(external ? [caller.user_id] : [])).all()).results || [];
  const year = today.slice(0,4);
  const currentMonth = Number(today.slice(5,7));
  const startMonth = period==='this_month' ? currentMonth : period==='this_quarter' ? Math.floor((currentMonth-1)/3)*3+1 : 1;
  const duration = period==='this_month' ? 1 : period==='this_quarter' ? 3 : 12;
  const from = year + '-' + String(startMonth).padStart(2,'0') + '-01';
  const untilPeriod = new Date(Date.UTC(Number(year),startMonth-1+duration,1)).toISOString().slice(0,10);
  const inPeriod = value => period==='all' || Boolean(value && value >= from && value < untilPeriod);
  const [allContracts, lines, invoices] = await Promise.all([
    query(`
      SELECT h.po_id, r.currency, l.product_id, p.product_name, l.contract_qty_mt,
             COALESCE(NULLIF(r.po_date,''),substr(h.created_at,1,10)) AS contract_date,
             COALESCE(ss.application,cs.application,'OTHER') AS grade,
             l.contract_qty_mt * l.unit_price AS amount
      FROM po_headers h JOIN customers c ON c.customer_id = h.customer_id
      LEFT JOIN po_revisions r ON r.revision_id = (
        SELECT revision_id FROM po_revisions
        WHERE po_id = h.po_id AND status IN ('ACTIVE','DRAFT')
        ORDER BY status = 'ACTIVE' DESC, revision_no DESC LIMIT 1
      )
      LEFT JOIN po_revision_lines l ON l.po_revision_id = r.revision_id
      LEFT JOIN products p ON p.product_id = l.product_id
      LEFT JOIN standard_specs ss ON l.spec_source='STANDARD' AND ss.standard_spec_id=l.spec_revision_id
      LEFT JOIN customer_specs cs ON l.spec_source='CUSTOMER' AND cs.customer_spec_id=l.spec_revision_id
      WHERE h.header_status IN ('OPEN','PARTIALLY_SHIPPED') ${scope}
    `),
    query(`
      SELECT s.*, di.di_id, di.di_no, di.po_id, di.shipping_month, di.container_plan,
             c.customer_name, r.customer_po_no, r.currency, pr.product_name, dl.product_id,
             dl.planned_qty_mt, pl.unit_price, pl.container_type, COALESCE(ss.application,cs.application,'OTHER') AS grade,
             COALESCE(s.planned_loading_date, (
               SELECT json_extract(metadata_json,'$.new.plannedLoadingDate')
               FROM shipment_audit_events WHERE entity_type='DI' AND entity_id=di.di_id
               AND json_type(metadata_json,'$.new.plannedLoadingDate') IS NOT NULL ORDER BY rowid DESC LIMIT 1
             )) AS loading_start,
             COALESCE((SELECT SUM(cl.qty_mt) FROM shipment_container_lines cl
               JOIN shipment_containers sc ON sc.container_id=cl.container_id
               WHERE cl.delivery_instruction_line_id=dl.di_line_id AND sc.shipment_id=s.shipment_id AND sc.status<>'CANCELLED'),
               (SELECT SUM(il.qty_mt) FROM shipment_invoice_lines il JOIN shipment_invoices inv ON inv.invoice_id=il.invoice_id
                WHERE inv.shipment_id=s.shipment_id AND inv.version='FINAL' AND il.po_revision_line_id=dl.po_revision_line_id),0) AS actual_mt,
             (SELECT COUNT(*) FROM shipment_containers sc WHERE sc.shipment_id=s.shipment_id AND sc.status<>'CANCELLED') AS container_count
      FROM delivery_instructions di JOIN customers c ON c.customer_id=di.customer_id
      JOIN po_headers h ON h.po_id=di.po_id AND h.customer_id=di.customer_id AND h.header_status<>'CANCELLED'
      JOIN po_revisions r ON r.revision_id=di.po_revision_id
      LEFT JOIN phase6_shipments s ON s.di_id=di.di_id
      JOIN delivery_instruction_lines dl ON dl.di_id=di.di_id
      JOIN products pr ON pr.product_id=dl.product_id
      JOIN po_revision_lines pl ON pl.line_id=dl.po_revision_line_id
      LEFT JOIN standard_specs ss ON pl.spec_source='STANDARD' AND ss.standard_spec_id=pl.spec_revision_id
      LEFT JOIN customer_specs cs ON pl.spec_source='CUSTOMER' AND cs.customer_spec_id=pl.spec_revision_id
      WHERE di.status<>'CANCELLED' AND COALESCE(s.status,'')<>'CANCELLED' ${scope}
    `),
    warehouse ? [] : query(`
      SELECT inv.shipment_id, inv.invoice_no, inv.version, inv.currency, inv.invoice_date, inv.invoice_id,
             COALESCE((SELECT SUM(line_amount) FROM shipment_invoice_lines WHERE invoice_id=inv.invoice_id),0) AS amount,
             COALESCE(s.cash_received_amount,0) + COALESCE((SELECT SUM(amount) FROM customer_credit_usages WHERE shipment_id=s.shipment_id),0) AS paid
      FROM shipment_invoices inv JOIN phase6_shipments s ON s.shipment_id=inv.shipment_id
      JOIN delivery_instructions di ON di.di_id=s.di_id JOIN customers c ON c.customer_id=di.customer_id
      JOIN po_headers h ON h.po_id=di.po_id
      WHERE s.status<>'CANCELLED' AND di.status<>'CANCELLED' AND h.header_status<>'CANCELLED' ${scope}
      ORDER BY inv.invoice_date, inv.invoice_no, inv.invoice_id
    `)
  ]);
  const contracts = allContracts.filter(row=>inPeriod(row.contract_date));
  const grades = new Map(['FEED_GRADE','PET_GRADE'].map(grade=>[grade,{grade,contract:0,actual:0}]));
  const openPOs = new Set(contracts.map(row => row.po_id));
  const products = new Map(), months = new Map(), schedules = new Map(), unpaid = [], invoiceGroups = new Map();
  for (const invoice of invoices) {
    if (!invoiceGroups.has(invoice.shipment_id)) invoiceGroups.set(invoice.shipment_id, []);
    invoiceGroups.get(invoice.shipment_id).push(invoice);
  }
  for (const group of invoiceGroups.values()) {
    let paid = roundMoney(group[0].paid);
    for (const invoice of group.filter(row => row.version === 'FINAL')) {
      invoice.outstanding = roundMoney(Math.max(0, invoice.amount - paid));
      paid = Math.max(0, paid - invoice.amount);
      if (invoice.outstanding > 0 && inPeriod(invoice.invoice_date)) unpaid.push(invoice);
    }
  }
  for (const row of contracts.filter(row => row.product_id)) {
    const product = products.get(row.product_id) || {name:row.product_name, contract:0, actual:0};
    product.contract += row.contract_qty_mt;
    products.set(row.product_id, product);
    const grade = grades.get(row.grade) || {grade:row.grade,contract:0,actual:0};
    grade.contract += row.contract_qty_mt;
    grades.set(row.grade,grade);
  }
  const month = key => {
    if (!months.has(key)) months.set(key,{month:key,planned:0,actual:0});
    return months.get(key);
  };
  for (const line of lines) {
    const plannedMonth = line.loading_start?.slice(0,7) || line.shipping_month;
    const actualMonth = line.actual_loading_date?.slice(0,7) || plannedMonth;
    const plannedInPeriod = inPeriod(line.loading_start || plannedMonth + '-01');
    const actualInPeriod = inPeriod(line.actual_loading_date || actualMonth + '-01');
    if (plannedInPeriod) month(plannedMonth).planned += line.planned_qty_mt;
    if (line.actual_mt && actualInPeriod) month(actualMonth).actual += line.actual_mt;
    if (openPOs.has(line.po_id) && actualInPeriod) {
      if (products.has(line.product_id)) products.get(line.product_id).actual += line.actual_mt;
      if (line.actual_mt) {
        const grade = grades.get(line.grade) || {grade:line.grade,contract:0,actual:0};
        grade.actual += line.actual_mt;
        grades.set(line.grade,grade);
      }
    }
    if (!plannedInPeriod && !(line.actual_loading_date && actualInPeriod) && !(invoiceGroups.get(line.shipment_id) || []).some(invoice=>inPeriod(invoice.invoice_date))) continue;
    const item = schedules.get(line.di_id) || {line, names:new Set(), planned:0, actual:0, amount:0};
    item.names.add(line.product_name);
    item.planned += line.planned_qty_mt;
    item.actual += line.actual_mt;
    item.amount += (line.actual_mt || line.planned_qty_mt) * line.unit_price;
    schedules.set(line.di_id,item);
  }
  const ordered = [...schedules.values()].sort((a,b)=>(a.line.loading_start || a.line.etd || '9999').localeCompare(b.line.loading_start || b.line.etd || '9999'));
  const future = ordered.filter(({line}) => !line.actual_loading_date && !['LOADED','DOCS_SENT','COMPLETED'].includes(line.status) && (line.loading_start || line.etd || '') >= today && inPeriod(line.loading_start || line.etd));
  const near = future.filter(({line}) => (line.loading_start || line.etd) <= until);
  const upcoming = near.length ? near : future.slice(0,7);
  const breakdown = countContainers(upcoming);
  const immediateContainers = sum(Object.values(countContainers(near)).map(count=>({count})),'count');
  function countContainers(items) {
    const breakdown = {small:0,large:0,other:0};
    for (const {line} of items) {
      const matches = [...String(line.container_plan || '').matchAll(/(\d+)\s*[×x*]\s*(20|40)/gi)];
      if (matches.length) for (const [,count,size] of matches) breakdown[size==='20'?'small':'large'] += Number(count);
      else {
        const count = /^\s*(\d+)\b/.exec(line.container_plan || '');
        if (count) breakdown.other += Number(count[1]);
      }
    }
    return breakdown;
  }
  const priorities = {outOfPlan:0,preliminary:1,awaitingPayment:2,upcomingLoading:3};
  const watchlistCandidates = ordered.flatMap(({line,names,planned,actual,amount}) => {
    if (line.status === 'COMPLETED') return [];
    const related = invoiceGroups.get(line.shipment_id) || [];
    const final = related.filter(row=>row.version==='FINAL');
    const waiting = final.find(row=>row.outstanding>0 && inPeriod(row.invoice_date));
    const preliminary = related.find(row=>row.version==='PRELIMINARY');
    const dateStart = line.actual_loading_date || line.loading_start || line.etd;
    const alert = line.schedule_result==='OUT_OF_PLAN' ? 'outOfPlan' : actual && preliminary && !final.length ? 'preliminary' : waiting ? 'awaitingPayment' : !actual && !line.actual_loading_date && dateStart && dateStart >= today ? 'upcomingLoading' : null;
    if (!alert) return [];
    return [{
      navigationId:line.di_id,
      product:[...names].join(', '), planned, actual, start:dateStart,
      end:line.actual_loading_date ? null : line.planned_loading_end_date,
      alert, ...(warehouse ? {} : {
        poId:line.po_id, customerPO:line.customer_po_no, ref:(waiting || final.at(-1) || preliminary)?.invoice_no || line.di_no,
        customer:line.customer_name, amount:roundMoney(amount), currency:line.currency,
        ...(!external ? {diId:line.di_id} : {})
      })
    }];
  }).sort((a,b)=>priorities[a.alert]-priorities[b.alert]).slice(0,7);
  const watchlist = await Promise.all(watchlistCandidates.map(async ({navigationId, ...row}) => ({
    ...row,
    ...(warehouse && caller.user_id ? {diId:await scopedWorkspaceDetailReference(caller,navigationId)} : {})
  })));
  const totalContract = sum(contracts,'contract_qty_mt');
  const actual = sum(lines.filter(line=>openPOs.has(line.po_id) && inPeriod(line.actual_loading_date || (line.loading_start?.slice(0,7) || line.shipping_month) + '-01')),'actual_mt');
  const loaded = [...new Map(lines.filter(line=>line.actual_loading_date && inPeriod(line.actual_loading_date)).map(line=>[line.di_id,line])).values()];
  const onPlan = loaded.filter(line=>line.loading_start && line.actual_loading_date >= line.loading_start && line.actual_loading_date <= (line.planned_loading_end_date || line.loading_start)).length;
  const onPlanRatePct = loaded.length ? Math.round(1000 * onPlan / loaded.length)/10 : 0;
  const gradeBreakdown = [...grades.values()].map(item=>({
    ...item, remaining: Math.max(0,item.contract-item.actual),
    sharePct: totalContract ? Math.round(1000*item.contract/totalContract)/10 : 0,
    ...(!warehouse ? {contractValue:currencyTotals(contracts.filter(row=>row.grade===item.grade && row.currency),'amount')} : {})
  }));
  const leading = [...gradeBreakdown].sort((a,b)=>b.contract-a.contract)[0];
  const gradeNames = {FEED_GRADE:['Feed Grade','เกรดอาหารสัตว์'],PET_GRADE:['Pet Grade','เกรดอาหารสัตว์เลี้ยง'],OTHER:['Other','อื่น ๆ']};
  const mt = value => Number(value).toLocaleString('en-US',{maximumFractionDigits:3});
  const insights = [
    leading?.contract ? {en:gradeNames[leading.grade][0]+' leads contracted volume at '+leading.sharePct+'%.',th:gradeNames[leading.grade][1]+' มีสัดส่วนสัญญาสูงสุด '+leading.sharePct+'%'}
      : {en:'No contracted volume in this period.',th:'ไม่มีปริมาณตามสัญญาในช่วงนี้'},
    {en:immediateContainers+' containers and '+mt(sum(near,'planned'))+' MT planned in the next 30 days.',th:'มีแผนโหลด '+immediateContainers+' ตู้ รวม '+mt(sum(near,'planned'))+' MT ใน 30 วันข้างหน้า'},
    loaded.length ? {en:onPlan+' of '+loaded.length+' recorded loadings were on plan ('+onPlanRatePct+'%).',th:'โหลดตรงแผน '+onPlan+' จาก '+loaded.length+' รายการ ('+onPlanRatePct+'%)'}
      : {en:'No actual loading dates recorded in this period.',th:'ยังไม่มีวันที่โหลดจริงในช่วงนี้'}
  ];
  return {
    period, gradeBreakdown, onPlanRatePct, onPlanCount:onPlan, loadedCount:loaded.length, insights,
    openCount:openPOs.size,totalContract,actual,remaining:Math.max(0,totalContract-actual),
    products:[...products.values()].sort((a,b)=>b.contract-a.contract),
    months:[...months.values()].sort((a,b)=>a.month.localeCompare(b.month)),
    upcoming:{mt:sum(upcoming,'planned'),count:upcoming.length, fallback:!near.length && !!upcoming.length, nextDate:upcoming[0]?.line.loading_start || upcoming[0]?.line.etd, ...breakdown},
    queue:ordered.filter(({line,actual})=>!actual && !line.actual_loading_date && !['LOADED','DOCS_SENT','COMPLETED'].includes(line.status)).length,
    activeContainers:ordered.filter(({line})=>line.status!=='COMPLETED').reduce((total,{line})=>total+line.container_count,0),
    watchlist,
    ...(!warehouse ? {contractValue:currencyTotals(contracts.filter(row=>row.currency),'amount')} : {}),
    ...(finance ? {receivables:currencyTotals(unpaid,'outstanding'),overdue:unpaid.filter(row=>row.invoice_date < date(now.getTime()-30*86400000)).length} : {})
  };
}
