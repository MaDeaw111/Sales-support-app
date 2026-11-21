const periods = ['all','this_month','this_quarter','this_year'];
export const validAnalyticsPeriod = value => periods.includes(value);
const totals = () => ({activePosCount:0,contractedMt:0,paidShippedMt:0,unpaidShippedMt:0,remainingMt:0,earnedCommissionUsd:0,pendingCommissionUsd:0,forecastCommissionUsd:0,contractValueByCurrency:{}});
const rate = row => row.recipient === row.owner ? Number(row.rate || 0) : 0;
const cents = n => Math.round(n * 100) / 100;

export async function buildExternalSalesAnalytics(db, caller, {period='all',status='all',search=''}={}, now=new Date()) {
  const external = caller.role === 'EXTERNAL_SALES';
  if (external && !caller.user_id) throw new Error('Missing sales identity.');
  const ownerScope = external ? 'AND u.user_id = ?' : '';
  const query = async (sql, scoped=true) => {
    const statement = db.prepare(sql);
    return (await (external && scoped ? statement.bind(caller.user_id) : statement).all()).results || [];
  };
  const today = new Date(now.getTime()+7*3600000).toISOString().slice(0,10);
  const year = Number(today.slice(0,4)), month = Number(today.slice(5,7));
  const start = period==='this_month' ? month : period==='this_quarter' ? Math.floor((month-1)/3)*3+1 : 1;
  const span = period==='this_month' ? 1 : period==='this_quarter' ? 3 : 12;
  const iso = m => new Date(Date.UTC(year,m-1,1)).toISOString().slice(0,10);
  const inPeriod = date => period==='all' || Boolean(date && date>=iso(start) && date<iso(start+span));
  const gradeSql = "COALESCE(ss.application, cs.application, 'OTHER')";
  const joins = `LEFT JOIN standard_specs ss ON l.spec_source='STANDARD' AND ss.standard_spec_id=l.spec_revision_id
    LEFT JOIN customer_specs cs ON l.spec_source='CUSTOMER' AND cs.customer_spec_id=l.spec_revision_id`;
  const owners = `JOIN customers c ON c.customer_id=h.customer_id AND c.ownership_type='ASSIGNED_SALES'
    JOIN users u ON u.user_id=c.owner_user_id AND u.role='EXTERNAL_SALES'`;
  const effective = `JOIN po_revisions r ON r.revision_id=(SELECT revision_id FROM po_revisions
    WHERE po_id=h.po_id AND status IN ('ACTIVE','DRAFT') ORDER BY status='ACTIVE' DESC, revision_no DESC LIMIT 1)
    JOIN po_revision_lines l ON l.po_revision_id=r.revision_id`;
  const [directory, contracts, shipments, company, unassigned] = await Promise.all([
    query(`SELECT u.user_id AS owner,u.full_name,u.email,u.status,c.customer_id,c.customer_name
      FROM users u LEFT JOIN customers c ON c.owner_user_id=u.user_id AND c.ownership_type='ASSIGNED_SALES'
      WHERE u.role='EXTERNAL_SALES' ${ownerScope} ORDER BY u.full_name,c.customer_name`),
    query(`SELECT h.po_id,c.customer_id,u.user_id AS owner,r.customer_po_no,r.currency,
      COALESCE(NULLIF(r.po_date,''),substr(h.created_at,1,10)) AS date,
      l.product_id,l.contract_qty_mt AS qty,l.unit_price,l.commission_recipient_user_id AS recipient,
      l.commission_rate_usd_mt AS rate,${gradeSql} AS grade
      FROM po_headers h ${owners} ${effective} ${joins}
      WHERE h.header_status IN ('OPEN','PARTIALLY_SHIPPED') ${ownerScope}`),
    query(`SELECT h.po_id,c.customer_id,u.user_id AS owner,di.di_no,s.shipment_id,s.payment_status,
      COALESCE(s.actual_loading_date,(SELECT MAX(invoice_date) FROM shipment_invoices WHERE shipment_id=s.shipment_id AND version='FINAL')) AS date,
      l.product_id,l.commission_recipient_user_id AS recipient,l.commission_rate_usd_mt AS rate,${gradeSql} AS grade,
      COALESCE((SELECT SUM(cl.qty_mt) FROM shipment_container_lines cl JOIN shipment_containers sc ON sc.container_id=cl.container_id
        WHERE sc.shipment_id=s.shipment_id AND sc.status<>'CANCELLED' AND cl.delivery_instruction_line_id=dl.di_line_id),
        (SELECT SUM(il.qty_mt) FROM shipment_invoice_lines il JOIN shipment_invoices i ON i.invoice_id=il.invoice_id
        WHERE i.shipment_id=s.shipment_id AND i.version='FINAL' AND il.po_revision_line_id=l.line_id),0) AS qty,
      EXISTS(SELECT 1 FROM shipment_invoices WHERE shipment_id=s.shipment_id AND version='FINAL') AS final,
      COALESCE(s.cash_received_amount,0)+COALESCE((SELECT SUM(amount) FROM customer_credit_usages WHERE shipment_id=s.shipment_id),0) AS paid,
      COALESCE((SELECT SUM(il.line_amount) FROM shipment_invoice_lines il JOIN shipment_invoices i ON i.invoice_id=il.invoice_id
        WHERE i.shipment_id=s.shipment_id AND i.version='FINAL'),0) AS invoiced
      FROM po_headers h ${owners}
      JOIN delivery_instructions di ON di.po_id=h.po_id AND di.customer_id=c.customer_id AND di.status<>'CANCELLED'
      JOIN phase6_shipments s ON s.di_id=di.di_id AND s.status IN ('LOADED','DOCS_SENT','COMPLETED')
      JOIN delivery_instruction_lines dl ON dl.di_id=di.di_id
      JOIN po_revision_lines l ON l.line_id=dl.po_revision_line_id ${joins}
      WHERE h.header_status<>'CANCELLED' ${ownerScope}`),
    external ? [] : query(`SELECT COALESCE(NULLIF(r.po_date,''),substr(h.created_at,1,10)) AS date,l.contract_qty_mt AS qty
      FROM po_headers h ${effective} WHERE h.header_status IN ('OPEN','PARTIALLY_SHIPPED')`,false),
    external ? [] : query(`SELECT COUNT(*) AS count FROM customers c
      WHERE c.status='ACTIVE_CUSTOMER' AND NOT EXISTS(SELECT 1 FROM users u WHERE u.user_id=c.owner_user_id AND u.role='EXTERNAL_SALES' AND c.ownership_type='ASSIGNED_SALES')`,false)
  ]);
  const reps = new Map();
  for (const row of directory) {
    if (!reps.has(row.owner)) reps.set(row.owner,{id:row.owner,name:row.full_name,email:row.email,status:row.status,customers:[],...totals()});
    if (row.customer_id) reps.get(row.owner).customers.push({id:row.customer_id,name:row.customer_name,orders:[],shipments:[]});
  }
  const needle = search.trim().toLowerCase();
  const visible = [...reps.values()].filter(rep=>(status==='all' || (status==='active')===(rep.status==='ACTIVE'))
    && [rep.name,rep.email,...rep.customers.map(c=>c.name)].some(value=>String(value||'').toLowerCase().includes(needle)));
  const selected = new Map(visible.map(rep=>[rep.id,rep]));
  const grades = new Map(['FEED_GRADE','PET_GRADE'].map(grade=>[grade,{grade,contractedMt:0,shippedMt:0}]));
  const getGrade = grade => {
    if (!grades.has(grade)) grades.set(grade,{grade,contractedMt:0,shippedMt:0});
    return grades.get(grade);
  };
  const shipped = new Map();
  for (const row of shipments) {
    const key = JSON.stringify([row.po_id,row.product_id]);
    shipped.set(key,(shipped.get(key)||0)+row.qty);
    const rep = selected.get(row.owner);
    if (!rep || !row.qty || !inPeriod(row.date)) continue;
    const paid = Boolean(row.final && row.invoiced>0 && row.paid>0 && cents(row.paid)>=cents(row.invoiced));
    getGrade(row.grade).shippedMt += row.qty;
    const amount = row.qty*rate(row);
    if (paid) { rep.paidShippedMt+=row.qty; rep.earnedCommissionUsd+=amount; }
    else if (row.final) { rep.unpaidShippedMt+=row.qty; rep.pendingCommissionUsd+=amount; }
    rep.customers.find(c=>c.id===row.customer_id)?.shipments.push({diNo:row.di_no,qty:row.qty,paid,final:Boolean(row.final),rate:rate(row),earned:paid?cents(amount):0});
  }
  for (const row of contracts) {
    const rep = selected.get(row.owner);
    if (!rep || !inPeriod(row.date)) continue;
    const customer = rep.customers.find(c=>c.id===row.customer_id);
    let order = customer.orders.find(item=>item.id===row.po_id);
    if (!order) {
      order={id:row.po_id,reference:row.customer_po_no||row.po_id,qty:0,remaining:0};
      customer.orders.push(order);
      rep.activePosCount++;
    }
    const key=JSON.stringify([row.po_id,row.product_id]);
    const consumed=Math.min(row.qty,shipped.get(key)||0);
    shipped.set(key,(shipped.get(key)||0)-consumed);
    const remaining=row.qty-consumed;
    order.qty+=row.qty;
    order.remaining+=remaining;
    rep.contractedMt+=row.qty;
    rep.remainingMt+=remaining;
    rep.forecastCommissionUsd+=remaining*rate(row);
    rep.contractValueByCurrency[row.currency]=(rep.contractValueByCurrency[row.currency]||0)+row.qty*row.unit_price;
    getGrade(row.grade).contractedMt+=row.qty;
  }
  const summary=totals();
  for (const rep of visible) {
    for(const key of Object.keys(summary).filter(key=>key!=='contractValueByCurrency')) summary[key]+=rep[key];
    for(const [currency,amount] of Object.entries(rep.contractValueByCurrency)) summary.contractValueByCurrency[currency]=(summary.contractValueByCurrency[currency]||0)+amount;
  }
  const companyMt=company.filter(row=>inPeriod(row.date)).reduce((total,row)=>total+row.qty,0);
  return {
    summary:{...summary,activeReps:visible.filter(rep=>rep.status==='ACTIVE').length,assignedCustomers:visible.reduce((n,rep)=>n+rep.customers.length,0),
      ...(!external ? {unassignedCustomers:unassigned[0]?.count||0,companySharePct:companyMt?summary.contractedMt/companyMt*100:0} : {})},
    reps:visible.sort((a,b)=>b.contractedMt-a.contractedMt||a.name.localeCompare(b.name)),
    grades:[...grades.values()].map(item=>({...item,sharePct:summary.contractedMt?item.contractedMt/summary.contractedMt*100:0}))
  };
}
