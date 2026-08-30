import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const start = html.indexOf(`async function ${name}`) >= 0
    ? html.indexOf(`async function ${name}`)
    : html.indexOf(`function ${name}`);
  assert.ok(start >= 0, `function ${name} must exist`);

  const openBrace = html.indexOf('{', start);
  assert.ok(openBrace >= 0);
  let depth = 1;
  let index = openBrace + 1;
  while (depth > 0 && index < html.length) {
    if (html[index] === '{') depth++;
    else if (html[index] === '}') depth--;
    index++;
  }
  return html.slice(start, index);
}

function success(data) {
  return { ok: true, json: async () => ({ status: 'SUCCESS', data }) };
}

test('loadDeliveryInstructionsFromApi replaces only Phase 6 state', async () => {
  const code = extractFunction('loadDeliveryInstructionsFromApi()');
  globalThis.state = {
    deliveryInstructions: [{ di_id: 'OLD' }],
    customers: [{ id: 'CUST-UNCHANGED' }],
    shipments: [{ id: 'LEGACY-UNCHANGED' }]
  };
  let renders = 0;
  globalThis.renderView = () => { renders++; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/delivery-instructions/workspace');
    return success({ deliveryInstructions: [{ di_id: 'DI1', status: 'DRAFT' }] });
  };

  try {
    await new Function(`return (${code.trim()});`)()();
    assert.deepEqual(globalThis.state.deliveryInstructions, [{ di_id: 'DI1', status: 'DRAFT' }]);
    assert.equal(globalThis.state.customers[0].id, 'CUST-UNCHANGED');
    assert.equal(globalThis.state.shipments[0].id, 'LEGACY-UNCHANGED');
    assert.equal(renders, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadDeliveryInstructionDetailFromApi stores the projected shipment detail', async () => {
  const code = extractFunction('loadDeliveryInstructionDetailFromApi(diId)');
  globalThis.state = { phase6ShipmentDetail: null };
  globalThis.renderView = () => {};
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/delivery-instructions/DI1/shipment');
    return success({ shipment: { shipment_id: 'S1', di_id: 'DI1', status: 'BOOKED' } });
  };

  try {
    const detail = await new Function(`return (${code.trim()});`)()('DI1');
    assert.equal(detail.shipment_id, 'S1');
    assert.equal(globalThis.state.phase6ShipmentDetail.status, 'BOOKED');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveDeliveryInstructionToApi posts a DI DTO and returns the server record', async () => {
  const code = extractFunction('saveDeliveryInstructionToApi(payload, diId = null)');
  const payload = { customerId: 'C1', poId: 'PO1', shippingMonth: '2026-09' };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/delivery-instructions');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), payload);
    return success({ deliveryInstruction: { di_id: 'DI1', ...payload } });
  };

  try {
    const saved = await new Function(`return (${code.trim()});`)()(payload);
    assert.equal(saved.di_id, 'DI1');
  } finally {
    delete globalThis.fetch;
  }
});

test('updatePhase6ShipmentSectionToApi uses the focused section endpoint', async () => {
  const code = extractFunction('updatePhase6ShipmentSectionToApi(shipmentId, section, payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments-v2/S1/booking');
    assert.equal(options.method, 'PUT');
    assert.deepEqual(JSON.parse(options.body), { bookingNo: 'BK-1' });
    return success({ shipment: { shipment_id: 'S1', booking_no: 'BK-1' } });
  };

  try {
    const data = await new Function(`return (${code.trim()});`)()('S1', 'booking', { bookingNo: 'BK-1' });
    assert.equal(data.shipment.booking_no, 'BK-1');
  } finally {
    delete globalThis.fetch;
  }
});

test('Phase 6 adapters reject API errors without replacing displayed state', async () => {
  const code = extractFunction('loadDeliveryInstructionsFromApi()');
  globalThis.state = { deliveryInstructions: [{ di_id: 'KEEP' }] };
  globalThis.renderView = () => assert.fail('a failed response must not render a replacement list');
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ status: 'ERROR', message: 'Permission denied.' }) });

  try {
    const result = await new Function(`return (${code.trim()});`)()();
    assert.equal(result, null);
    assert.equal(globalThis.state.deliveryInstructions[0].di_id, 'KEEP');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('shipping view keeps legacy and Phase 6 workspaces selectable', () => {
  const renderShipping = extractFunction('renderShipping(container)');
  assert.match(renderShipping, /state\.shippingWorkspace/);
  assert.match(renderShipping, /renderShippingDiWorkspace\(container\)/);
  assert.match(renderShipping, /renderLegacyShippingWorkspace\(container\)/);
});

test('DRAFT DI selection does not fetch a shipment before confirmation', () => {
  const selectDeliveryInstruction = extractFunction('selectPhase6DeliveryInstruction(diId)');
  assert.match(selectDeliveryInstruction, /di\.di_status === 'DRAFT'/);
  assert.match(selectDeliveryInstruction, /return;/);
});
