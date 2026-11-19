import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOGISTICS_PARTNER_TYPES,
  RATE_CURRENCIES,
  RATE_CONTAINER_SIZES,
  parsePartnerListQuery,
  validatePartnerCreate,
  validatePartnerUpdate,
  validateRateCreate,
  validateRateUpdate
} from '../src/logistics-partners/validation.js';

test('validation exposes canonical partner types, currencies, and container sizes', () => {
  assert.deepEqual(LOGISTICS_PARTNER_TYPES, ['FORWARDER', 'SHIPPING_LINE', 'TRUCKING', 'SURVEYOR']);
  assert.deepEqual(RATE_CURRENCIES, ['THB', 'USD', 'EUR']);
  assert.deepEqual(RATE_CONTAINER_SIZES, ['20GP', '40GP', '40HC', 'BULK', 'OTHER', '-']);
});

test('validatePartnerCreate normalizes valid partner payloads and rejects invalid ones', () => {
  const created = validatePartnerCreate({
    partnerName: '  Siam Trucking Co.  ',
    partnerType: 'TRUCKING',
    contactName: '  Khun Somchai ',
    contactPhone: ' 081-234-5678 ',
    contactEmail: ' ops@siamtruck.co.th ',
    address: '  Chonburi  ',
    taxId: ' 0105551234567 ',
    note: '  Main Laem Chabang carrier  '
  });
  assert.deepEqual(created, {
    partnerName: 'Siam Trucking Co.',
    partnerType: 'TRUCKING',
    status: 'ACTIVE',
    contactName: 'Khun Somchai',
    contactPhone: '081-234-5678',
    contactEmail: 'ops@siamtruck.co.th',
    address: 'Chonburi',
    taxId: '0105551234567',
    note: 'Main Laem Chabang carrier'
  });

  // Blank optional fields normalize to null
  const minimal = validatePartnerCreate({
    partnerName: 'SGS Thailand',
    partnerType: 'SURVEYOR',
    contactEmail: '   ',
    note: ''
  });
  assert.equal(minimal.contactEmail, null);
  assert.equal(minimal.note, null);
  assert.equal(minimal.status, 'ACTIVE');

  // Unknown properties rejected
  assert.throws(
    () => validatePartnerCreate({ partnerName: 'SGS', partnerType: 'SURVEYOR', extraField: true }),
    /SERVICE_PARTNER_PROPERTY_INVALID/
  );
  // Blank name rejected
  assert.throws(
    () => validatePartnerCreate({ partnerName: '   ', partnerType: 'SURVEYOR' }),
    /SERVICE_PARTNER_NAME_REQUIRED/
  );
  // Invalid partnerType rejected
  assert.throws(
    () => validatePartnerCreate({ partnerName: 'SGS', partnerType: 'CUSTOMS' }),
    /SERVICE_PARTNER_TYPE_INVALID/
  );
  // Invalid status rejected
  assert.throws(
    () => validatePartnerCreate({ partnerName: 'SGS', partnerType: 'SURVEYOR', status: 'DELETED' }),
    /SERVICE_PARTNER_STATUS_INVALID/
  );
  // Malformed email rejected
  assert.throws(
    () => validatePartnerCreate({ partnerName: 'SGS', partnerType: 'SURVEYOR', contactEmail: 'not-an-email' }),
    /SERVICE_PARTNER_EMAIL_INVALID/
  );
});

test('validatePartnerUpdate merges existing profile and enforces immutable partnerType', () => {
  const existing = {
    partner_id: 'SP-001',
    partner_type: 'FORWARDER',
    partner_name: 'Kerry Logistics',
    status: 'ACTIVE',
    contact_name: 'Somchai',
    contact_phone: '081-111-1111',
    contact_email: 'a@b.com',
    address: 'Bangkok',
    tax_id: '12345',
    note: 'Original'
  };

  const updated = validatePartnerUpdate({
    partnerName: 'Kerry Express Export',
    partnerType: 'FORWARDER',
    contactPhone: '089-999-9999',
    note: ''
  }, existing);

  assert.equal(updated.partnerName, 'Kerry Express Export');
  assert.equal(updated.partnerType, 'FORWARDER');
  assert.equal(updated.contactName, 'Somchai');
  assert.equal(updated.contactPhone, '089-999-9999');
  assert.equal(updated.note, null);

  assert.throws(
    () => validatePartnerUpdate({ partnerType: 'TRUCKING' }, existing),
    /SERVICE_PARTNER_TYPE_IMMUTABLE/
  );
  assert.throws(
    () => validatePartnerUpdate({}, existing),
    /SERVICE_PARTNER_PAYLOAD_INVALID/
  );
  assert.throws(
    () => validatePartnerUpdate({ unknownKey: 1 }, existing),
    /SERVICE_PARTNER_PROPERTY_INVALID/
  );
  assert.throws(
    () => validatePartnerUpdate({ contactEmail: 'bad@@email' }, existing),
    /SERVICE_PARTNER_EMAIL_INVALID/
  );
});

