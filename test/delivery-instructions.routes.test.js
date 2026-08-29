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
