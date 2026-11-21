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