test('validateRateCreate and validateRateUpdate enforce strict allowlist, price, currency, containerSize, and date rules', () => {
  const rate = validateRateCreate({
    serviceType: '  Trucking  ',
    routeScope: '  Factory -> LCB  ',
    containerSize: '40HC',
    unit: ' THB / Container ',
    price: 9500.25,
    currency: 'THB',
    effectiveDate: '2026-11-01',
    validUntil: '2026-12-31',
    note: ' Standard rate '
  });
  assert.deepEqual(rate, {
    serviceType: 'Trucking',
    routeScope: 'Factory -> LCB',
    containerSize: '40HC',
    unit: 'THB / Container',
    price: 9500.25,
    currency: 'THB',
    effectiveDate: '2026-11-01',
    validUntil: '2026-12-31',
    status: 'ACTIVE',
    note: 'Standard rate'
  });

  // Defaults containerSize to '-' and status to 'ACTIVE', allows null validUntil
  const defaultRate = validateRateCreate({
    serviceType: 'Survey',
    unit: 'THB / Job',
    price: 4500,
    currency: 'THB',
    effectiveDate: '2026-11-01'
  });
  assert.equal(defaultRate.containerSize, '-');
  assert.equal(defaultRate.status, 'ACTIVE');
  assert.equal(defaultRate.validUntil, null);

  // Unknown property rejected
  assert.throws(
    () => validateRateCreate({ ...defaultRate, discount: 10 }),
    /PARTNER_RATE_PROPERTY_INVALID/
  );
  // Price <= 0 or >2 decimal places rejected
  assert.throws(
    () => validateRateCreate({ ...defaultRate, price: 0 }),
    /PARTNER_RATE_PRICE_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, price: -100 }),
    /PARTNER_RATE_PRICE_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, price: 100.125 }),
    /PARTNER_RATE_PRICE_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, price: '100' }),
    /PARTNER_RATE_PRICE_INVALID/
  );
  // Invalid currency, containerSize, status
  assert.throws(
    () => validateRateCreate({ ...defaultRate, currency: 'JPY' }),
    /PARTNER_RATE_CURRENCY_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, containerSize: '45HC' }),
    /PARTNER_RATE_CONTAINER_SIZE_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, status: 'EXPIRED' }),
    /PARTNER_RATE_STATUS_INVALID/
  );
  // Invalid calendar dates and inverted date range
  assert.throws(
    () => validateRateCreate({ ...defaultRate, effectiveDate: '2026-02-30' }),
    /PARTNER_RATE_EFFECTIVE_DATE_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, validUntil: '2026-13-01' }),
    /PARTNER_RATE_VALID_UNTIL_INVALID/
  );
  assert.throws(
    () => validateRateCreate({ ...defaultRate, effectiveDate: '2026-11-15', validUntil: '2026-11-14' }),
    /PARTNER_RATE_DATE_RANGE_INVALID/
  );

  // validateRateUpdate checks merged validUntil >= effectiveDate
  const existingRate = {
    service_type: 'Trucking',
    route_scope: 'Factory -> LCB',
    container_size: '20GP',
    unit: 'THB / Container',
    price: 8000,
    currency: 'THB',
    effective_date: '2026-11-10',
    valid_until: '2026-11-20',
    status: 'ACTIVE',
    note: null
  };
  const patched = validateRateUpdate({ status: 'INACTIVE', price: 8200.5 }, existingRate);
  assert.equal(patched.status, 'INACTIVE');
  assert.equal(patched.price, 8200.5);
  assert.equal(patched.effectiveDate, '2026-11-10');
  assert.equal(patched.validUntil, '2026-11-20');

  assert.throws(
    () => validateRateUpdate({ validUntil: '2026-11-09' }, existingRate),
    /PARTNER_RATE_DATE_RANGE_INVALID/
  );
  assert.throws(
    () => validateRateUpdate({ effectiveDate: '2026-11-25' }, existingRate),
    /PARTNER_RATE_DATE_RANGE_INVALID/
  );
  assert.throws(
    () => validateRateUpdate({}, existingRate),
    /PARTNER_RATE_PAYLOAD_INVALID/
  );
});

