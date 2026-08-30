import test from 'node:test';
import assert from 'node:assert/strict';
import { createShippingDiHandler } from '../src/shipping-di/routes.js';

function request(path, method = 'GET', body = null) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null
  });
}

test('delivery-instruction routes allow operational readers to list and EXPORT to create', async () => {
  const created = { di_id: 'DI-1', di_no: 'PO-2026-015_001', lines: [] };
  const repo = {
    listDeliveryInstructions: async () => [created],
    createDeliveryInstruction: async () => created
  };
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const handler = createShippingDiHandler({ repo, resolveUser: async () => caller });

  const createdResponse = await handler(request('/api/delivery-instructions', 'POST', { customerId: 'C1' }));
  assert.equal(createdResponse.status, 200);
  assert.equal((await createdResponse.json()).data.deliveryInstruction.di_id, 'DI-1');

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  const listedResponse = await handler(request('/api/delivery-instructions?customerId=C1'));
  assert.equal(listedResponse.status, 200);
  assert.deepEqual((await listedResponse.json()).data.deliveryInstructions, [created]);
});

test('delivery-instruction routes reject unauthenticated and non-operational callers', async () => {
  const handler = createShippingDiHandler({
    repo: { listDeliveryInstructions: async () => [] },
    resolveUser: async () => null
  });
  assert.equal((await handler(request('/api/delivery-instructions'))).status, 401);

  const deniedHandler = createShippingDiHandler({
    repo: { listDeliveryInstructions: async () => [] },
    resolveUser: async () => ({ user_id: 'U_SALES', role: 'EXTERNAL_SALES' })
  });
  assert.equal((await deniedHandler(request('/api/delivery-instructions'))).status, 403);
});

test('delivery-instruction balance route exposes exact PO line availability to operational readers', async () => {
  const poLineBalances = [{ po_revision_line_id: 'LINE-10', available_qty_mt: 92 }];
  const handler = createShippingDiHandler({
    repo: { getPoLineBalances: async (poId) => {
      assert.equal(poId, 'PO-2026-015');
      return poLineBalances;
    } },
    resolveUser: async () => ({ user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' })
  });

  const response = await handler(request('/api/delivery-instructions/po-balance/PO-2026-015'));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.poLineBalances, poLineBalances);
});

test('delivery-instruction lifecycle routes keep DRAFT edits and confirm available to every EXPORT user', async () => {
  const calls = [];
  const repo = {
    updateDraftDeliveryInstruction: async (...args) => {
      calls.push(['update', ...args]);
      return { di_id: 'DI-1', note: 'Updated' };
    },
    confirmDeliveryInstruction: async (...args) => {
      calls.push(['confirm', ...args]);
      return { di_id: 'DI-1', status: 'CONFIRMED' };
    },
    cancelDeliveryInstruction: async (...args) => {
      calls.push(['cancel', ...args]);
      return { di_id: 'DI-1', status: 'CANCELLED' };
    },
    deleteDraftDeliveryInstruction: async (...args) => calls.push(['delete', ...args])
  };
  let caller = { user_id: 'U_EXPORT_2', role: 'EXPORT' };
  const handler = createShippingDiHandler({ repo, resolveUser: async () => caller });

  assert.equal((await handler(request('/api/delivery-instructions/DI-1', 'PATCH', { note: 'Updated' }))).status, 200);
  assert.equal((await handler(request('/api/delivery-instructions/DI-1/confirm', 'POST'))).status, 200);
  assert.equal((await handler(request('/api/delivery-instructions/DI-1/cancel', 'POST', { note: 'Schedule moved' }))).status, 200);
  assert.equal((await handler(request('/api/delivery-instructions/DI-1', 'DELETE'))).status, 200);
  assert.deepEqual(calls, [
    ['update', 'DI-1', { note: 'Updated' }, 'U_EXPORT_2'],
    ['confirm', 'DI-1', 'U_EXPORT_2'],
    ['cancel', 'DI-1', 'Schedule moved', 'U_EXPORT_2'],
    ['delete', 'DI-1']
  ]);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/delivery-instructions/DI-1/confirm', 'POST'))).status, 403);
});

test('workspace list forwards approved filters and returns one API-backed DI/shipment row', async () => {
  let receivedFilters;
  const row = {
    di_id: 'DI-1', di_no: 'CUST-DI-1', customer_id: 'C1', customer_name: 'Customer One',
    po_id: 'PO-1', customer_po_no: 'BUYER-1', product_summary: 'Tapioca Pellet', planned_qty_mt: 20,
    container_plan: '1 × 20GP', shipping_month: '2026-09', shipping_period: 'FIRST_HALF',
    planned_loading_date: '2026-09-10', actual_loading_date: null, schedule_result: null,
    booking_no: 'BK-1', shipment_status: 'BOOKED', payment_status: 'UNPAID', public_ref: 'CUST-DI-1'
  };
  const handler = createShippingDiHandler({
    repo: {
      listDeliveryInstructionWorkspace: async (filters) => {
        receivedFilters = filters;
        return [row];
      }
    },
    resolveUser: async () => ({ user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' })
  });

  const response = await handler(request('/api/delivery-instructions/workspace?search=BK-1&shipmentStatus=BOOKED&scheduleResult=ON_PLAN&paymentStatus=UNPAID'));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.deliveryInstructions, [row]);
  assert.deepEqual(receivedFilters, {
    search: 'BK-1', diStatus: undefined, shipmentStatus: 'BOOKED', shippingMonth: undefined,
    scheduleResult: 'ON_PLAN', paymentStatus: 'UNPAID'
  });
});
