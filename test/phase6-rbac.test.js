import test from 'node:test';
import assert from 'node:assert/strict';
import { createShippingDiHandler } from '../src/shipping-di/routes.js';

function request(path) {
  return new Request(`https://example.com${path}`);
}

function ownerDb(owners) {
  return {
    prepare(sql) {
      assert.match(sql, /FROM customers/);
      return {
        bind(customerId) {
          return { first: async () => owners[customerId] ? { owner_user_id: owners[customerId] } : null };
        }
      };
    }
  };
}

const fullShipment = {
  shipment_id: 'S1',
  di_id: 'DI-1',
  customer_id: 'C-OWNED',
  status: 'LOADED',
  planned_loading_date: '2026-09-08',
  actual_loading_date: '2026-09-10',
  schedule_result: 'ON_PLAN',
  schedule_note: 'Internal scheduling assessment',
  actual_qty_mt: 20,
  lines: [{ product_id: 'P-1', product_name: 'Rice', planned_qty_mt: 20, packing_snapshot: '25 kg bag' }],
  containers: [{ container_no: 'CONT-1', seal_no: 'SEAL-1', total_net_weight_mt: 20 }],
  payment_status: 'PAID',
  payment_note: 'Bank reference',
  cash_received_amount: 5000,
  invoices: [{ invoice_no: 'INV-1', total_amount: 5000 }],
  customer_credits: [{ credit_id: 'CR-1', amount: 100 }],
  audit_events: [{ actor_id: 'U_EXPORT', metadata_json: '{"note":"internal"}' }],
  created_by: 'U_EXPORT',
  updated_by: 'U_EXPORT'
};

test('PRODUCTION_WAREHOUSE receives loading fields but no invoice, credit, payment, or audit data', async () => {
  const handler = createShippingDiHandler({
    repo: { getPhase6Shipment: async () => fullShipment },
    resolveUser: async () => ({ user_id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' })
  });

  const response = await handler(request('/api/shipments-v2/S1'));
  const shipment = (await response.json()).data.shipment;

  assert.equal(response.status, 200);
  assert.equal(shipment.actual_loading_date, '2026-09-10');
  assert.deepEqual(shipment.lines, [{ product_id: 'P-1', product_name: 'Rice', planned_qty_mt: 20, packing_snapshot: '25 kg bag' }]);
  assert.equal('payment_status' in shipment, false);
  assert.equal('invoices' in shipment, false);
  assert.equal('customer_credits' in shipment, false);
  assert.equal('audit_events' in shipment, false);
  assert.equal('created_by' in shipment, false);
  assert.equal('schedule_note' in shipment, false);
});

test('EXTERNAL_SALES can read only owned customer shipment progress without internal detail', async () => {
  const handler = createShippingDiHandler({
    repo: { getPhase6Shipment: async () => fullShipment },
    db: ownerDb({ 'C-OWNED': 'U_SALES' }),
    resolveUser: async () => ({ user_id: 'U_SALES', role: 'EXTERNAL_SALES' })
  });

  const response = await handler(request('/api/shipments-v2/S1'));
  const shipment = (await response.json()).data.shipment;

  assert.equal(response.status, 200);
  assert.equal(shipment.status, 'LOADED');
  assert.equal('audit_events' in shipment, false);
  assert.equal('created_by' in shipment, false);
  assert.equal('payment_status' in shipment, false);
  assert.equal('invoices' in shipment, false);
});

test('EXTERNAL_SALES cannot read another owner\'s Phase 6 shipment', async () => {
  const handler = createShippingDiHandler({
    repo: { getPhase6Shipment: async () => fullShipment },
    db: ownerDb({ 'C-OWNED': 'U_OTHER_SALES' }),
    resolveUser: async () => ({ user_id: 'U_SALES', role: 'EXTERNAL_SALES' })
  });

  const response = await handler(request('/api/shipments-v2/S1'));

  assert.equal(response.status, 403);
});