test('parsePartnerListQuery normalizes filters and rejects invalid partnerType or status', () => {
  assert.deepEqual(
    parsePartnerListQuery(new URLSearchParams('partnerType=TRUCKING&status=ACTIVE&search=Siam')),
    { partnerType: 'TRUCKING', status: 'ACTIVE', search: 'Siam' }
  );
  assert.deepEqual(
    parsePartnerListQuery(new URLSearchParams('partnerType=ALL&status=ALL&search=   ')),
    { partnerType: undefined, status: undefined, search: undefined }
  );
  assert.throws(
    () => parsePartnerListQuery(new URLSearchParams('partnerType=INVALID')),
    /SERVICE_PARTNER_TYPE_INVALID/
  );
  assert.throws(
    () => parsePartnerListQuery(new URLSearchParams('status=DELETED')),
    /SERVICE_PARTNER_STATUS_INVALID/
  );
});

import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { hashSessionToken } from '../src/auth/crypto.js';

async function setupRouteTestDb() {
  const db = new DatabaseSync(':memory:');
  for (const migration of [
    '0001_auth.sql',
    '0002_customers.sql',
    '0003_product_specs.sql',
    '0004_commercial_shipment_control.sql',
    '0005_po_management.sql',
    '0006_customer_ownership_type.sql',
    '0007_shipping_di_integration.sql',
    '0008_logistics_partners.sql'
  ]) {
    db.exec(await readFile(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
  }

  return {
    db,
    wrappedDb: {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          params: [],
          bind(...params) {
            this.params = params;
            return this;
          },
          async first() {
            return statement.all(...this.params)[0] || null;
          },
          async all() {
            return { results: statement.all(...this.params), success: true };
          },
          async run() {
            return { success: true, meta: statement.run(...this.params) };
          }
        };
      }
    }
  };
}

