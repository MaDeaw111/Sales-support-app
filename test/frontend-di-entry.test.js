import {semanticBadges} from './semantic-badge-fixture.js';
import test from 'node:test';import assert from 'node:assert/strict';import vm from 'node:vm';import {readFile} from 'node:fs/promises';
const html=await readFile(new URL('../public/index.html',import.meta.url),'utf8');
function load(ctx,name){const start=Math.max(html.indexOf(`        function ${name}(`),html.indexOf(`        async function ${name}(`));assert.ok(start>=0,name);vm.runInContext(html.slice(start,html.indexOf('\n        }',start)+'\n        }'.length),ctx);}
function harness(){const fields={phase6ContainerError:{},phase6InvoiceError:{},phase6ContainerSummary:{},phase6InvoiceTotal:{},phase6ContainerRows:{}};const calls=[];const shipment={shipment_id:'S1',status:'BOOKED',products:[{po_revision_line_id:'L1',product_name:'Organic Tapioca Pellet',product_code:'WCAT009',spec_application:'FEED_GRADE',unit_weight_kg:850,unit_price:185,currency:'EUR',planned_qty_mt:54.4}],containers:[]};const ctx=vm.createContext({ ...semanticBadges, state:{phase6ShipmentDetail:shipment,selectedPhase6DeliveryInstructionId:'D1'},document:{getElementById:id=>fields[id],querySelectorAll:()=>[]},t:key=>key,canEditPhase6Shipping:()=>true,selectPhase6DeliveryInstruction:async()=>{},updatePhase6ShipmentSectionToApi:async(id,section,payload)=>calls.push({id,section,payload}),fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({status:'SUCCESS'})};}});
for(const name of ['bindPhase6EntryForms','escapePhase6Text','phase6EntryText','getPhase6EntryDraft','renderPhase6ContainerRows','renderPhase6ContainerForm','renderPhase6InvoiceForm','changePhase6ContainerRow','addPhase6ContainerRow','removePhase6ContainerRow','updatePhase6EntryTotals','collectPhase6Containers','collectPhase6InvoiceLines','phase6EntryError','setPhase6EntryBusy','submitPhase6Containers','submitPhase6Invoice','finalizePhase6Invoice'])load(ctx,name);return {ctx,fields,calls,shipment};}
test('visual container builder estimates editable weight and serializes API containers',async()=>{const {ctx,fields,calls}=harness();const markup=ctx.renderPhase6ContainerForm();assert.doesNotMatch(markup,/<textarea|JSON/);assert.match(markup,/Organic Tapioca Pellet/);ctx.changePhase6ContainerRow(0,'containerNo','MSKU1234567');ctx.changePhase6ContainerRow(0,'sealNo','SL998877');ctx.changePhase6ContainerRow(0,'numberOfBags','32');let draft=ctx.getPhase6EntryDraft();assert.equal(draft.rows[0].netWeightMt,27.2);ctx.changePhase6ContainerRow(0,'netWeightMt','27.1');ctx.addPhase6ContainerRow();assert.equal(draft.rows.length,2);ctx.removePhase6ContainerRow(1);await ctx.submitPhase6Containers('S1');assert.equal(calls.length,1);assert.deepEqual(JSON.parse(JSON.stringify(calls[0].payload)),{containers:[{containerNo:'MSKU1234567',sealNo:'SL998877',lines:[{poRevisionLineId:'L1',numberOfBags:32,netWeightMt:27.1}]}]});assert.match(fields.phase6ContainerSummary.innerHTML,/27.1/);});
test('invoice form prefills loaded quantity, calculates EUR totals, saves and finalizes structured lines',async()=>{const {ctx,fields,calls,shipment}=harness();shipment.containers=[{container_no:'C1',seal_no:'S1',lines:[{po_revision_line_id:'L1',number_of_bags:32,qty_mt:27.2}]}];const markup=ctx.renderPhase6InvoiceForm();assert.doesNotMatch(markup,/<textarea|JSON/);assert.match(markup,/EUR 5,032.00/);const draft=ctx.getPhase6EntryDraft();assert.equal(draft.quantities[0],27.2);fields.phase6InvoiceQty0={value:'20'};fields.phase6InvoiceAmount0={};ctx.updatePhase6EntryTotals();assert.match(fields.phase6InvoiceTotal.textContent,/EUR 3,700.00/);fields.phase6InvoiceNo={value:'INV1'};fields.phase6InvoiceDate={value:'2026-11-21'};fields.phase6InvoiceVersion={value:'PRELIMINARY'};await ctx.submitPhase6Invoice('S1');assert.equal(JSON.parse(calls[0].options.body).lines[0].qtyMt,20);await ctx.finalizePhase6Invoice('S1','I1');assert.equal(calls[1].url,'/api/shipments-v2/S1/invoices/I1/finalize');assert.deepEqual(JSON.parse(calls[1].options.body),{lines:[{poRevisionLineId:'L1',qtyMt:20}]});});
test('existing multiline containers retain lineage and invalid or empty forms never submit',async()=>{const {ctx,calls,shipment,fields}=harness();shipment.products.push({...shipment.products[0],po_revision_line_id:'L2'});shipment.containers=[{container_no:'C1',seal_no:'S1',lines:[{po_revision_line_id:'L1',number_of_bags:1,qty_mt:1},{po_revision_line_id:'L2',number_of_bags:2,qty_mt:2}]}];ctx.renderPhase6ContainerForm();assert.equal(ctx.collectPhase6Containers()[0].lines.length,2);ctx.changePhase6ContainerRow(0,'numberOfBags','-1');await ctx.submitPhase6Containers('S1');assert.equal(calls.length,0);assert.ok(fields.phase6ContainerError.textContent);fields.phase6InvoiceQty0={value:'0'};fields.phase6InvoiceQty1={value:'0'};await ctx.finalizePhase6Invoice('S1','I1');assert.equal(calls.length,0);assert.ok(fields.phase6InvoiceError.textContent);});

