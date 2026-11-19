import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createLogisticsPartnersRepository } from '../src/logistics-partners/repository.js';
import { createShippingDiRepository } from '../src/shipping-di/repository.js';

async function setupTestDb() {
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

function seedBaseOperationalData(db) {
  db.prepare(
    "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_EXPORT', 'export@example.com', 'hash', 'salt', 'EXPORT', 'ACTIVE', 'Export User')"
  ).run();
  db.prepare(
    "INSERT INTO users (user_id, email, password_hash, password_salt, role, status, full_name) VALUES ('U_ADMIN', 'admin@example.com', 'hash', 'salt', 'ADMIN', 'ACTIVE', 'Admin User')"
  ).run();
  db.prepare(
    "INSERT INTO customers (customer_id, customer_code, customer_name) VALUES ('C1', 'CUST1', 'Acme Starch Co.')"
  ).run();
  db.prepare(
    "INSERT INTO product_categories (category_id, category_code, category_name) VALUES ('CAT1', 'TAPIOCA', 'Tapioca')"
  ).run();
  db.prepare(
    "INSERT INTO product_forms (form_id, form_code, form_name) VALUES ('FRM1', 'PELLET', 'Pellet')"
  ).run();
  db.prepare(
    "INSERT INTO products (product_id, product_code, product_name, short_name, category_id, form_id) VALUES ('P1', 'THP-65', 'Tapioca Pellet 65%', 'THP65', 'CAT1', 'FRM1')"
  ).run();
  db.prepare(
    "INSERT INTO po_headers (po_id, customer_id, created_by) VALUES ('PO1', 'C1', 'U_ADMIN')"
  ).run();
  db.prepare(
    "INSERT INTO po_revisions (revision_id, po_id, revision_no, status, ownership_type_snapshot, sales_owner_user_id_snapshot, currency, incoterm, delivery_start, delivery_end, valid_until, created_by) VALUES ('REV1', 'PO1', 0, 'ACTIVE', 'HOUSE_ACCOUNT', NULL, 'USD', 'FOB', '2026-11-01', '2026-11-30', '2026-10-31', 'U_ADMIN')"
  ).run();
}

test('createPartner and updatePartner share SP-XXX sequence with Phase 6 and persist full profile', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedBaseOperationalData(db);

  const phase6Repo = createShippingDiRepository(wrappedDb);
  const phase8Repo = createLogisticsPartnersRepository(wrappedDb);

  const p1 = await phase6Repo.createServicePartner({ companyName: 'SGS Thailand', partnerType: 'SURVEYOR' }, 'U_EXPORT');
  assert.equal(p1.partner_id, 'SP-001');

  const p2 = await phase8Repo.createPartner({
    partnerName: 'Kerry Ocean Freight',
    partnerType: 'FORWARDER',
    contactName: 'Somchai',
    contactPhone: '081-222-3333',
    contactEmail: 'ops@kerry.co.th',
    address: 'Bangkok Port',
    taxId: '0105559999999',
    note: 'Preferred EU forwarder'
  }, 'U_EXPORT');

  assert.equal(p2.partner_id, 'SP-002');
  assert.equal(p2.partner_type, 'FORWARDER');
  assert.equal(p2.partner_name, 'Kerry Ocean Freight');
  assert.equal(p2.contact_name, 'Somchai');
  assert.equal(p2.contact_phone, '081-222-3333');
  assert.equal(p2.contact_email, 'ops@kerry.co.th');
  assert.equal(p2.address, 'Bangkok Port');
  assert.equal(p2.tax_id, '0105559999999');
  assert.equal(p2.note, 'Preferred EU forwarder');
  assert.equal(p2.status, 'ACTIVE');

  // Phase 6 dropdown sees partner created via Phase 8 immediately
  const phase6List = await phase6Repo.listServicePartners({ partnerType: 'FORWARDER' });
  assert.equal(phase6List.length, 1);
  assert.equal(phase6List[0].partner_id, 'SP-002');

  // Update profile and deactivate
  const updated = await phase8Repo.updatePartner('SP-002', {
    partnerName: 'Kerry Ocean Logistics',
    contactPhone: '089-000-1111',
    status: 'INACTIVE'
  }, 'U_ADMIN');
  assert.equal(updated.partner_name, 'Kerry Ocean Logistics');
  assert.equal(updated.contact_phone, '089-000-1111');
  assert.equal(updated.contact_name, 'Somchai');
  assert.equal(updated.status, 'INACTIVE');
  assert.equal(updated.updated_by, 'U_ADMIN');

  // Rejects immutable partnerType change and unknown partner ID
  await assert.rejects(
    () => phase8Repo.updatePartner('SP-002', { partnerType: 'TRUCKING' }, 'U_ADMIN'),
    /SERVICE_PARTNER_TYPE_IMMUTABLE/
  );
  await assert.rejects(
    () => phase8Repo.updatePartner('SP-999', { partnerName: 'Ghost' }, 'U_ADMIN'),
    /SERVICE_PARTNER_NOT_FOUND/
  );
});

