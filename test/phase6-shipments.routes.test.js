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

test('Phase 6 read routes use their explicit Shipment-ID and DI-ID repository contracts', async () => {
  const shipment = { shipment_id: 'SHP-1', di_id: 'DI-1', status: 'PLANNING' };
  const lookups = [];
  const handler = createShippingDiHandler({
    repo: {
      getPhase6ShipmentByDeliveryInstructionId: async (identifier) => {
        lookups.push(['di', identifier]);
        return identifier === 'DI-1' ? shipment : null;
      },
      getPhase6ShipmentByShipmentId: async (identifier) => {
        lookups.push(['shipment', identifier]);
        return identifier === 'SHP-1' ? shipment : null;
      }
    },
    resolveUser: async () => ({ user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' })
  });

  const response = await handler(request('/api/delivery-instructions/DI-1/shipment'));
  const shipmentResponse = await handler(request('/api/shipments-v2/SHP-1'));
  const missing = await handler(request('/api/delivery-instructions/DI-MISSING/shipment'));
  const crossIdentifier = await handler(request('/api/shipments-v2/DI-1'));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.shipment, shipment);
  assert.equal(shipmentResponse.status, 200);
  assert.deepEqual((await shipmentResponse.json()).data.shipment, shipment);
  assert.equal(missing.status, 404);
  assert.equal(crossIdentifier.status, 404);
  assert.deepEqual(lookups, [['di', 'DI-1'], ['shipment', 'SHP-1'], ['di', 'DI-MISSING'], ['shipment', 'DI-1']]);
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

test('PUT /api/shipments-v2/:id/schedule lets operational writers update loading dates', async () => {
  const calls = [];
  const scheduled = { shipment_id: 'SHP-1', status: 'LOADED', actual_loading_date: '2026-09-15', schedule_result: 'ON_PLAN' };
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const handler = createShippingDiHandler({
    repo: {
      updateShipmentSchedule: async (...args) => {
        calls.push(args);
        return scheduled;
      }
    },
    resolveUser: async () => caller
  });
  const payload = { actualLoadingDate: '2026-09-15' };

  const response = await handler(request('/api/shipments-v2/SHP-1/schedule', 'PUT', payload));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.shipment, scheduled);
  assert.deepEqual(calls, [['SHP-1', payload, 'U_EXPORT']]);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/schedule', 'PUT', payload))).status, 403);
  assert.equal(calls.length, 1);
});

test('PUT /api/shipments-v2/:id/containers lets operational writers replace actual Container data', async () => {
  const calls = [];
  const containers = [{ containerNo: 'EGSU2548896', lines: [{ poRevisionLineId: 'LINE-1', numberOfBags: 10, netWeightMt: 9.5 }] }];
  const updated = { actual_qty_mt: 9.5, shipment: { shipment_id: 'SHP-1', status: 'LOADED' } };
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const handler = createShippingDiHandler({
    repo: {
      replaceShipmentContainers: async (...args) => {
        calls.push(args);
        return updated;
      }
    },
    resolveUser: async () => caller
  });

  const response = await handler(request('/api/shipments-v2/SHP-1/containers', 'PUT', { containers }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, updated);
  assert.deepEqual(calls, [['SHP-1', containers, 'U_EXPORT']]);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/containers', 'PUT', { containers }))).status, 403);
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
      },
      updateShipmentSchedule: async () => {
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

  const scheduleResponse = await missing(request('/api/shipments-v2/SHP-MISSING/schedule', 'PUT', { actualLoadingDate: '2026-09-15' }));
  assert.equal(scheduleResponse.status, 404);
  assert.equal((await scheduleResponse.json()).message, 'SHIPMENT_NOT_FOUND');
});

test('worker dispatches the /api/shipments-v2 namespace to the Phase 6 handler', async () => {
  const response = await worker.fetch(
    request('/api/shipments-v2/SHP-1/booking', 'PUT', { bookingNo: 'BK-01' }),
    { DB: {} }
  );

  assert.equal(response.status, 401);
  assert.equal((await response.json()).message, 'Authentication required.');
});

test('Shipment Invoice routes expose reads and restrict Invoice writes to operational writers', async () => {
  const calls = [];
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const invoice = { invoice_id: 'INV-1', invoice_no: 'WCAT001/2026', version: 'PRELIMINARY' };
  const handler = createShippingDiHandler({
    repo: {
      createShipmentInvoice: async (...args) => {
        calls.push(['create', ...args]);
        return invoice;
      },
      updateShipmentInvoice: async (...args) => {
        calls.push(['update', ...args]);
        return invoice;
      },
      finalizeShipmentInvoice: async (...args) => {
        calls.push(['finalize', ...args]);
        return { ...invoice, version: 'FINAL' };
      },
      getShipmentInvoices: async (...args) => {
        calls.push(['list', ...args]);
        return [invoice];
      }
    },
    resolveUser: async () => caller
  });
  const payload = { invoiceNo: 'WCAT001/2026', version: 'PRELIMINARY', lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 105 }] };

  const created = await handler(request('/api/shipments-v2/SHP-1/invoices', 'POST', payload));
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).data.invoice, invoice);
  assert.deepEqual(calls[0], ['create', 'SHP-1', payload, 'U_EXPORT']);

  const listed = await handler(request('/api/shipments-v2/SHP-1/invoices'));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.invoices, [invoice]);
  assert.deepEqual(calls[1], ['list', 'SHP-1']);

  const updated = await handler(request('/api/shipments-v2/SHP-1/invoices/INV-1', 'PUT', payload));
  assert.equal(updated.status, 200);
  assert.deepEqual(calls[2], ['update', 'INV-1', payload, 'U_EXPORT', 'SHP-1']);

  const finalized = await handler(request('/api/shipments-v2/SHP-1/invoices/INV-1/finalize', 'PATCH', { lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }] }));
  assert.equal(finalized.status, 200);
  assert.deepEqual(calls[3], ['finalize', 'INV-1', [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }], 'U_EXPORT', 'SHP-1']);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/invoices', 'POST', payload))).status, 403);
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/invoices/INV-1', 'PUT', payload))).status, 403);
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/invoices/INV-1/finalize', 'PATCH', { lines: [] }))).status, 403);
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/invoices'))).status, 200);
});

