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
  const ctx = vm.createContext({ document: { getElementById: id => fields[id] || null }, state: { products: [product], pos: [{ header: { po_id: 'PO1', customer_id: 'C1', header_status: 'OPEN' }, revisions: [{ revision_id: 'REV0', status: 'DRAFT', revision_no: 0, currency: 'EUR', lines: [] }] }] }, canWritePO: () => true, t: (key, params) => key === 'po.sellingPriceCurrency' ? `Selling Price (${params.currency}/MT)` : key, getTodayIso: () => '2026-11-21', getSuggestedSellingPrice: () => ({ price: 350, source: 'STANDARD', reference: 'STD' }), openModal: text => { ctx.markup = text; }, closeModal() {}, loadPOsFromApi: async () => {}, fetch: async () => {} });
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
