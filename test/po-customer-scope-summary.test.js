import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPORepository } from '../src/pos/repository.js';
import { createPOHandler } from '../src/pos/routes.js';
import { createCustomerRepository } from '../src/customers/repository.js';
import { createDashboardRepository } from '../src/dashboard/repository.js';

async function fixture(t) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    db.exec(await readFile(new URL(`../migrations/${file}`, import.meta.url), 'utf8'));
  }
  for (const [id, role] of [['ADMIN', 'ADMIN'], ['SIRA', 'EXTERNAL_SALES'], ['OTHER', 'EXTERNAL_SALES']]) {
    db.prepare('INSERT INTO users (user_id, full_name, email, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)').run(id, id, `${id}@example.com`, role, 'hash', 'salt');
  }
  for (const [id, owner] of [['MEELUNIE', 'SIRA'], ['OTHER', 'OTHER'], ['HOUSE', null]]) {
    db.prepare('INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES (?, ?, ?, ?)').run(id, id, id, owner);
  }
  db.exec("INSERT INTO product_categories (category_id, category_code, category_name, status) VALUES ('CAT','CAT','Category','ACTIVE'); INSERT INTO product_forms (form_id, form_code, form_name, status) VALUES ('FORM','FORM','Form','ACTIVE');");
  db.exec("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1','WCAT_PRO_009','Organic Tapioca Residue Pellet','Org_TRP','CAT','FORM');");
  db.exec("INSERT INTO product_applications (product_id, application) VALUES ('P1','FEED_GRADE');");
  db.exec("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('SPEC','P1','FEED_GRADE',0,'ACTIVE','2026-01-01');");
  const repo = createPORepository(db);
  const pos = [];
  for (const customerId of ['MEELUNIE', 'OTHER', 'HOUSE']) {
    const po = await repo.createDraftPO({ customerId, customerPoNo: customerId }, 'ADMIN');
    await repo.createPORevisionLine(po.revision.revision_id, { lineNo: 1, productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 540, unitPrice: 100, tolerancePct: 0, packaging: 'Bag', containerType: '20GP', loadingPattern: 'Palletized' }, 'ADMIN');
    db.prepare('UPDATE po_revisions SET sales_owner_user_id_snapshot = NULL WHERE revision_id = ?').run(po.revision.revision_id);
    pos.push(po);
  }
  const wrapped = { prepare(sql) { const s = db.prepare(sql); return { args: [], bind(...args) { this.args = args; return this; }, async first() { return s.get(...this.args) || null; }, async all() { return { results: s.all(...this.args) }; } }; } };
  const handler = createPOHandler({ repo, db, resolveUser: async () => ({ user_id: 'SIRA', role: 'EXTERNAL_SALES' }) });
  return { db, repo, pos, handler, wrapped };
}

test('external sales sees assigned customer Rev. 0 created by Admin without commission or owner snapshot', async t => {
  const { handler, pos, db } = await fixture(t);
  const response = await handler(new Request('https://test/api/pos'));
  const rows = (await response.json()).data.pos;
  assert.deepEqual(rows.map(p => p.header.po_id), [pos[0].header.po_id]);
  assert.equal(rows[0].revisions[0].revision_no, 0);
  assert.equal(rows[0].revisions[0].lines[0].commission_rate_usd_mt, undefined);
  assert.equal(rows[0].auditEvents, undefined);
  assert.equal((await handler(new Request(`https://test/api/pos/${pos[0].header.po_id}`))).status, 200);
  for (const po of pos.slice(1)) assert.equal((await handler(new Request(`https://test/api/pos/${po.header.po_id}`))).status, 403);
  db.prepare("UPDATE customers SET owner_user_id = 'OTHER' WHERE customer_id = 'MEELUNIE'").run();
  assert.equal((await handler(new Request(`https://test/api/pos/${pos[0].header.po_id}`))).status, 403);
});