async function seedUserAndSession(db, userId, role, token) {
  db.prepare(
    'INSERT INTO users (user_id, full_name, email, role, customer_scope, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(userId, `${role} User`, `${userId}@example.com`, role, role === 'EXTERNAL_SALES' ? 'OWN_CUSTOMERS' : 'ALL', 'hash', 'salt');
  db.prepare(
    'INSERT INTO sessions (session_id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
  ).run(`SES-${userId}`, userId, await hashSessionToken(token), new Date(Date.now() + 60000).toISOString());
}

function makeRequest(path, method = 'GET', body = null, token = null) {
  const headers = token ? { cookie: `wcat_session=${token}` } : {};
  if (body !== null) headers['content-type'] = 'application/json';
  return new Request(`https://example.com${path}`, {
    method,
    headers,
    body: body !== null ? JSON.stringify(body) : null
  });
}

test('worker dispatches /api/logistics-partners and returns 503 without DB binding', async () => {
  const res = await worker.fetch(makeRequest('/api/logistics-partners'), {});
  assert.equal(res.status, 503);
});

test('all /api/logistics-partners endpoints return 401 when unauthenticated', async () => {
  const { wrappedDb } = await setupRouteTestDb();
  const requests = [
    makeRequest('/api/logistics-partners', 'GET'),
    makeRequest('/api/logistics-partners/SP-001', 'GET'),
    makeRequest('/api/logistics-partners', 'POST', { partnerName: 'Test', partnerType: 'TRUCKING' }),
    makeRequest('/api/logistics-partners/SP-001', 'PUT', { partnerName: 'Test 2' }),
    makeRequest('/api/logistics-partners/SP-001/rates', 'POST', {
      serviceType: 'Trucking', unit: 'THB / Container', price: 5000, currency: 'THB', effectiveDate: '2026-11-01'
    }),
    makeRequest('/api/logistics-partners/SP-001/rates/SPR-0001', 'PATCH', { status: 'INACTIVE' })
  ];

  for (const req of requests) {
    const res = await worker.fetch(req, { DB: wrappedDb });
    assert.equal(res.status, 401, `${req.method} ${new URL(req.url).pathname} should return 401`);
  }
});

test('strict RBAC enforces 403 for EXTERNAL_SALES and PRODUCTION_WAREHOUSE, read-only for SALES_SUPPORT', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_SUPPORT', 'SALES_SUPPORT', 'support-token');
  await seedUserAndSession(db, 'U_EXT', 'EXTERNAL_SALES', 'ext-token');
  await seedUserAndSession(db, 'U_WH', 'PRODUCTION_WAREHOUSE', 'wh-token');

  // Seed one partner & one rate as ADMIN
  const createPartnerRes = await worker.fetch(makeRequest('/api/logistics-partners', 'POST', {
    partnerName: 'Siam Trucking',
    partnerType: 'TRUCKING',
    contactName: 'Somchai'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(createPartnerRes.status, 200);
  const partnerId = (await createPartnerRes.json()).data.partner.partner_id;

  const createRateRes = await worker.fetch(makeRequest(`/api/logistics-partners/${partnerId}/rates`, 'POST', {
    serviceType: 'Trucking',
    unit: 'THB / Container',
    price: 7500,
    currency: 'THB',
    effectiveDate: '2026-11-01'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(createRateRes.status, 200);
  const rateId = (await createRateRes.json()).data.rate.rate_id;

  // EXTERNAL_SALES and PRODUCTION_WAREHOUSE receive 403 on ALL endpoints
  for (const token of ['ext-token', 'wh-token']) {
    for (const [path, method, body] of [
      ['/api/logistics-partners', 'GET', null],
      [`/api/logistics-partners/${partnerId}`, 'GET', null],
      ['/api/logistics-partners', 'POST', { partnerName: 'Denied', partnerType: 'SURVEYOR' }],
      [`/api/logistics-partners/${partnerId}`, 'PUT', { partnerName: 'Denied' }],
      [`/api/logistics-partners/${partnerId}/rates`, 'POST', {
        serviceType: 'Trucking', unit: 'THB / Job', price: 1000, currency: 'THB', effectiveDate: '2026-11-01'
      }],
      [`/api/logistics-partners/${partnerId}/rates/${rateId}`, 'PATCH', { status: 'INACTIVE' }]
    ]) {
      const res = await worker.fetch(makeRequest(path, method, body, token), { DB: wrappedDb });
      assert.equal(res.status, 403, `${token} ${method} ${path} must return 403`);
    }
  }

  // SALES_SUPPORT can read list and detail, but receives 403 on all mutations
  const supportList = await worker.fetch(makeRequest('/api/logistics-partners', 'GET', null, 'support-token'), { DB: wrappedDb });
  assert.equal(supportList.status, 200);
  assert.equal((await supportList.json()).data.partners.length, 1);

  const supportDetail = await worker.fetch(makeRequest(`/api/logistics-partners/${partnerId}`, 'GET', null, 'support-token'), { DB: wrappedDb });
  assert.equal(supportDetail.status, 200);
  const supportDetailBody = await supportDetail.json();
  assert.equal(supportDetailBody.data.partner.partner_id, partnerId);
  assert.equal(supportDetailBody.data.rates.length, 1);

  for (const [path, method, body] of [
    ['/api/logistics-partners', 'POST', { partnerName: 'Support New', partnerType: 'SURVEYOR' }],
    [`/api/logistics-partners/${partnerId}`, 'PUT', { partnerName: 'Support Edit' }],
    [`/api/logistics-partners/${partnerId}/rates`, 'POST', {
      serviceType: 'Trucking', unit: 'THB / Job', price: 1000, currency: 'THB', effectiveDate: '2026-11-01'
    }],
    [`/api/logistics-partners/${partnerId}/rates/${rateId}`, 'PATCH', { status: 'INACTIVE' }]
  ]) {
    const res = await worker.fetch(makeRequest(path, method, body, 'support-token'), { DB: wrappedDb });
    assert.equal(res.status, 403, `SALES_SUPPORT ${method} ${path} must return 403`);
  }
});

test('ADMIN, MANAGER, and EXPORT have full partner & rate lifecycle plus Phase 6 cross-compatibility', async () => {
  const { db, wrappedDb } = await setupRouteTestDb();
  await seedUserAndSession(db, 'U_ADMIN', 'ADMIN', 'admin-token');
  await seedUserAndSession(db, 'U_MANAGER', 'MANAGER', 'manager-token');
  await seedUserAndSession(db, 'U_EXPORT', 'EXPORT', 'export-token');

  // EXPORT creates partner via Phase 8
  const p8Create = await worker.fetch(makeRequest('/api/logistics-partners', 'POST', {
    partnerName: 'Kerry Ocean',
    partnerType: 'FORWARDER',
    contactName: 'K. Malee',
    contactPhone: '081-000-0001',
    contactEmail: 'malee@kerry.co.th',
    taxId: '0105551111111',
    address: 'Bangkok',
    note: 'Primary EU forwarder'
  }, 'export-token'), { DB: wrappedDb });
  assert.equal(p8Create.status, 200);
  const p8Partner = (await p8Create.json()).data.partner;
  assert.equal(p8Partner.partner_id, 'SP-001');

  // Immediately visible in Phase 6 GET /api/service-partners
  const p6ListRes = await worker.fetch(makeRequest('/api/service-partners', 'GET', null, 'export-token'), { DB: wrappedDb });
  assert.equal(p6ListRes.status, 200);
  const p6Partners = (await p6ListRes.json()).data.servicePartners;
  assert.equal(p6Partners.length, 1);
  assert.equal(p6Partners[0].partner_id, 'SP-001');

  // Phase 6 creates partner -> immediately visible in Phase 8 GET /api/logistics-partners
  const p6Create = await worker.fetch(makeRequest('/api/service-partners', 'POST', {
    companyName: 'SGS Thailand',
    partnerType: 'SURVEYOR'
  }, 'export-token'), { DB: wrappedDb });
  assert.equal(p6Create.status, 200);
  const p6Created = (await p6Create.json()).data.servicePartner;
  assert.equal(p6Created.partner_id, 'SP-002');

  const p8List = await worker.fetch(makeRequest('/api/logistics-partners', 'GET', null, 'manager-token'), { DB: wrappedDb });
  assert.equal(p8List.status, 200);
  assert.equal((await p8List.json()).data.partners.length, 2);

  // MANAGER updates partner profile and adds a rate
  const mgrUpdate = await worker.fetch(makeRequest('/api/logistics-partners/SP-001', 'PUT', {
    partnerName: 'Kerry Ocean Logistics',
    contactPhone: '082-222-2222'
  }, 'manager-token'), { DB: wrappedDb });
  assert.equal(mgrUpdate.status, 200);
  assert.equal((await mgrUpdate.json()).data.partner.partner_name, 'Kerry Ocean Logistics');

  // Immutable partnerType rejected with 400
  const badTypeChange = await worker.fetch(makeRequest('/api/logistics-partners/SP-001', 'PUT', {
    partnerType: 'TRUCKING'
  }, 'manager-token'), { DB: wrappedDb });
  assert.equal(badTypeChange.status, 400);
  assert.equal((await badTypeChange.json()).message, 'SERVICE_PARTNER_TYPE_IMMUTABLE');

  const rateCreate = await worker.fetch(makeRequest('/api/logistics-partners/SP-001/rates', 'POST', {
    serviceType: 'Ocean Export Clearance',
    routeScope: 'Laem Chabang -> Hamburg',
    containerSize: '40HC',
    unit: 'USD / Container',
    price: 1850,
    currency: 'USD',
    effectiveDate: '2026-11-01',
    validUntil: '2026-12-31'
  }, 'manager-token'), { DB: wrappedDb });
  assert.equal(rateCreate.status, 200);
  const rate = (await rateCreate.json()).data.rate;
  assert.equal(rate.rate_id, 'SPR-0001');

  // ADMIN patches rate to INACTIVE
  const ratePatch = await worker.fetch(makeRequest(`/api/logistics-partners/SP-001/rates/${rate.rate_id}`, 'PATCH', {
    status: 'INACTIVE',
    note: 'Replaced by Q1 tariff'
  }, 'admin-token'), { DB: wrappedDb });
  assert.equal(ratePatch.status, 200);
  assert.equal((await ratePatch.json()).data.rate.status, 'INACTIVE');

  // 404 cases
  assert.equal((await worker.fetch(makeRequest('/api/logistics-partners/SP-999', 'GET', null, 'admin-token'), { DB: wrappedDb })).status, 404);
  assert.equal((await worker.fetch(makeRequest('/api/logistics-partners/SP-999', 'PUT', { partnerName: 'X' }, 'admin-token'), { DB: wrappedDb })).status, 404);
  assert.equal((await worker.fetch(makeRequest('/api/logistics-partners/SP-999/rates', 'POST', {
    serviceType: 'X', unit: 'THB / Job', price: 100, currency: 'THB', effectiveDate: '2026-11-01'
  }, 'admin-token'), { DB: wrappedDb })).status, 404);
  assert.equal((await worker.fetch(makeRequest('/api/logistics-partners/SP-002/rates/SPR-0001', 'PATCH', { status: 'ACTIVE' }, 'admin-token'), { DB: wrappedDb })).status, 404);

  // Invalid query filter returns 400
  const badQuery = await worker.fetch(makeRequest('/api/logistics-partners?partnerType=BOGUS', 'GET', null, 'admin-token'), { DB: wrappedDb });
  assert.equal(badQuery.status, 400);
});