test('DI Detail renders guided forms without JSON controls and retains role restrictions',async()=>{
  const {ctx,calls}=harness();load(ctx,'renderPhase6DeliveryInstructionDetail');ctx.phase6PartnerOptions=()=>'';ctx.state.currentUser={role:'ADMIN'};
  let output=ctx.renderPhase6DeliveryInstructionDetail({di_id:'D1',di_no:'DI-1',di_status:'IN_PROGRESS'});
  assert.match(output,/phase6ContainerRows/);assert.match(output,/phase6InvoiceQty0/);assert.doesNotMatch(output,/phase6ContainersJson|phase6InvoiceLines|<textarea|onclick=|oninput=/);
  ctx.canEditPhase6Shipping=()=>false;ctx.state.currentUser.role='EXTERNAL_SALES';output=ctx.renderPhase6DeliveryInstructionDetail({di_id:'D1',di_no:'DI-1'});assert.doesNotMatch(output,/phase6ContainerRows|phase6InvoiceQty0/);await ctx.submitPhase6Containers('S1');await ctx.submitPhase6Invoice('S1');assert.equal(calls.length,0);
});

test('delegated container inputs update weights and failed saves keep entered rows',async()=>{
  const {ctx,fields,calls}=harness();ctx.renderPhase6ContainerForm();const listeners={};
  const input={tagName:'INPUT',dataset:{phase6ContainerIndex:'0',phase6ContainerField:'numberOfBags'},value:'10',addEventListener:(event,fn)=>{listeners[event]=fn;}};
  ctx.bindPhase6EntryForms({querySelectorAll:selector=>selector==='[data-phase6-container-field]'?[input]:[]});listeners.input();assert.equal(ctx.getPhase6EntryDraft().rows[0].netWeightMt,8.5);
  ctx.changePhase6ContainerRow(0,'containerNo','C1');ctx.updatePhase6ShipmentSectionToApi=async()=>{throw Error('CONTAINER_LINE_QTY_EXCEEDS_PLANNED');};await ctx.submitPhase6Containers('S1');assert.equal(fields.phase6ContainerError.textContent,'shipping.entryBalanceError');assert.equal(ctx.getPhase6EntryDraft().rows[0].containerNo,'C1');assert.equal(ctx.getPhase6EntryDraft().busy,false);
});

test('invoice preview totals match backend aggregation before currency rounding',()=>{
  const {ctx,shipment,fields}=harness();shipment.products=[{...shipment.products[0],unit_price:1,currency:'USD',planned_qty_mt:0.006},{...shipment.products[0],po_revision_line_id:'L2',unit_price:1,currency:'USD',planned_qty_mt:0.006}];
  assert.match(ctx.renderPhase6InvoiceForm(),/id="phase6InvoiceTotal">USD 0.01</);
  ctx.updatePhase6EntryTotals();assert.equal(fields.phase6InvoiceTotal.textContent,'USD 0.01');
});