test('createRate and updateRate manage SPR-XXXX rates with ownership and date validation', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedBaseOperationalData(db);
  const repo = createLogisticsPartnersRepository(wrappedDb);

  const p1 = await repo.createPartner({ partnerName: 'Siam Truck', partnerType: 'TRUCKING' }, 'U_EXPORT');
  const p2 = await repo.createPartner({ partnerName: 'Maersk Line', partnerType: 'SHIPPING_LINE' }, 'U_EXPORT');

  const r1 = await repo.createRate(p1.partner_id, {
    serviceType: 'Inland Trucking',
    routeScope: 'Factory -> Laem Chabang',
    containerSize: '40HC',
    unit: 'THB / Container',
    price: 8500,
    currency: 'THB',
    effectiveDate: '2026-11-01',
    validUntil: '2026-12-31',
    note: 'Q4 contract'
  }, 'U_EXPORT');

  assert.equal(r1.rate_id, 'SPR-0001');
  assert.equal(r1.partner_id, p1.partner_id);
  assert.equal(r1.price, 8500);
  assert.equal(r1.status, 'ACTIVE');

  const r2 = await repo.createRate(p1.partner_id, {
    serviceType: 'Inland Trucking',
    containerSize: '20GP',
    unit: 'THB / Container',
    price: 6800.5,
    currency: 'THB',
    effectiveDate: '2026-11-15'
  }, 'U_EXPORT');
  assert.equal(r2.rate_id, 'SPR-0002');

  const updated = await repo.updateRate(p1.partner_id, r1.rate_id, {
    price: 8800,
    status: 'INACTIVE'
  }, 'U_ADMIN');
  assert.equal(updated.price, 8800);
  assert.equal(updated.status, 'INACTIVE');
  assert.equal(updated.updated_by, 'U_ADMIN');

  // Enforces partner ownership
  await assert.rejects(
    () => repo.updateRate(p2.partner_id, r1.rate_id, { status: 'ACTIVE' }, 'U_ADMIN'),
    /PARTNER_RATE_NOT_FOUND/
  );
  // Enforces merged date range check
  await assert.rejects(
    () => repo.updateRate(p1.partner_id, r1.rate_id, { validUntil: '2026-10-31' }, 'U_ADMIN'),
    /PARTNER_RATE_DATE_RANGE_INVALID/
  );
  // Unknown partner rejected
  await assert.rejects(
    () => repo.createRate('SP-999', {
      serviceType: 'Survey',
      unit: 'THB / Job',
      price: 3000,
      currency: 'THB',
      effectiveDate: '2026-11-01'
    }, 'U_EXPORT'),
    /SERVICE_PARTNER_NOT_FOUND/
  );
});

