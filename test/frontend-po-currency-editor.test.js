import {semanticBadges} from './semantic-badge-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function load(ctx, name) {
  const start = Math.max(html.indexOf(`        function ${name}(`), html.indexOf(`        async function ${name}(`));
  assert.ok(start >= 0, name);
  const end = html.indexOf('\n        }', start) + '\n        }'.length;
  vm.runInContext(html.slice(start, end), ctx);
}
function harness() {
  const fields = {};
  const product = { id: 'P1', name: 'Organic Tapioca Residue Pellet', shortName: 'Org_TRP', code: 'WCAT_PRO_009', standardSpecs: [{ id: 'SPEC', application: 'FEED_GRADE', revisionNo: 0 }] };
  const ctx = vm.createContext({ ...semanticBadges, document: { getElementById: id => fields[id] || null }, state: { products: [product], pos: [{ header: { po_id: 'PO1', customer_id: 'C1', header_status: 'OPEN' }, revisions: [{ revision_id: 'REV0', status: 'DRAFT', revision_no: 0, currency: 'EUR', lines: [] }] }] }, canWritePO: () => true, t: (key, params) => key === 'po.sellingPriceCurrency' ? `Selling Price (${params.currency}/MT)` : key, getTodayIso: () => '2026-11-21', getSuggestedSellingPrice: () => ({ price: 350, source: 'STANDARD', reference: 'STD' }), openModal: text => { ctx.markup = text; }, closeModal() {}, loadPOsFromApi: async () => {}, fetch: async () => {} });
  for (const name of ['escapePricingHtml', 'poProductOptionLabel', 'renderPricingProduct', 'pricingProductSubtitle', 'updateNewPOPriceSuggestion', 'updateNewPOPriceWarning', 'openPODraftLineModal', 'savePODraftLine']) load(ctx, name);
  return { ctx, fields };
}
test('EUR manual price is unchanged by USD suggestion lookups', () => {
  const { ctx, fields } = harness();
  fields.newPoCurrency = { value: 'EUR' };
  fields.newPoPrice = { value: '185' };
  fields.newPoSuggestedPrice = {};
  fields.newPoPriceWarning = { classList: { add() {} } };
  ctx.getSuggestedSellingPrice = () => { throw Error('USD lookup must not run for EUR'); };
  ctx.updateNewPOPriceSuggestion();
  assert.equal(fields.newPoPrice.value, '185');
  assert.equal(fields.newPoPriceWarning.textContent, '');
});
test('empty legacy draft editor displays full product names and saves one currency-aware request', async () => {
  const { ctx, fields } = harness();
  ctx.openPODraftLineModal('PO1', 'REV0');
  assert.match(ctx.markup, /Organic Tapioca Residue Pellet — Org_TRP \[WCAT_PRO_009\]/);
  assert.match(ctx.markup, /Selling Price \(EUR\/MT\)/);
  for (const [id, value] of Object.entries({ draftLineProduct: 'P1', draftLineSpec: 'STANDARD:SPEC', draftLineCurrency: 'EUR', draftLinePrice: '185', draftLineQty: '540', draftLineTolerance: '5', draftLinePackaging: 'Jumbo Bag', draftLineWeight: '850', draftLineUnits: '32', draftLineReason: '' })) fields[id] = { value };
  fields.draftLineSave = {};
  fields.draftLineError = {};
  const calls = [];
  ctx.fetch = async (url, options) => { calls.push({ url, ...options }); return { ok: true, json: async () => ({ status: 'SUCCESS' }) }; };
  await ctx.savePODraftLine({ preventDefault() {} }, 'PO1', 'REV0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/pos/PO1/revisions/REV0/lines');
  assert.equal(calls[0].method, 'POST');
  const payload = JSON.parse(calls[0].body);
  assert.equal(payload.currency, 'EUR');
  assert.equal(payload.unitPrice, 185);
  assert.equal(payload.contractQtyMt, 540);
  assert.equal(payload.unitWeightKg, 850);
  assert.equal(ctx.state.selectedPoId, 'PO1');
});