test('PUT /api/shipments-v2/:id/documents lets operational writers record shipment-level document delivery', async () => {
  const calls = [];
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const shipment = { shipment_id: 'SHP-1', status: 'DOCS_SENT' };
  const handler = createShippingDiHandler({
    repo: {
      updateShipmentDocuments: async (...args) => {
        calls.push(args);
        return shipment;
      }
    },
    resolveUser: async () => caller
  });
  const payload = {
    allShipDocsDriveUrl: 'https://drive.google.com/drive/folders/all-ship-docs',
    digitalDocsSentDate: '2026-09-01',
    originalDocsRequired: false
  };

  const response = await handler(request('/api/shipments-v2/SHP-1/documents', 'PUT', payload));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.shipment, shipment);
  assert.deepEqual(calls, [['SHP-1', payload, 'U_EXPORT']]);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/documents', 'PUT', payload))).status, 403);
  assert.equal(calls.length, 1);
});

test('Customer Credit and Payment routes expose reads and restrict writes to operational writers', async () => {
  const calls = [];
  let caller = { user_id: 'U_EXPORT', role: 'EXPORT' };
  const credit = { credit_id: 'CR-1', customer_id: 'C1', amount: 100, remaining_amount: 100 };
  const shipment = { shipment_id: 'SHP-1', payment_status: 'PARTIAL' };
  const handler = createShippingDiHandler({
    repo: {
      createCustomerCredit: async (...args) => {
        calls.push(['createCredit', ...args]);
        return credit;
      },
      listCustomerCredits: async (...args) => {
        calls.push(['listCredits', ...args]);
        return [credit];
      },
      updateShipmentPayment: async (...args) => {
        calls.push(['payment', ...args]);
        return shipment;
      }
    },
    resolveUser: async () => caller
  });
  const creditPayload = { customerId: 'C1', amount: 100, reason: 'Commercial adjustment', requestKey: 'route-credit-create' };
  const paymentPayload = { cashReceivedAmount: 50, paymentNote: 'Partial collection' };

  const created = await handler(request('/api/customer-credits', 'POST', creditPayload));
  assert.equal(created.status, 200);
  assert.deepEqual((await created.json()).data.credit, credit);
  assert.deepEqual(calls[0], ['createCredit', creditPayload, 'U_EXPORT']);

  const listed = await handler(request('/api/customer-credits?customerId=C1'));
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).data.customerCredits, [credit]);
  assert.deepEqual(calls[1], ['listCredits', { customerId: 'C1' }]);

  const updated = await handler(request('/api/shipments-v2/SHP-1/payment', 'PUT', paymentPayload));
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).data.shipment, shipment);
  assert.deepEqual(calls[2], ['payment', 'SHP-1', paymentPayload, 'U_EXPORT']);

  caller = { user_id: 'U_SUPPORT', role: 'SALES_SUPPORT' };
  assert.equal((await handler(request('/api/customer-credits', 'POST', creditPayload))).status, 403);
  assert.equal((await handler(request('/api/shipments-v2/SHP-1/payment', 'PUT', paymentPayload))).status, 403);
  assert.equal((await handler(request('/api/customer-credits?customerId=C1'))).status, 200);
});

test('Shipment completion remains automatic with no manual completion route', async () => {
  const handler = createShippingDiHandler({
    repo: {},
    resolveUser: async () => ({ user_id: 'U_EXPORT', role: 'EXPORT' })
  });

  assert.equal((await handler(request('/api/shipments-v2/SHP-1/complete', 'PATCH'))).status, 404);
});