test('PO API summarizes draft products and ordered tonnage and prefers active revision', async t => {
  const { handler, repo, pos, db } = await fixture(t);
  let detail = await repo.getPO(pos[0].header.po_id);
  assert.equal(detail.mainProductName, 'Organic Tapioca Residue Pellet');
  assert.equal(detail.mainProductShortName, 'Org_TRP');
  assert.equal(detail.mainProductCode, 'WCAT_PRO_009');
  assert.equal(detail.totalMt, 540);
  await repo.createPORevisionLine(pos[0].revision.revision_id, { lineNo: 2, productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 27.2, unitPrice: 100, tolerancePct: 0, packaging: 'Bag', containerType: '20GP', loadingPattern: 'Palletized' }, 'ADMIN');
  detail = (await (await handler(new Request('https://test/api/pos'))).json()).data.pos[0];
  assert.equal(detail.totalMt, 567.2);
  assert.equal(detail.additionalProductCount, 1);
  db.prepare("UPDATE po_revisions SET status = 'ACTIVE' WHERE revision_id = ?").run(pos[0].revision.revision_id);
  db.prepare('UPDATE po_headers SET current_active_revision_id = ?, current_draft_revision_id = NULL WHERE po_id = ?').run(pos[0].revision.revision_id, pos[0].header.po_id);
  const draft = await repo.createNextRevision(pos[0].header.po_id, 'ADMIN');
  db.prepare('UPDATE po_revision_lines SET contract_qty_mt = 999, min_qty_mt = 999, max_qty_mt = 999 WHERE po_revision_id = ?').run(draft.revision_id || draft.revision?.revision_id);
  assert.equal((await repo.getPO(pos[0].header.po_id)).totalMt, 567.2);
});

test('assigned customer filter and external dashboard include draft POs and exclude House Accounts', async t => {
  const { db, wrapped } = await fixture(t);
  const customers = createCustomerRepository(db);
  assert.deepEqual((await customers.listCustomers({ ownerUserId: 'SIRA' })).map(c => c.id), ['MEELUNIE']);
  const result = await createDashboardRepository(wrapped).getDashboardForCaller({ user_id: 'SIRA', role: 'EXTERNAL_SALES' });
  assert.equal(result.kpis.my_open_pos_count, 1);
  db.exec("UPDATE customers SET ownership_type = 'HOUSE_ACCOUNT' WHERE customer_id = 'MEELUNIE'");
  assert.deepEqual(await customers.listCustomers({ ownerUserId: 'SIRA' }), []);
});

test('PO summary falls back to a matching legacy header product when revision lines are absent', async t => {
  const { db, repo, pos } = await fixture(t);
  db.prepare('DELETE FROM po_revision_lines WHERE po_revision_id = ?').run(pos[0].revision.revision_id);
  db.prepare("INSERT INTO pos (po_id, customer_id, product_id, incoterm) VALUES (?, 'MEELUNIE', 'P1', 'FOB')").run(pos[0].header.po_id);
  assert.equal((await repo.getPO(pos[0].header.po_id)).mainProductName, 'Organic Tapioca Residue Pellet');
  db.prepare("UPDATE pos SET customer_id = 'OTHER' WHERE po_id = ?").run(pos[0].header.po_id);
  assert.equal((await repo.getPO(pos[0].header.po_id)).mainProductName, '');
});

