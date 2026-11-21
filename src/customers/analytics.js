const DAY = 86400000;
const money = value => Math.round(value * 100) / 100;
function addCurrency(target, currency, amount) {
  target[currency] = money((target[currency] || 0) + amount);
}
export function classifyCustomer({petGradeMt,feedGradeMt,totalContractedMt,poCount,remainingMt,lastActivity}, dormantBefore) {
  const tierSScore = petGradeMt / 1000 + feedGradeMt / 7000;
  let tier = 'B';
  if (!totalContractedMt || (remainingMt === 0 && lastActivity && lastActivity < dormantBefore)) tier = 'C';
  else if (tierSScore + 1e-10 >= 1) tier = 'S';
  else if (petGradeMt >= 300 || feedGradeMt >= 2000 || tierSScore + 1e-10 >= .30 || (poCount >= 2 && totalContractedMt >= 100)) tier = 'A';
  return {tier,tierSScore};
}

export async function buildCustomerAnalytics(db, caller, filters, now = new Date()) {
  const external = caller.role === 'EXTERNAL_SALES';
  const finance = caller.role !== 'PRODUCTION_WAREHOUSE';
  if (external && !caller.user_id) throw new Error('Missing customer scope.');
  const scope = external ? "WHERE c.ownership_type='ASSIGNED_SALES' AND c.owner_user_id=?" : '';
  const query = async sql => (await db.prepare(`WITH scoped AS (SELECT c.* FROM customers c ${scope}) ${sql}`)
    .bind(...(external ? [caller.user_id] : [])).all()).results || [];
  const date = timestamp => new Date(timestamp + 7*3600000).toISOString().slice(0,10);
  const today = date(now.getTime());
  const year = Number(today.slice(0,4)), month = Number(today.slice(5,7));
  const start = filters.period==='this_month'?month:filters.period==='this_quarter'?Math.floor((month-1)/3)*3+1:1;
  const span = filters.period==='this_month'?1:filters.period==='this_quarter'?3:12;
  const boundary = m => new Date(Date.UTC(year,m-1,1)).toISOString().slice(0,10);
  const from = boundary(start), until = boundary(start+span);
  const inPeriod = value => filters.period==='all' || Boolean(value && value>=from && value<until);
  const [customers, lines, shipments, invoices] = await Promise.all([
    query(`SELECT c.customer_id AS id,c.customer_name AS name,c.customer_code AS code,c.country,c.status,c.source,c.ownership_type AS ownershipType,
      c.owner_user_id AS repId, u.full_name AS repName FROM scoped c LEFT JOIN users u ON u.user_id=c.owner_user_id ORDER BY c.customer_name`),
    query(`SELECT h.customer_id,h.po_id,h.header_status,r.customer_po_no,r.currency,l.product_id,l.contract_qty_mt AS qty,l.unit_price,
      COALESCE(NULLIF(r.po_date,''),substr(h.created_at,1,10)) AS activity,
      COALESCE(ss.application,cs.application,'OTHER') AS grade
      FROM scoped c JOIN po_headers h ON h.customer_id=c.customer_id
      JOIN po_revisions r ON r.revision_id=(SELECT revision_id FROM po_revisions WHERE po_id=h.po_id
        AND status IN ('ACTIVE','DRAFT','SUPERSEDED') ORDER BY CASE status WHEN 'ACTIVE' THEN 0 WHEN 'DRAFT' THEN 1 ELSE 2 END,revision_no DESC LIMIT 1)
      JOIN po_revision_lines l ON l.po_revision_id=r.revision_id
      LEFT JOIN standard_specs ss ON l.spec_source='STANDARD' AND ss.standard_spec_id=l.spec_revision_id
      LEFT JOIN customer_specs cs ON l.spec_source='CUSTOMER' AND cs.customer_spec_id=l.spec_revision_id
      WHERE h.header_status<>'CANCELLED' ORDER BY h.po_id,l.line_no`),
    query(`SELECT di.customer_id,di.po_id,di.di_id,di.di_no,s.shipment_id,dl.product_id,
      COALESCE(s.actual_loading_date,s.planned_loading_date,di.shipping_month||'-01') AS activity,
      COALESCE(s.status,di.status) AS status,dl.planned_qty_mt,
      COALESCE((SELECT SUM(cl.qty_mt) FROM shipment_container_lines cl JOIN shipment_containers sc ON sc.container_id=cl.container_id
        WHERE sc.shipment_id=s.shipment_id AND sc.status<>'CANCELLED' AND cl.delivery_instruction_line_id=dl.di_line_id),
        (SELECT SUM(il.qty_mt) FROM shipment_invoice_lines il JOIN shipment_invoices i ON i.invoice_id=il.invoice_id
        WHERE i.shipment_id=s.shipment_id AND i.version='FINAL' AND il.po_revision_line_id=dl.po_revision_line_id),0) AS qty
      FROM scoped c JOIN delivery_instructions di ON di.customer_id=c.customer_id
      JOIN po_headers h ON h.po_id=di.po_id AND h.customer_id=c.customer_id AND h.header_status<>'CANCELLED'
      JOIN delivery_instruction_lines dl ON dl.di_id=di.di_id
      LEFT JOIN phase6_shipments s ON s.di_id=di.di_id
      WHERE di.status<>'CANCELLED' AND COALESCE(s.status,'')<>'CANCELLED'
      ORDER BY activity DESC`),
    finance ? query(`SELECT di.customer_id,s.shipment_id,i.invoice_no,i.invoice_date,i.currency,
      COALESCE((SELECT SUM(line_amount) FROM shipment_invoice_lines WHERE invoice_id=i.invoice_id),0) AS amount,
      COALESCE(s.cash_received_amount,0)+COALESCE((SELECT SUM(amount) FROM customer_credit_usages WHERE shipment_id=s.shipment_id),0) AS paid
      FROM scoped c JOIN delivery_instructions di ON di.customer_id=c.customer_id
      JOIN po_headers h ON h.po_id=di.po_id AND h.customer_id=c.customer_id AND h.header_status<>'CANCELLED'
      JOIN phase6_shipments s ON s.di_id=di.di_id JOIN shipment_invoices i ON i.shipment_id=s.shipment_id
      WHERE di.status<>'CANCELLED' AND s.status<>'CANCELLED' AND i.version='FINAL'
      ORDER BY i.invoice_date,i.invoice_no,i.invoice_id`) : []
  ]);
  const profiles = new Map(customers.map(({repId,repName,...customer})=>[customer.id,{
    ...customer,...(finance?{repId,repName,contractValue:{},ar:{},overdue:false,invoices:[]}:{}),
    totalContractedMt:0,shippedMt:0,remainingMt:0,petGradeMt:0,feedGradeMt:0,
    lastActivity:'',orders:[],shipments:[],deliveryQueue:0
  }]));
  const reps = finance && !external ? [...new Map(customers.filter(c=>c.repId).map(c=>[c.repId,{id:c.repId,name:c.repName}])).values()] : [];
  const volumeKey = row => JSON.stringify([row.po_id,row.product_id]);
  const shipped = new Map(), recent = new Map();
  for (const row of shipments) {
    const customer = profiles.get(row.customer_id);
    shipped.set(volumeKey(row),(shipped.get(volumeKey(row))||0)+row.qty);
    if (row.activity > customer.lastActivity) customer.lastActivity=row.activity;
    if (!inPeriod(row.activity)) continue;
    customer.shippedMt+=row.qty;
    if (!recent.has(row.di_id)) {
      const item={reference:row.di_no,date:row.activity,status:row.status,planned:0,actual:0};
      if (finance) item.shipmentId=row.shipment_id;
      recent.set(row.di_id,item);
      customer.shipments.push(item);
      if (['DRAFT','CONFIRMED','IN_PROGRESS','PLANNING','BOOKED'].includes(row.status)) customer.deliveryQueue++;
    }
    const item=recent.get(row.di_id);
    item.planned+=row.planned_qty_mt;
    item.actual+=row.qty;
  }
  const orders = new Map();
  for (const row of lines) {
    const customer = profiles.get(row.customer_id);
    if (row.activity > customer.lastActivity) customer.lastActivity=row.activity;
    if (!inPeriod(row.activity)) continue;
    if (!orders.has(row.po_id)) {
      const order={reference:row.customer_po_no||row.po_id,date:row.activity,mt:0};
      orders.set(row.po_id,order);
      customer.orders.push(order);
    }
    orders.get(row.po_id).mt+=row.qty;
    customer.totalContractedMt+=row.qty;
    if (row.grade==='PET_GRADE') customer.petGradeMt+=row.qty;
    if (row.grade==='FEED_GRADE') customer.feedGradeMt+=row.qty;
    if (['OPEN','PARTIALLY_SHIPPED'].includes(row.header_status)) {
      const key=volumeKey(row);
      const consumed=Math.min(row.qty,shipped.get(key)||0);
      shipped.set(key,(shipped.get(key)||0)-consumed);
      customer.remainingMt+=row.qty-consumed;
    }
    if (finance) addCurrency(customer.contractValue,row.currency,row.qty*row.unit_price);
  }
  const payments = new Map();
  for (const invoice of invoices) {
    const paid = payments.has(invoice.shipment_id) ? payments.get(invoice.shipment_id) : invoice.paid;
    const balance = money(Math.max(0,invoice.amount-paid));
    payments.set(invoice.shipment_id,Math.max(0,paid-invoice.amount));
    if (!inPeriod(invoice.invoice_date)) continue;
    const customer = profiles.get(invoice.customer_id);
    const overdue=balance>0 && invoice.invoice_date < date(now.getTime()-30*DAY);
    if (balance) addCurrency(customer.ar,invoice.currency,balance);
    customer.overdue ||= overdue;
    customer.invoices.push({reference:invoice.invoice_no,date:invoice.invoice_date,currency:invoice.currency,balance,overdue});
  }
  const needle = filters.search.trim().toLowerCase();
  const rows = [...profiles.values()].map(customer=>{
    customer.poCount=customer.orders.length;
    Object.assign(customer,classifyCustomer(customer,date(now.getTime()-120*DAY)));
    customer.shipments=customer.shipments.slice(0,10).map(({shipmentId,...item})=>item);
    customer.invoices?.sort((a,b)=>b.date.localeCompare(a.date));
    return customer;
  }).filter(customer=>(filters.tier==='ALL'||customer.tier===filters.tier)
    && (filters.grade==='ALL'||(filters.grade==='PET_GRADE'?customer.petGradeMt:customer.feedGradeMt)>0)
    && (!filters.repId||customer.repId===filters.repId)
    && [customer.name,customer.code,customer.country].some(value=>String(value||'').toLowerCase().includes(needle)))
    .sort((a,b)=>b.totalContractedMt-a.totalContractedMt||a.name.localeCompare(b.name));
  const sum = (list,key) => list.reduce((total,row)=>total+row[key],0);
  const total = sum(rows,'totalContractedMt');
  const share = value => total ? value/total*100 : 0;
  const currencyTotal = key => {
    const totals={};
    for (const row of rows) for (const [currency,amount] of Object.entries(row[key])) addCurrency(totals,currency,amount);
    return totals;
  };
  return {
    reps,rows,
    summary:{totalCustomers:rows.length,newCustomers:rows.filter(row=>!row.lastActivity).length,activeCustomers:rows.filter(row=>row.totalContractedMt>0).length,
      totalContractedMt:total,shippedMt:sum(rows,'shippedMt'),remainingMt:sum(rows,'remainingMt'),deliveryQueue:sum(rows,'deliveryQueue'),
      top1CustomerSharePct:share(rows[0]?.totalContractedMt||0),top3CustomersSharePct:share(sum(rows.slice(0,3),'totalContractedMt')),
      ...(finance?{contractValue:currencyTotal('contractValue'),ar:currencyTotal('ar'),overdueCustomers:rows.filter(row=>row.overdue).length}:{})},
    tiers:['S','A','B','C'].map(tier=>{
      const group=rows.filter(row=>row.tier===tier), mt=sum(group,'totalContractedMt');
      return {tier,count:group.length,mt,sharePct:share(mt)};
    }),
    grades:[['PET_GRADE','petGradeMt'],['FEED_GRADE','feedGradeMt']].map(([grade,key])=>({grade,count:rows.filter(row=>row[key]>0).length,mt:sum(rows,key),sharePct:share(sum(rows,key))}))
  };
}
