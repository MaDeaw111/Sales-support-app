import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';
import { createShippingDiHandler } from '../src/shipping-di/routes.js';

function request(path, method = 'GET', body = null) {
  return new Request(`https://example.com${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : null
  });
}

test('GET /api/delivery-instructions/:id/shipment exposes the separate rich Shipment to operational readers', async () => {
  const shipment = { shipment_id: 'SHP-1', di_id: 'DI-1', status: 'PLANNING' };
  const lookups = [];
  const handler = createShippingDiHandler({
    repo: {
      getPhase6Shipment: async (identifier) => {
        lookups.push(identifier);
        return identifier === 'DI-1' ? shipment : null;
      }
    },
    resolveUser: async () => ({ user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' })
  });

  const response = await handler(request('/api/delivery-instructions/DI-1/shipment'));
  const missing = await handler(request('/api/delivery-instructions/DI-MISSING/shipment'));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.shipment, shipment);
  assert.equal(missing.status, 404);
  assert.deepEqual(lookups, ['DI-1', 'DI-MISSING']);
});

test('PUT /api/shipments-v2/:id/booking lets operational writers record focused Booking data', async () => {
  const calls = [];
  const booked = { shipment_id: 'SHP-1', status: 'BOOKED', booking_no: 'BK-01' };
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const handler = createShippingDiHandler({
    repo: {
      recordShipmentBooking: async (...args) => {
        calls.push(args);
        return booked;
      }
    },
    resolveUser: async () => caller
  });
  const payload = { bookingNo: 'BK-01', vessel: 'MV A' };

  const response = await handler(request('/api/shipments-v2/SHP-1/booking', 'PUT', payload));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.shipment, booked);
  assert.deepEqual(calls, [['SHP-1', payload, 'U_EXPORT']]);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/booking', 'PUT', payload))).status, 403);
  assert.equal(calls.length, 1);
});

test('Phase 6 Shipment routes require authentication and map missing records to 404', async () => {
  const unauthenticated = createShippingDiHandler({
    repo: {},
    resolveUser: async () => null
  });
  assert.equal((await unauthenticated(request('/api/delivery-instructions/DI-1/shipment'))).status, 401);

  const missing = createShippingDiHandler({
    repo: {
      recordShipmentBooking: async () => {
        const error = new Error('SHIPMENT_NOT_FOUND');
        error.code = 'SHIPMENT_NOT_FOUND';
        throw error;
      }
    },
    resolveUser: async () => ({ user_id: 'U_EXPORT', role: 'EXPORT' })
  });
  const response = await missing(request('/api/shipments-v2/SHP-MISSING/booking', 'PUT', { bookingNo: 'BK-01' }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).message, 'SHIPMENT_NOT_FOUND');
});

test('worker dispatches the /api/shipments-v2 namespace to the Phase 6 handler', async () => {
  const response = await worker.fetch(
    request('/api/shipments-v2/SHP-1/booking', 'PUT', { bookingNo: 'BK-01' }),
    { DB: {} }
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).message, 'Authentication required.');
});
