import {semanticBadges} from './semantic-badge-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
function context() {
  const product = { id: 'P1', name: 'Organic Tapioca Residue Pellet', shortName: 'Org_TRP', code: 'WCAT_PRO_009', status: 'ACTIVE' };
  const ctx = vm.createContext({ ...semanticBadges, state: { currentUser: { id: 'SIRA', role: 'EXTERNAL_SALES' }, products: [product], customers: [{ id: 'C1', name: 'MEELUNIE B.V.', ownerId: 'SIRA', ownershipType: 'ASSIGNED_SALES' }], pos: [], standardPrices: [], specialPrices: [{ id: 'SP1', customerId: 'C1', productId: 'P1' }], priceNotes: [{ id: 'PN1', customer_id: 'C1', product_id: 'P1' }], adminUsers: [] }, lucide: { createIcons() {} }, canWritePO: () => false, canManagePricing: () => true, getTodayIso: () => '2026-11-21', getSalesUsers: () => [], openModal: value => { ctx.modal = value; } });
  for (const name of ['escapePricingHtml', 'pricingProductSubtitle', 'pricingProductOptionLabel', 'renderPricingProduct', 'getPoProductSummary', 'getScopedCustomers', 'getScopedPOs', 'getScopedDIRecords', 'getScopedShipments', 'pricingStatusBadge', 'renderRealPOListTable', 'renderPricing', 'openEditStandardPrice', 'openRequestSpecialPrice', 'openAddPriceNoteModal']) {
    const start = html.indexOf(`        function ${name}(`);
    if (start < 0) continue;
    const end = html.indexOf('\n        }', start) + '\n        }'.length;
    vm.runInContext(html.slice(start, end), ctx);
  }
  return ctx;
}
test('PO list renders Rev. 0 full product title, subtitle, tonnage and assigned customer filter', () => {
  const ctx = context();
  ctx.state.pos = [{ header: { po_id: 'PO1', customer_id: 'C1' }, revisions: [{ status: 'DRAFT', revision_no: 0, lines: [{ product_id: 'P1', contract_qty_mt: 540 }] }] }];
  let output = ctx.renderRealPOListTable();
  assert.match(output, /font-bold[^>]*>Organic Tapioca Residue Pellet</);
  assert.match(output, /Org_TRP \(WCAT_PRO_009\)/);
  assert.match(output, /540(?:\.0)? MT/);
  assert.match(output, /id="poCustomerFilter"/);
  assert.match(output, /value="C1"[^>]*>MEELUNIE B.V./);
  for (const search of ['Organic Tapioca', 'Org_TRP', 'WCAT_PRO_009']) {
    ctx.state.poFilters = { search, customerId: 'ALL', status: 'ALL' };
    assert.match(ctx.renderRealPOListTable(), /selectedPoId='PO1'/);
  }
});
test('PO list can render server summary without loading product master and preserves decimal totals', () => {
  const ctx = context();
  ctx.state.products = [];
  ctx.state.pos = [{ header: { po_id: 'PO1', customer_id: 'C1' }, mainProductName: 'Organic Tapioca Residue Pellet', mainProductShortName: 'Org_TRP', mainProductCode: 'WCAT_PRO_009', additionalProductCount: 1, totalMt: 27.2, revisions: [{ status: 'DRAFT', revision_no: 0, lines: [] }] }];
  const output = ctx.renderRealPOListTable();
  assert.match(output, /Organic Tapioca Residue Pellet/);
  assert.match(output, /27\.2 MT/);
  assert.match(output, /\+1 more/);
});
test('Pricing tables and set price modal use full title followed by short name and code', () => {
  const ctx = context();
  for (const tab of ['STANDARD', 'SPECIAL', 'PRICE_NOTES']) {
    ctx.state.pricingTab = tab;
    const container = {};
    ctx.renderPricing(container);
    assert.match(container.innerHTML, /font-bold[^>]*>Organic Tapioca Residue Pellet</, tab);
    assert.match(container.innerHTML, /text-\[10px\][^>]*>Org_TRP \(WCAT_PRO_009\)</, tab);
  }
  ctx.openEditStandardPrice('P1');
  assert.match(ctx.modal, /font-bold[^>]*>Organic Tapioca Residue Pellet</);
  assert.match(ctx.modal, /Org_TRP \(WCAT_PRO_009\)/);
});
test('Pricing request dropdown uses full name first and code-only subtitle when short name is empty', () => {
  const ctx = context();
  ctx.openRequestSpecialPrice();
  assert.match(ctx.modal, /Organic Tapioca Residue Pellet — Org_TRP \(WCAT_PRO_009\)/);
  ctx.state.products[0].shortName = '';
  ctx.openRequestSpecialPrice();
  assert.match(ctx.modal, /Organic Tapioca Residue Pellet — WCAT_PRO_009</);
});

test('draft POs feed customer-scoped dashboard and shipment adapters', () => {
  const ctx = context();
  ctx.state.pos = ['C1', 'C2', 'HOUSE'].map((customerId, i) => ({ header: { po_id: `PO${i}`, customer_id: customerId }, revisions: [{ status: 'DRAFT', revision_no: 0, lines: [{ product_id: 'P1', contract_qty_mt: 540 }] }] }));
  ctx.state.diRecords = [0, 1, 2].map(i => ({ id: `DI${i}`, poId: `PO${i}` }));
  ctx.state.shipments = [0, 1, 2].map(i => ({ id: `S${i}`, poId: `PO${i}` }));
  assert.deepEqual(Array.from(ctx.getScopedPOs(), p => p.id), ['PO0']);
  assert.deepEqual(Array.from(ctx.getScopedDIRecords(), p => p.id), ['DI0']);
  assert.deepEqual(Array.from(ctx.getScopedShipments(), p => p.id), ['S0']);
});

test('PO list prioritizes customer contract number and searches both identifiers',()=>{
  const ctx=context();
  ctx.state.pos=[{header:{po_id:'PO-2025-009',customer_id:'C1'},revisions:[{status:'DRAFT',revision_no:0,customer_po_no:'1606',po_date:'2025-12-10',lines:[]}]}];
  for(const search of ['1606','PO-2025-009']) {
    ctx.state.poFilters={search,customerId:'ALL',status:'ALL'};
    const output=ctx.renderRealPOListTable();
    assert.match(output,/font-bold text-blue-600[^>]*>1606<\/button>/);
    assert.match(output,/text-\[10px\][^>]*>PO-2025-009 · 2025-12-10<\/div>/);
  }
  ctx.state.poFilters.search='';
  ctx.state.pos[0].revisions[0].customer_po_no='   ';
  assert.match(ctx.renderRealPOListTable(),/font-bold text-blue-600[^>]*>PO-2025-009<\/button>/);
  ctx.state.pos[0].revisions[0].customer_po_no='<Contract & One>';
  assert.match(ctx.renderRealPOListTable(),/&lt;Contract &amp; One&gt;/);
});