test('Manage exposes line actions only for drafts and displays the saved EUR price', () => {
  const { ctx } = harness();
  load(ctx, 'renderRealPODetailCard');
  const po = ctx.state.pos[0];
  assert.match(ctx.renderRealPODetailCard(po), /openPODraftLineModal/);
  po.revisions[0].lines = [{ line_id: 'L1', line_no: 1, product_id: 'P1', contract_qty_mt: 540, unit_price: 185, min_qty_mt: 513, max_qty_mt: 567, packaging: 'Bag', currency: 'EUR' }];
  const output = ctx.renderRealPODetailCard(po);
  assert.match(output, /Organic Tapioca Residue Pellet/);
  assert.match(output, /EUR 185.00 \/ MT/);
  po.revisions[0].status = 'ACTIVE';
  assert.doesNotMatch(ctx.renderRealPODetailCard(po), /openPODraftLineModal/);
});

test('draft editor calculates ceiling and load weight and saves logistics', async () => {
  const {ctx, fields} = harness();
  load(ctx, 'recalcPODraftLine');
  load(ctx, 'updatePODraftPackaging');
  for (const [id,value] of Object.entries({draftLineQty:'540',draftLineTolerance:'5',draftLineWeight:'0',draftLineUnits:'32',draftLinePackaging:'Jumbo Bag 850 kg',draftLineTarget:'0'})) fields[id]={value};
  fields.draftLineCeiling={};
  fields.draftLinePackagingCustom={classList:{toggle(){}}};
  ctx.updatePODraftPackaging();
  assert.equal(Number(fields.draftLineTarget.value),27.2);
  assert.equal(Number(fields.draftLineCeiling.value),567);
  ctx.openPODraftLineModal('PO1','REV0');
  for(const id of ['draftLineShipment','draftLineContainer','draftLineIncoterm','draftLineDestination','draftLineTarget']) assert.ok(ctx.markup.includes(id));
  fields.draftLineSpec={value:'STANDARD:SPEC'};
  fields.draftLineIncoterm={value:'CIF'};
  fields.draftLineDestination={value:'Rotterdam'};
  fields.draftLineShipment={value:'Container'};
  fields.draftLineContainer={value:"40' HC"};
  let payload;
  ctx.fetch=async(url,options)=>{payload=JSON.parse(options.body);return {ok:true,json:async()=>({status:'SUCCESS'})};};
  await ctx.savePODraftLine({preventDefault(){}},'PO1','REV0');
  assert.equal(payload.incoterm,'CIF');
  assert.equal(payload.destinationPort,'Rotterdam');
  assert.equal(payload.targetLoadWeightMt,27.2);
  assert.equal(payload.shipmentType,'Container');
});

test('Manage renders logistics and limits delete and commission controls',()=>{
  const {ctx}=harness();
  load(ctx,'renderRealPODetailCard');
  ctx.state.currentUser={role:'ADMIN'};
  const po=ctx.state.pos[0];
  po.revisions[0].lines=[{line_id:'L1',product_id:'P1',incoterm:'EXW',destination_port:'Factory',shipment_type:'Container',container_type:"40 HC",packaging:'Jumbo Bag 850 kg',unit_weight_kg:850,units_per_container:32,target_load_weight_mt:27.2,tolerance_pct:5,max_qty_mt:567,commission_recipient_user_id:'REP',commission_recipient_name:'Representative Name',commission_rate_usd_mt:2}];
  const output=ctx.renderRealPODetailCard(po);
  for(const value of ['EXW','Factory','27.2','850','567','Representative Name','USD 2','openPODeleteModal']) assert.ok(output.includes(value),value);
  ctx.state.currentUser={role:'EXPORT'};
  delete po.revisions[0].lines[0].commission_rate_usd_mt;
  assert.doesNotMatch(ctx.renderRealPODetailCard(po),/openPODeleteModal|USD 2/);
});

test('deletion confirmation and cleanup retry are restricted to Admin',async()=>{
  const {ctx,fields}=harness();
  load(ctx,'openPODeleteModal');load(ctx,'deleteUnusedPOFromUi');
  ctx.state.currentUser={role:'MANAGER'};
  ctx.openPODeleteModal('PO1');assert.equal(ctx.markup,undefined);
  let calls=0;ctx.fetch=async()=>{calls++;return {ok:false,json:async()=>({code:'PO_DELETE_CLEANUP_PENDING'})};};
  await ctx.deleteUnusedPOFromUi('PO1');assert.equal(calls,0);
  ctx.state.currentUser.role='ADMIN';ctx.state.customers=[{id:'C1',name:'Customer One'}];
  ctx.t=(key,params)=>params?`${key}: ${params.po} ${params.customer}`:key;
  ctx.openPODeleteModal('PO1');assert.match(ctx.markup,/PO1 Customer One/);
  await ctx.deleteUnusedPOFromUi('PO1');assert.equal(ctx.state.poDeletePendingId,'PO1');
  assert.equal(ctx.state.poNotice.message,'po.deletePending');
  ctx.fetch=async()=>({ok:true,json:async()=>({status:'SUCCESS'})});
  await ctx.deleteUnusedPOFromUi('PO1');assert.equal(ctx.state.poDeletePendingId,null);
  assert.equal(ctx.state.poNotice.message,'po.deleteSuccess');
});