for (const currency of ['USD', 'EUR']) {
  test(`POST PO atomically saves ${currency} draft line and packaging`, async t => {
    const { db, repo } = await fixture(t);
    const handler = createPOHandler({ repo, db, resolveUser: async () => ({ user_id: 'ADMIN', role: 'ADMIN' }) });
    const line = { productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 540, tolerancePct: 5, unitPrice: 185, packaging: 'Jumbo Bag', unitWeightKg: 850, unitsPerContainer: 32, containerType: '40HC', loadingPattern: 'Palletized' };
    const response = await handler(new Request('https://test/api/pos', { method: 'POST', body: JSON.stringify({ customerId: 'MEELUNIE', customerPoNo: `NEW-${currency}`, currency, incoterm: 'CFR', destination: 'Rotterdam', lines: [line] }) }));
    assert.equal(response.status, 200);
    const created = (await response.json()).data.po;
    const detail = await repo.getPO(created.header.po_id);
    assert.equal(detail.revisions[0].currency, currency);
    assert.equal(detail.revisions[0].lines.length, 1);
    assert.equal(detail.revisions[0].lines[0].currency, currency);
    assert.equal(detail.revisions[0].lines[0].unit_weight_kg, 850);
    assert.equal(detail.revisions[0].lines[0].units_per_container, 32);
    assert.equal(detail.revisions[0].lines[0].unit_price, 185);
    assert.equal(detail.totalMt, 540);
    assert.equal(detail.revisions[0].destination, 'Rotterdam');
    const count = db.prepare('SELECT COUNT(*) AS n FROM po_headers').get().n;
    await assert.rejects(repo.createDraftPO({ customerId: 'MEELUNIE', customerPoNo: 'BAD', currency, lines: [{ ...line, productId: 'MISSING' }] }, 'ADMIN'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM po_headers').get().n, count);
  });
}

test('external sales may create only assigned customer POs and cannot assign commissions', async t => {
  const { handler, db } = await fixture(t);
  const payload = { customerId: 'MEELUNIE', customerPoNo: 'OWN-NEW', currency: 'EUR', lines: [{ productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 27.2, tolerancePct: 0, unitPrice: 185, packaging: 'Bag', containerType: '40HC', loadingPattern: 'Palletized' }] };
  const send = data => handler(new Request('https://test/api/pos', { method: 'POST', body: JSON.stringify(data) }));
  assert.equal((await send(payload)).status, 200);
  assert.equal((await send({ ...payload, customerId: 'OTHER' })).status, 403);
  assert.equal((await send({ ...payload, customerId: 'HOUSE' })).status, 403);
  assert.equal((await send({ ...payload, lines: [{ ...payload.lines[0], commissionRateUsdMt: 20 }] })).status, 403);
  db.exec("UPDATE customers SET ownership_type = 'HOUSE_ACCOUNT' WHERE customer_id = 'MEELUNIE'");
  assert.equal((await send(payload)).status, 403);
});

test('legacy draft line editor saves EUR atomically and bypasses USD price notes', async t => {
  const { db, repo, pos } = await fixture(t);
  const revisionId = pos[0].revision.revision_id;
  db.prepare('DELETE FROM po_revision_lines WHERE po_revision_id = ?').run(revisionId);
  db.exec("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('USD-NOTE','SIRA','MEELUNIE','P1','FOB',350,'ADMIN')");
  const line = await repo.saveDraftRevisionLine(revisionId, null, { currency: 'EUR', productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 27.2, tolerancePct: 5, unitPrice: 185, packaging: 'Bag', unitWeightKg: 850, unitsPerContainer: 32, containerType: '40HC', loadingPattern: 'Palletized' }, 'ADMIN');
  assert.equal(line.currency, 'EUR');
  assert.equal(line.suggested_price, null);
  assert.equal(line.unit_price, 185);
  await assert.rejects(repo.saveDraftRevisionLine(revisionId, line.line_id, { currency: 'USD', unitPrice: -1 }, 'ADMIN'));
  assert.equal((await repo.getPO(pos[0].header.po_id)).revisions[0].currency, 'EUR');
  const edited = await repo.saveDraftRevisionLine(revisionId, line.line_id, { currency: 'EUR', unitPrice: 190, contractQtyMt: 540 }, 'ADMIN');
  assert.equal(edited.unit_price, 190);
  assert.equal(edited.unit_weight_kg, 850);
  assert.equal((await repo.getPO(pos[0].header.po_id)).totalMt, 540);
});

test('external PO creation cannot copy another customer contact snapshot', async t => {
  const { db, handler } = await fixture(t);
  db.exec("INSERT INTO customer_contacts (contact_id, customer_id, contact_name, email) VALUES ('FOREIGN-CONTACT','OTHER','Private Contact','private@example.com')");
  const response = await handler(new Request('https://test/api/pos', { method: 'POST', body: JSON.stringify({ customerId: 'MEELUNIE', customerPoNo: 'CONTACT-TEST', customerContactId: 'FOREIGN-CONTACT', currency: 'EUR', lines: [{ productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 1, tolerancePct: 0, unitPrice: 185 }] }) }));
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM po_revisions WHERE customer_po_no = 'CONTACT-TEST'").get().n, 0);
});

test('currency migration preserves sibling price provenance and cloned packaging', async t => {
  const { db, repo, pos } = await fixture(t);
  const revisionId = pos[0].revision.revision_id;
  db.exec("INSERT INTO manager_price_notes (note_id, sales_user_id, customer_id, product_id, incoterm, offer_price_usd_per_mt, created_by_manager_id) VALUES ('KEEP-NOTE','SIRA','MEELUNIE','P1','FOB',100,'ADMIN')");
  db.prepare("UPDATE po_revision_lines SET source_price_note_id = 'KEEP-NOTE', suggested_price = 100 WHERE po_revision_id = ?").run(revisionId);
  await repo.saveDraftRevisionLine(revisionId, null, { currency: 'USD', productId: 'P1', specSource: 'STANDARD', specRevisionId: 'SPEC', contractQtyMt: 10, tolerancePct: 0, unitPrice: 100, unitWeightKg: 850, unitsPerContainer: 32 }, 'ADMIN');
  const lines = (await repo.getPO(pos[0].header.po_id)).revisions[0].lines;
  assert.equal(lines[0].source_price_note_id, 'KEEP-NOTE');
  db.prepare("UPDATE po_revisions SET currency = 'EUR', status = 'ACTIVE' WHERE revision_id = ?").run(revisionId);
  db.prepare('UPDATE po_headers SET current_active_revision_id = ?, current_draft_revision_id = NULL WHERE po_id = ?').run(revisionId, pos[0].header.po_id);
  await repo.createNextRevision(pos[0].header.po_id, 'ADMIN');
  const draft = (await repo.getPO(pos[0].header.po_id)).revisions.find(r => r.status === 'DRAFT');
  assert.equal(draft.lines[1].currency, 'EUR');
  assert.equal(draft.lines[1].unit_weight_kg, 850);
  assert.equal(draft.lines[1].units_per_container, 32);
});

test('only ADMIN can delete unused POs and all PO attachments are cleaned from R2', async t => {
  const { db, repo, pos } = await fixture(t);
  const poId = pos[0].header.po_id;
  db.prepare("INSERT INTO document_attachments (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by) VALUES ('DOC-DELETE','PO',?,'PO','po.pdf','application/pdf',10,'po/file.pdf','ADMIN')").run(poId);
  let role = 'ADMIN';
  const deleted = [];
  const handler = createPOHandler({ repo, db, bucket: { delete: async keys => deleted.push(...keys) }, resolveUser: async () => ({ user_id: 'ADMIN', role }) });
  const request = () => new Request(`https://test/api/pos/${poId}`, { method: 'DELETE' });
  for (role of ['MANAGER', 'SALES_SUPPORT', 'EXPORT', 'PRODUCTION_WAREHOUSE', 'EXTERNAL_SALES']) assert.equal((await handler(request())).status, 403, role);
  assert.deepEqual(deleted, []);
  role = 'ADMIN';
  assert.equal((await handler(request())).status, 200);
  assert.deepEqual(deleted, ['po/file.pdf']);
  assert.equal(await repo.getPO(poId), null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM document_attachments WHERE entity_id = ?").get(poId).n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM po_revision_lines WHERE po_revision_id = ?').get(pos[0].revision.revision_id).n, 0);
});

test('deleting a used PO returns 409 and preserves attachments even for cancelled downstream records', async t => {
  const { db, repo, pos } = await fixture(t);
  const poId = pos[0].header.po_id;
  db.prepare("INSERT INTO delivery_instructions (di_id, customer_id, po_id, po_revision_id, di_no, shipping_month, shipping_period, container_plan, status, created_by) VALUES ('DI-USED','MEELUNIE',?,?,'DI-USED','2026-11','FIRST_HALF','1','CANCELLED','ADMIN')").run(poId, pos[0].revision.revision_id);
  db.exec("INSERT INTO phase6_shipments (shipment_id, di_id, status, cash_received_amount, payment_status, created_by) VALUES ('S-USED','DI-USED','CANCELLED',100,'PAID','ADMIN')");
  const handler = createPOHandler({ repo, db, bucket: { delete: async () => assert.fail('Used PO files must not be deleted') }, resolveUser: async () => ({ user_id: 'ADMIN', role: 'ADMIN' }) });
  const result = await handler(new Request(`https://test/api/pos/${poId}`, { method: 'DELETE' }));
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, 'PO_IN_USE');
  assert.ok(await repo.getPO(poId));
});

test('R2 deletion failures retain cleanup keys and an ADMIN retry finishes cleanup', async t => {
  const { db, repo, pos } = await fixture(t);
  const poId = pos[0].header.po_id;
  db.prepare("INSERT INTO document_attachments (id, entity_type, entity_id, doc_category, file_name, content_type, file_size, r2_key, uploaded_by) VALUES ('DOC-RETRY','PO',?,'PO','po.pdf','application/pdf',10,'po/retry.pdf','ADMIN')").run(poId);
  let fail = true;
  const handler = createPOHandler({ repo, db, bucket: { delete: async () => { if (fail) throw Error('R2 unavailable'); } }, resolveUser: async () => ({ user_id: 'ADMIN', role: 'ADMIN' }) });
  const request = () => new Request(`https://test/api/pos/${poId}`, { method: 'DELETE' });
  assert.equal((await handler(request())).status, 503);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM po_attachment_cleanup WHERE po_id = ?').get(poId).n, 1);
  fail = false;
  assert.equal((await handler(request())).status, 200);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM po_attachment_cleanup WHERE po_id = ?').get(poId).n, 0);
});

test('items aliases persist line logistics and commercial overrides', async t => {
  const { db, repo, pos } = await fixture(t);
  const poId = pos[0].header.po_id, revisionId = pos[0].revision.revision_id;
  const handler = createPOHandler({ repo, db, resolveUser: async () => ({ user_id: 'ADMIN', role: 'ADMIN' }) });
  const payload = { currency: 'EUR', productId: 'P1', contractQtyMt: 540, tolerancePct: 5, unitPrice: 185, packaging: 'Jumbo Bag 850 kg', unitWeightKg: 850, unitsPerContainer: 32, targetLoadWeightMt: 27.2, shipmentType: 'Container', containerType: '40HC', incoterm: 'CIF', destinationPort: 'Rotterdam' };
  const created = await handler(new Request(`https://test/api/pos/${poId}/revisions/${revisionId}/items`, { method: 'POST', body: JSON.stringify(payload) }));
  assert.equal(created.status, 200);
  const line = (await created.json()).data.line;
  assert.equal(line.incoterm, 'CIF');
  assert.equal(line.destination_port, 'Rotterdam');
  assert.equal(line.shipment_type, 'Container');
  assert.equal(line.target_load_weight_mt, 27.2);
  assert.equal(line.spec_revision_id, 'SPEC');
  const edited = await handler(new Request(`https://test/api/pos/${poId}/revisions/${revisionId}/items/${line.line_id}`, { method: 'PATCH', body: JSON.stringify({ ...payload, incoterm: 'EXW', destinationPort: 'Factory', unitsPerContainer: 30, targetLoadWeightMt: 25.5 }) }));
  assert.equal(edited.status, 200);
  const saved = (await repo.getPO(poId)).revisions[0].lines.find(l => l.line_id === line.line_id);
  assert.equal(saved.incoterm, 'EXW');
  assert.equal(saved.target_load_weight_mt, 25.5);
  assert.equal(saved.max_qty_mt, 567);
});

test('deleted PO numbers are never reused and cleanup retries preserve new POs', async t => {
  const {db,repo,pos}=await fixture(t);
  const poId=pos.at(-1).header.po_id;
  db.prepare("INSERT INTO document_attachments (id,entity_type,entity_id,doc_category,file_name,content_type,file_size,r2_key,uploaded_by) VALUES ('LAST','PO',?,'PO','x','application/pdf',1,'last/file','ADMIN')").run(poId);
  await repo.deleteUnusedPO(poId);
  const next=await repo.createDraftPO({customerId:'HOUSE',customerPoNo:'AFTER-DELETE'},'ADMIN');
  assert.notEqual(next.header.po_id,poId);
  assert.deepEqual(await repo.deleteUnusedPO(poId),['last/file']);
  await repo.finishPOFileCleanup(poId);
  await assert.rejects(repo.deleteUnusedPO(poId),{code:'PO_NOT_FOUND'});
  assert.ok(await repo.getPO(next.header.po_id));
});

test('initial PO logistics survive cloning and operational role projections exclude commission', async t => {
  const {db,repo}=await fixture(t);
  const created=await repo.createDraftPO({customerId:'MEELUNIE',customerPoNo:'LOGISTICS',currency:'EUR',destination:'Rotterdam',lines:[{productId:'P1',contractQtyMt:540,tolerancePct:5,unitPrice:185,packaging:'Jumbo Bag 850 kg',unitWeightKg:850,unitsPerContainer:32,shipmentType:'Container',containerType:'40HC',incoterm:'CIF',destinationPort:'Rotterdam',commissionRecipientUserId:'SIRA',commissionRateUsdMt:2}]},'ADMIN');
  const poId=created.header.po_id;
  const line=(await repo.getPO(poId)).revisions[0].lines[0];
  assert.equal(line.target_load_weight_mt,27.2);
  assert.equal(line.incoterm,'CIF');
  db.prepare("UPDATE po_revisions SET status='ACTIVE' WHERE revision_id=?").run(created.revision.revision_id);
  db.prepare('UPDATE po_headers SET current_active_revision_id=?,current_draft_revision_id=NULL WHERE po_id=?').run(created.revision.revision_id,poId);
  await repo.createNextRevision(poId,'ADMIN');
  const clone=(await repo.getPO(poId)).revisions.find(r=>r.status==='DRAFT').lines[0];
  assert.equal(clone.target_load_weight_mt,27.2);
  assert.equal(clone.destination_port,'Rotterdam');
  for(const role of ['EXPORT','PRODUCTION_WAREHOUSE']) {
    const handler=createPOHandler({repo,db,resolveUser:async()=>({user_id:'ADMIN',role})});
    const body=await (await handler(new Request(`https://test/api/pos/${poId}`))).json();
    const projected=body.data.po.revisions[0].lines[0];
    assert.equal(projected.incoterm,'CIF');
    assert.equal(projected.target_load_weight_mt,27.2);
    assert.equal(projected.commission_rate_usd_mt,undefined);
    assert.equal(projected.unit_price,undefined);
  }
  const admin=createPOHandler({repo,db,resolveUser:async()=>({user_id:'ADMIN',role:'ADMIN'})});
  assert.equal((await admin(new Request(`https://test/api/pos/${poId}`,{method:'DELETE'}))).status,409);
});

test('Admin can rediscover pending cleanup after reloading but other roles cannot', async t=>{
  const {db,repo,pos}=await fixture(t);
  const poId=pos[0].header.po_id;
  db.prepare("INSERT INTO po_attachment_cleanup (po_id,r2_key) VALUES (?,'pending/file')").run(poId);
  for(const role of ['ADMIN','MANAGER','EXTERNAL_SALES']) {
    const handler=createPOHandler({repo,db,resolveUser:async()=>({user_id:role==='EXTERNAL_SALES'?'SIRA':'ADMIN',role})});
    const body=await (await handler(new Request('https://test/api/pos'))).json();
    assert.deepEqual(body.data.pendingCleanupPoIds,role==='ADMIN'?[poId]:undefined);
  }
});

test('PO detail resolves specification and representative names without leaking other commissions',async t=>{
  const {db,repo,pos}=await fixture(t);
  db.exec("UPDATE users SET full_name='Sira Sales' WHERE user_id='SIRA'");
  db.prepare("UPDATE po_revision_lines SET commission_recipient_user_id='SIRA',commission_rate_usd_mt=2 WHERE po_revision_id=?").run(pos[0].revision.revision_id);
  const poId=pos[0].header.po_id;
  for(const role of ['ADMIN','EXTERNAL_SALES','EXPORT','PRODUCTION_WAREHOUSE']) {
    const handler=createPOHandler({repo,db,resolveUser:async()=>({user_id:role==='EXTERNAL_SALES'?'SIRA':'ADMIN',role})});
    const body=await (await handler(new Request(`https://test/api/pos/${poId}`))).json();
    const line=body.data.po.revisions[0].lines[0];
    assert.equal(line.spec_application,'FEED_GRADE');
    assert.equal(line.commission_recipient_name,['ADMIN','EXTERNAL_SALES'].includes(role)?'Sira Sales':undefined);
  }
});