test('listPartners and getPartnerDetail return live Phase 6 usage history, deduplicating forwarder and excluding cancelled records', async () => {
  const { db, wrappedDb } = await setupTestDb();
  seedBaseOperationalData(db);
  const repo = createLogisticsPartnersRepository(wrappedDb);

  const forwarder = await repo.createPartner({
    partnerName: 'Alpha Forwarder',
    partnerType: 'FORWARDER',
    contactName: 'Narin'
  }, 'U_EXPORT');
  const line = await repo.createPartner({
    partnerName: 'Oceanic Line',
    partnerType: 'SHIPPING_LINE'
  }, 'U_EXPORT');
  const trucker = await repo.createPartner({
    partnerName: 'Speed Truck',
    partnerType: 'TRUCKING'
  }, 'U_EXPORT');
  const surveyor = await repo.createPartner({
    partnerName: 'SGS Survey',
    partnerType: 'SURVEYOR'
  }, 'U_EXPORT');

  await repo.createRate(forwarder.partner_id, {
    serviceType: 'Export Clearance',
    unit: 'THB / Shipment',
    price: 3500,
    currency: 'THB',
    effectiveDate: '2026-11-01'
  }, 'U_EXPORT');
  await repo.createRate(forwarder.partner_id, {
    serviceType: 'Old Clearance',
    unit: 'THB / Shipment',
    price: 3000,
    currency: 'THB',
    effectiveDate: '2026-01-01',
    status: 'INACTIVE'
  }, 'U_EXPORT');

  // DI1: active DI + active shipment, same forwarder on BOTH DI and Shipment (must deduplicate!), 2 active containers + 1 cancelled container
  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, surveyor_partner_id, forwarder_partner_id,
      shipping_month, shipping_period, container_plan, status, created_by, created_at
    ) VALUES ('DI-1', 'C1', 'PO1', 'REV1', 'DI-2026-001', ?, ?, '2026-11', 'FIRST_HALF', '2 x 40HC', 'IN_PROGRESS', 'U_EXPORT', '2026-11-01 08:00:00')
  `).run(surveyor.partner_id, forwarder.partner_id);

  db.prepare(`
    INSERT INTO phase6_shipments (
      shipment_id, di_id, status, booking_no, forwarder_partner_id, shipping_line_partner_id, trucking_partner_id,
      vessel, etd, planned_loading_date, actual_loading_date, created_by
    ) VALUES ('SHP-1', 'DI-1', 'LOADED', 'BK-001', ?, ?, ?, 'EVER GIVEN', '2026-11-18', '2026-11-12', '2026-11-13', 'U_EXPORT')
  `).run(forwarder.partner_id, line.partner_id, trucker.partner_id);

  db.prepare(`
    INSERT INTO shipment_containers (container_id, shipment_id, container_no, container_type, status, created_by)
    VALUES ('CNT-1', 'SHP-1', 'MSCU1111111', '40HC', 'LOADED', 'U_EXPORT'),
           ('CNT-2', 'SHP-1', 'MSCU2222222', '40HC', 'PLANNED', 'U_EXPORT'),
           ('CNT-3', 'SHP-1', 'MSCU3333333', '40HC', 'CANCELLED', 'U_EXPORT')
  `).run();

  // DI2: DRAFT DI with no shipment yet, assigned forwarder + surveyor
  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, surveyor_partner_id, forwarder_partner_id,
      shipping_month, shipping_period, container_plan, status, created_by, created_at
    ) VALUES ('DI-2', 'C1', 'PO1', 'REV1', 'DI-2026-002', ?, ?, '2026-11', 'SECOND_HALF', '1 x 20GP', 'DRAFT', 'U_EXPORT', '2026-11-15 09:30:00')
  `).run(surveyor.partner_id, forwarder.partner_id);

  // DI3: CANCELLED DI (must be excluded)
  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, surveyor_partner_id, forwarder_partner_id,
      shipping_month, shipping_period, container_plan, status, created_by
    ) VALUES ('DI-3', 'C1', 'PO1', 'REV1', 'DI-2026-003', ?, ?, '2026-11', 'FIRST_HALF', '1 x 20GP', 'CANCELLED', 'U_EXPORT')
  `).run(surveyor.partner_id, forwarder.partner_id);

  // DI4: non-cancelled DI whose Shipment is CANCELLED (must be excluded)
  db.prepare(`
    INSERT INTO delivery_instructions (
      di_id, customer_id, po_id, po_revision_id, di_no, surveyor_partner_id, forwarder_partner_id,
      shipping_month, shipping_period, container_plan, status, created_by
    ) VALUES ('DI-4', 'C1', 'PO1', 'REV1', 'DI-2026-004', ?, ?, '2026-11', 'FIRST_HALF', '1 x 20GP', 'CONFIRMED', 'U_EXPORT')
  `).run(surveyor.partner_id, forwarder.partner_id);
  db.prepare(`
    INSERT INTO phase6_shipments (
      shipment_id, di_id, status, booking_no, forwarder_partner_id, shipping_line_partner_id, trucking_partner_id, created_by
    ) VALUES ('SHP-4', 'DI-4', 'CANCELLED', 'BK-004', ?, ?, ?, 'U_EXPORT')
  `).run(forwarder.partner_id, line.partner_id, trucker.partner_id);

  // Verify listPartners filters & counts
  const all = await repo.listPartners();
  assert.equal(all.length, 4);
  const alphaRow = all.find((p) => p.partner_id === forwarder.partner_id);
  assert.equal(alphaRow.active_rate_count, 1);
  assert.equal(alphaRow.usage_count, 2); // DI-1 (deduped) + DI-2

  const bySearch = await repo.listPartners({ search: 'narin' });
  assert.equal(bySearch.length, 1);
  assert.equal(bySearch[0].partner_id, forwarder.partner_id);

  const byType = await repo.listPartners({ partnerType: 'TRUCKING', status: 'ACTIVE' });
  assert.equal(byType.length, 1);
  assert.equal(byType[0].usage_count, 1);

  // Verify getPartnerDetail for forwarder
  const detail = await repo.getPartnerDetail(forwarder.partner_id);
  assert.equal(detail.partner.partner_id, forwarder.partner_id);
  assert.equal(detail.rates.length, 2);
  assert.equal(detail.rates[0].effective_date, '2026-11-01');
  assert.equal(detail.rates[1].effective_date, '2026-01-01');

  assert.equal(detail.usage.length, 2);
  // Ordered by usage_date DESC: DI-2 (2026-11-15) then DI-1 (2026-11-13 actual_loading_date)
  assert.equal(detail.usage[0].di_id, 'DI-2');
  assert.equal(detail.usage[0].shipment_id, null);
  assert.equal(detail.usage[0].usage_date, '2026-11-15');
  assert.equal(detail.usage[0].partner_role, 'FORWARDER');
  assert.equal(detail.usage[0].actual_container_count, 0);

  assert.equal(detail.usage[1].di_id, 'DI-1');
  assert.equal(detail.usage[1].shipment_id, 'SHP-1');
  assert.equal(detail.usage[1].customer_name, 'Acme Starch Co.');
  assert.equal(detail.usage[1].booking_no, 'BK-001');
  assert.equal(detail.usage[1].vessel, 'EVER GIVEN');
  assert.equal(detail.usage[1].container_plan, '2 x 40HC');
  assert.equal(detail.usage[1].usage_date, '2026-11-13');
  assert.equal(detail.usage[1].partner_role, 'FORWARDER');
  assert.equal(detail.usage[1].di_status, 'IN_PROGRESS');
  assert.equal(detail.usage[1].shipment_status, 'LOADED');
  assert.equal(detail.usage[1].actual_container_count, 2);

  // Verify shipping line & trucking & surveyor detail usage
  const lineDetail = await repo.getPartnerDetail(line.partner_id);
  assert.equal(lineDetail.usage.length, 1);
  assert.equal(lineDetail.usage[0].partner_role, 'SHIPPING_LINE');

  const truckDetail = await repo.getPartnerDetail(trucker.partner_id);
  assert.equal(truckDetail.usage.length, 1);
  assert.equal(truckDetail.usage[0].partner_role, 'TRUCKING');

  const surveyDetail = await repo.getPartnerDetail(surveyor.partner_id);
  assert.equal(surveyDetail.usage.length, 2);
  assert.ok(surveyDetail.usage.every((u) => u.partner_role === 'SURVEYOR'));

  assert.equal(await repo.getPartnerDetail('SP-999'), null);
});