test('changing draft product selects its active specification',()=>{
  const {ctx,fields}=harness();load(ctx,'updatePODraftLineSpecs');
  fields.draftLineProduct={value:'P1'};fields.draftLineSpec={value:''};
  ctx.updatePODraftLineSpecs();assert.equal(fields.draftLineSpec.value,'STANDARD:SPEC');
});

test('Manage uses clean labels, named references, totals and three-column logistics panels',()=>{
  const {ctx}=harness();load(ctx,'renderRealPODetailCard');
  ctx.state.currentUser={role:'ADMIN'};
  ctx.t=key=>({'po.fieldCustPoNo':'Customer PO No. *','po.fieldPoDate':'PO Date *','po.fieldProductSpec':'Product & Spec *','po.fieldShipType':'Shipment Type *'}[key]||key);
  const po=ctx.state.pos[0];
  po.revisions[0].lines=[{line_id:'L1',line_no:1,product_id:'P1',spec_revision_id:'STD-016',spec_application:'FEED_GRADE',contract_qty_mt:50,min_qty_mt:47.5,max_qty_mt:52.5,unit_price:185,incoterm:'CIF',tolerance_pct:5,commission_recipient_user_id:'USR-0008',commission_recipient_name:'Sira',commission_rate_usd_mt:2,price_override_reason:'Agreed EUR rate'}];
  const output=ctx.renderRealPODetailCard(po);
  assert.doesNotMatch(output,/\*|50\.000|USR-0008/);
  assert.match(output,/50 MT/);assert.match(output,/EUR 9,250\.00/);
  assert.match(output,/FEED_GRADE \(STD-016\)/);assert.match(output,/Sira/);
  assert.match(output,/data-po-line-details/);assert.match(output,/md:grid-cols-3/);
  assert.match(output,/Agreed EUR rate/);assert.match(output,/border-red-200/);
  delete po.revisions[0].lines[0].unit_price;
  delete po.revisions[0].lines[0].commission_rate_usd_mt;
  delete po.revisions[0].lines[0].commission_recipient_name;
  ctx.state.currentUser.role='EXPORT';
  const restricted=ctx.renderRealPODetailCard(po);
  assert.doesNotMatch(restricted,/EUR 9,250|Sira|openPODeleteModal/);
});

test('Manage respects a cleared line destination and formats fractional USD line totals',()=>{
  const {ctx}=harness();load(ctx,'renderRealPODetailCard');
  const po=ctx.state.pos[0];po.revisions[0].currency='USD';po.revisions[0].destination='Old Port';
  po.revisions[0].lines=[{line_id:'L1',line_no:1,product_id:'P1',contract_qty_mt:27.2,unit_price:100,incoterm:'EXW',destination_port:''}];
  const output=ctx.renderRealPODetailCard(po);
  assert.doesNotMatch(output,/Old Port/);assert.match(output,/27.2 MT/);assert.match(output,/USD 2,720.00/);
});

test('Manage prioritizes customer contract number with a bilingual system PO subtitle',()=>{
  const {ctx}=harness();load(ctx,'renderRealPODetailCard');
  const po=ctx.state.pos[0];po.header.po_id='PO-2025-005';po.revisions[0].customer_po_no='b10212151';
  for(const label of ['System PO','เลขที่ PO ระบบ']) {
    ctx.t=key=>key==='po.systemPo'?label:key;
    const output=ctx.renderRealPODetailCard(po);
    assert.match(output,/<h3[^>]*>b10212151<\/h3>/);
    assert.ok(output.includes(`${label}: PO-2025-005`));
  }
  po.revisions[0].customer_po_no=' ';
  assert.match(ctx.renderRealPODetailCard(po),/<h3[^>]*>PO-2025-005<\/h3>/);
});