test('recorded preliminary invoices use the primary green finalize button', () => {
  const {ctx}=harness();
  load(ctx,'renderPhase6DeliveryInstructionDetail');
  ctx.phase6PartnerOptions=()=> '';
  ctx.state.currentUser={role:'EXPORT'};
  ctx.state.phase6ShipmentInvoices=[
    {invoice_id:'PRE1',invoice_no:'WCAT014',version:'PRELIMINARY',total_amount:18000,currency:'USD'},
    {invoice_id:'FIN1',invoice_no:'WCAT015',version:'FINAL'}
  ];
  const render=()=>ctx.renderPhase6DeliveryInstructionDetail({di_id:'D1',di_status:'IN_PROGRESS'});
  const output=render();
  assert.match(output,/<button[^>]*data-phase6-action="finalize-invoice"[^>]*data-phase6-invoice-id="PRE1"[^>]*class="di-invoice-finalize/);
  assert.doesNotMatch(output,/data-phase6-invoice-id="FIN1"/);
  assert.match(output,/WCAT014[\s\S]*semantic-amber/);
  assert.match(output,/WCAT015[\s\S]*semantic-green/);
  assert.match(html,/\.di-invoice-finalize\s*\{[^}]*background: #15803d;[^}]*border: 1px solid #14532d;[^}]*color: #ffffff;/);
  assert.match(html,/\.di-invoice-finalize:hover:not\(:disabled\)\s*\{\s*background: #166534;/);
  ctx.canEditPhase6Shipping=()=>false;
  assert.doesNotMatch(render(),/data-phase6-action="finalize-invoice"/);
});

test('DI schedule shows a pending badge and two aligned date rows',()=>{
  const {ctx,shipment}=harness();
  load(ctx,'renderPhase6DeliveryInstructionDetail');
  ctx.phase6PartnerOptions=()=> '';
  ctx.state.currentUser={role:'ADMIN'};
  Object.assign(shipment,{planned_loading_date:'2026-01-22',planned_loading_end_date:'2026-01-24',actual_loading_date:null,schedule_result:'OUT_OF_PLAN'});
  const render=()=>ctx.renderPhase6DeliveryInstructionDetail({di_id:'D1',di_status:'IN_PROGRESS'});
  const output=render();
  assert.match(output,/2026-01-22 – 2026-01-24/);
  assert.match(output,/semantic-slate">PENDING/);
  assert.match(output,/data-schedule-row="planned"[\s\S]*phase6PlannedLoadingUpdate[\s\S]*phase6PlannedLoadingEnd[\s\S]*data-phase6-schedule-kind="planned"/);
  assert.match(output,/data-schedule-row="actual"[\s\S]*shipping.actualLoadingDate[\s\S]*phase6ActualLoading[\s\S]*phase6ScheduleNote[\s\S]*data-phase6-schedule-kind="actual"/);
  shipment.actual_loading_date='2026-01-22';
  shipment.schedule_result='ON_PLAN';
  assert.match(render(),/semantic-green">ON PLAN/);
});

test('semantic pills normalize status aliases and use the exact pastel palette',()=>{
  const {renderSemanticStatusBadge,getStatusBadgeStyle}=semanticBadges;
  for(const [status,tone] of [['ON PLAN','green'],['OUT OF PLAN','red'],['OUT PLAN','red'],['UNPAID','red'],['DOCS SENT','indigo'],['PAID','green'],['LOADED','sky'],['PRELIM INV','amber'],['DRAFT','slate']]){
    assert.match(renderSemanticStatusBadge(status),new RegExp('semantic-badge semantic-'+tone));
  }
  assert.equal(getStatusBadgeStyle('DOCS_READY',2),'semantic-badge semantic-teal');
  assert.equal(getStatusBadgeStyle('DOCS_READY',0),'semantic-badge semantic-slate');
  assert.match(html,/\.semantic-green \{ background: #dcfce7; color: #166534; border-color: #bbf7d0;/);
  assert.match(html,/\.semantic-red \{ background: #fee2e2; color: #991b1b; border-color: #fecaca;/);
  assert.match(html,/\.semantic-indigo \{ background: #ede9fe; color: #5b21b6; border-color: #ddd6fe;/);
  assert.match(renderSemanticStatusBadge('PAID','<Paid>'),/&lt;Paid&gt;/);
});
