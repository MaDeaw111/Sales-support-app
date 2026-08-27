import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createPORepository } from '../src/pos/repository.js';
import { createPOHandler } from '../src/pos/routes.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);
  const productSpecsSql = await readFile(new URL('../migrations/0003_product_specs.sql', import.meta.url), 'utf8');
  db.exec(productSpecsSql);
  const commercialSql = await readFile(new URL('../migrations/0004_commercial_shipment_control.sql', import.meta.url), 'utf8');
  db.exec(commercialSql);
  const poSql = await readFile(new URL('../migrations/0005_po_management.sql', import.meta.url), 'utf8');
  db.exec(poSql);
  const ownSql = await readFile(new URL('../migrations/0006_customer_ownership_type.sql', import.meta.url), 'utf8');
  db.exec(ownSql);
  return db;
}

// Helper to mock request and env
function mockRequest(method, path, body = null, headers = {}) {
  return {
    method,
    url: `http://localhost${path}`,
    headers: new Headers({
      'content-type': 'application/json',
      ...headers
    }),
    json: async () => body
  };
}

test('PO Management API Endpoints & RBAC Integration', async () => {
  const db = await setupTestDb();

  // Seed reference data
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_SALES', 'sales@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Guy', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_SALES_OTHER', 'sales2@example.com', 'EXTERNAL_SALES', 'ACTIVE', 'Sales Guy 2', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_SUPPORT', 'support@example.com', 'SALES_SUPPORT', 'ACTIVE', 'Support Person', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_MANAGER', 'manager@example.com', 'MANAGER', 'ACTIVE', 'Manager', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_EXPORT', 'export@example.com', 'EXPORT', 'ACTIVE', 'Exporter', 'hash', 'salt')").run();
  db.prepare("INSERT INTO users (user_id, email, role, status, full_name, password_hash, password_salt) VALUES ('U_WAREHOUSE', 'warehouse@example.com', 'PRODUCTION_WAREHOUSE', 'ACTIVE', 'Warehouse Guy', 'hash', 'salt')").run();
  
  db.prepare("INSERT INTO customers (customer_id, customer_code, customer_name, owner_user_id) VALUES ('C1', 'CUST1', 'Customer 1', 'U_SALES')").run();
  db.prepare("INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca Product')").run();
  db.prepare("INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')").run();
  db.prepare("INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')").run();
  db.prepare("INSERT INTO product_applications (product_id, application) VALUES ('P1', 'FEED_GRADE')").run();
  db.prepare("INSERT INTO standard_specs (standard_spec_id, product_id, application, revision_no, status, effective_date) VALUES ('STD1', 'P1', 'FEED_GRADE', 0, 'ACTIVE', '2026-08-27')").run();

  const repo = createPORepository(db);

  let currentUser = null;
  const resolveUser = async () => currentUser;

  const handler = createPOHandler({ repo, resolveUser, db });

  // 1. Unauthenticated request -> 401
  const reqUnauth = mockRequest('GET', '/api/pos');
  const resUnauth = await handler(reqUnauth);
  assert.equal(resUnauth.status, 401);

  // Set current user to External Sales
  currentUser = { user_id: 'U_SALES', role: 'EXTERNAL_SALES' };

  // 2. External Sales tries to create PO -> 403
  const reqCreateES = mockRequest('POST', '/api/pos', { customerId: 'C1' });
  const resCreateES = await handler(reqCreateES);
  assert.equal(resCreateES.status, 403);

  // Set current user to Support
  currentUser = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };

  // 3. Support creates PO -> 200 SUCCESS
  const reqCreateSupport = mockRequest('POST', '/api/pos', {
    customerId: 'C1',
    poDate: '2026-08-27',
    currency: 'USD',
    incoterm: 'FOB',
    deliveryStart: '2026-09-01',
    deliveryEnd: '2026-09-30',
    validUntil: '2028-12-31'
  });
  const resCreateSupport = await handler(reqCreateSupport);
  assert.equal(resCreateSupport.status, 200);
  const createData = await resCreateSupport.json();
  assert.equal(createData.status, 'SUCCESS');
  const poId = createData.data.po.header.po_id;
  const rev0Id = createData.data.po.revision.revision_id;

  // 4. Support adds a line to Draft Rev.0 -> 200 SUCCESS
  const reqAddLine = mockRequest('POST', `/api/pos/${poId}/revisions/${rev0Id}/lines`, {
    lineNo: 10,
    productId: 'P1',
    specSource: 'STANDARD',
    specRevisionId: 'STD1',
    contractQtyMt: 100,
    tolerancePct: 10,
    unitPrice: 350.00,
    packaging: 'Jumbo Bag',
    containerType: '20GP',
    loadingPattern: 'Palletized'
  });
  const resAddLine = await handler(reqAddLine);
  assert.equal(resAddLine.status, 200);

  // 5. Support adds evidence document -> 200 SUCCESS
  const reqAddDoc = mockRequest('POST', `/api/pos/${poId}/revisions/${rev0Id}/documents`, {
    documentType: 'CUSTOMER_PO',
    label: 'Customer PO file',
    url: 'https://example.com/po.pdf'
  });
  const resAddDoc = await handler(reqAddDoc);
  assert.equal(resAddDoc.status, 200);

  // 6. Support tries to activate -> 403
  const reqActivateSupport = mockRequest('POST', `/api/pos/${poId}/revisions/${rev0Id}/activate`);
  const resActivateSupport = await handler(reqActivateSupport);
  assert.equal(resActivateSupport.status, 403);

  // Set current user to Manager
  currentUser = { user_id: 'U_MANAGER', role: 'MANAGER' };

  // 7. Manager activates -> 200 SUCCESS
  const reqActivateManager = mockRequest('POST', `/api/pos/${poId}/revisions/${rev0Id}/activate`, {
    approvalNote: 'Looks good'
  });
  const resActivateManager = await handler(reqActivateManager);
  assert.equal(resActivateManager.status, 200);

  // 8. Role-based READ Projections Checks
  // A. EXTERNAL_SALES who owns the PO
  currentUser = { user_id: 'U_SALES', role: 'EXTERNAL_SALES' };
  const reqGetESOwner = mockRequest('GET', `/api/pos/${poId}`);
  const resGetESOwner = await handler(reqGetESOwner);
  assert.equal(resGetESOwner.status, 200);
  const esData = await resGetESOwner.json();
  // ES should see header & active revision but no audit events/diffs
  assert.ok(esData.data.po.header);
  assert.equal(esData.data.po.revisions.length, 1);
  assert.equal(esData.data.po.revisions[0].status, 'ACTIVE');
  assert.equal(esData.data.po.auditEvents, undefined);

  // B. EXTERNAL_SALES who does NOT own the PO -> 403
  currentUser = { user_id: 'U_SALES_OTHER', role: 'EXTERNAL_SALES' };
  const reqGetESOther = mockRequest('GET', `/api/pos/${poId}`);
  const resGetESOther = await handler(reqGetESOther);
  assert.equal(resGetESOther.status, 403);

  // C. EXPORT role -> 200 SUCCESS, but unit_price and commission rates are hidden
  currentUser = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const reqGetExport = mockRequest('GET', `/api/pos/${poId}`);
  const resGetExport = await handler(reqGetExport);
  assert.equal(resGetExport.status, 200);
  const exportData = await resGetExport.json();
  const exportLine = exportData.data.po.revisions[0].lines[0];
  assert.equal(exportLine.unit_price, undefined);
  assert.equal(exportLine.commission_rate_usd_mt, undefined);
  // quantities must still be present
  assert.equal(exportLine.contract_qty_mt, 100);

  // D. PRODUCTION_WAREHOUSE role -> 200 SUCCESS, only product, qty, packaging, delivery dates, specs
  currentUser = { user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' };
  const reqGetWarehouse = mockRequest('GET', `/api/pos/${poId}`);
  const resGetWarehouse = await handler(reqGetWarehouse);
  assert.equal(resGetWarehouse.status, 200);
  const whData = await resGetWarehouse.json();
  const whRev = whData.data.po.revisions[0];
  // Excluded:
  assert.equal(whRev.incoterm, undefined);
  assert.equal(whRev.destination, undefined);
  assert.equal(whRev.payment_term_snapshot, undefined);
  // Included:
  assert.equal(whRev.delivery_start, '2026-09-01');
  assert.equal(whRev.lines[0].contract_qty_mt, 100);
  assert.equal(whRev.lines[0].packaging, 'Jumbo Bag');

  // 9. Manager cancels PO -> 200 SUCCESS
  currentUser = { user_id: 'U_MANAGER', role: 'MANAGER' };
  const reqCancel = mockRequest('POST', `/api/pos/${poId}/cancel`, {
    reason: 'Mutual agreement to cancel'
  });
  const resCancel = await handler(reqCancel);
  assert.equal(resCancel.status, 200);

  // 10. Check terminal state: Support tries to clone next revision -> 400 error (PO_ALREADY_CANCELLED)
  currentUser = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  const reqClone = mockRequest('POST', `/api/pos/${poId}/revisions/${rev0Id}/create-next`);
  const resClone = await handler(reqClone);
  assert.equal(resClone.status, 400);
  const cloneData = await resClone.json();
  assert.equal(cloneData.code, 'PO_ALREADY_CANCELLED');
});
