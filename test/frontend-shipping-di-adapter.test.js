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

test('returning-Customer partner suggestions become editable defaults without overriding a choice', async () => {
  const loadSuggestions = extractFunction('loadPhase6PartnerSuggestionsFromApi(customerId)');
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/delivery-instructions/partner-suggestions/C1');
    return success({ partnerSuggestions: { surveyor_partner_id: 'SP-SURVEYOR', forwarder_partner_id: 'SP-FORWARDER' } });
  };
  const elements = {
    customer: { value: 'C1' },
    surveyor: { value: '' },
    forwarder: { value: 'SP-USER-CHOICE' }
  };
  globalThis.document = { getElementById: (id) => elements[id] };
  globalThis.state = {};
  globalThis.loadPhase6PartnerSuggestionsFromApi = new Function(`return (${loadSuggestions.trim()});`)();

  try {
    const suggestions = await globalThis.loadPhase6PartnerSuggestionsFromApi('C1');
    assert.deepEqual(suggestions, { surveyor_partner_id: 'SP-SURVEYOR', forwarder_partner_id: 'SP-FORWARDER' });

    const applySuggestions = extractFunction('applyPhase6PartnerSuggestions(customerInputId, surveyorSelectId, forwarderSelectId)');
    await new Function(`return (${applySuggestions.trim()});`)()('customer', 'surveyor', 'forwarder');
    assert.equal(elements.surveyor.value, 'SP-SURVEYOR');
    assert.equal(elements.forwarder.value, 'SP-USER-CHOICE');
  } finally {
    delete globalThis.fetch;
    delete globalThis.document;
    delete globalThis.state;
    delete globalThis.loadPhase6PartnerSuggestionsFromApi;
  }
});

test('stale partner suggestions cannot overwrite a newer Customer and only prior defaults refresh', async () => {
  const applySuggestions = extractFunction('applyPhase6PartnerSuggestions(customerInputId, surveyorSelectId, forwarderSelectId)');
  const elements = {
    customer: { value: 'C1' }, surveyor: { value: '' }, forwarder: { value: '' }
  };
  const pending = new Map();
  globalThis.document = { getElementById: (id) => elements[id] };
  globalThis.state = {};
  globalThis.loadPhase6PartnerSuggestionsFromApi = (customerId) => new Promise((resolve) => pending.set(customerId, resolve));

  try {
    const apply = new Function(`return (${applySuggestions.trim()});`)();
    const first = apply('customer', 'surveyor', 'forwarder');
    elements.customer.value = 'C2';
    const second = apply('customer', 'surveyor', 'forwarder');
    pending.get('C2')({ surveyor_partner_id: 'SP-S2', forwarder_partner_id: 'SP-F2' });
    await second;
    pending.get('C1')({ surveyor_partner_id: 'SP-S1', forwarder_partner_id: 'SP-F1' });
    await first;
    assert.equal(elements.surveyor.value, 'SP-S2');
    assert.equal(elements.forwarder.value, 'SP-F2');

    elements.forwarder.value = 'SP-USER-CHOICE';
    elements.customer.value = 'C3';
    const third = apply('customer', 'surveyor', 'forwarder');
    pending.get('C3')({ surveyor_partner_id: 'SP-S3', forwarder_partner_id: 'SP-F3' });
    await third;
    assert.equal(elements.surveyor.value, 'SP-S3');
    assert.equal(elements.forwarder.value, 'SP-USER-CHOICE');
  } finally {
    delete globalThis.document;
    delete globalThis.state;
    delete globalThis.loadPhase6PartnerSuggestionsFromApi;
  }
});

test('new DI Customer selection requests partner suggestions for editable defaults', () => {
  const createForm = extractFunction('openCreatePhase6DeliveryInstruction()');
  assert.match(createForm, /applyPhase6PartnerSuggestions\('phase6NewCustomer', 'phase6NewSurveyor', 'phase6NewForwarder'\)/);
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

test('finalizePhase6Invoice promotes a PRELIMINARY invoice through the focused FINAL endpoint', async () => {
  const code = extractFunction('finalizePhase6Invoice(shipmentId, invoiceId)');
  globalThis.document = { getElementById: () => ({ value: '[{"poRevisionLineId":"LINE-1","qtyMt":9.5}]' }) };
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments-v2/S1/invoices/INV1/finalize');
    assert.equal(options.method, 'PATCH');
    assert.deepEqual(JSON.parse(options.body), { lines: [{ poRevisionLineId: 'LINE-1', qtyMt: 9.5 }] });
    return success({ invoice: { invoice_id: 'INV1', version: 'FINAL' } });
  };
  globalThis.selectPhase6DeliveryInstruction = async () => {};
  globalThis.state = { selectedPhase6DeliveryInstructionId: 'DI1' };

  try {
    await new Function(`return (${code.trim()});`)()('S1', 'INV1');
  } finally {
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.selectPhase6DeliveryInstruction;
    delete globalThis.state;
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

test('restricted list rendering and requests use only each approved workspace read model', async () => {
  const renderList = extractFunction('renderPhase6DeliveryInstructionList()');
  const loadList = extractFunction('loadDeliveryInstructionsFromApi()');
  const escape = new Function(`return (${extractFunction('escapePhase6Text(value)').trim()});`)();
  const requests = [];
  globalThis.fetch = async (url) => { requests.push(url); return success({ deliveryInstructions: [] }); };
  globalThis.renderView = () => {};
  globalThis.canEditPhase6Shipping = () => false;
  globalThis.escapePhase6Text = escape;
  globalThis.phase6StatusBadge = (value) => `<span>${escape(value || '-')}</span>`;

  try {
    globalThis.state = {
      currentUser: { role: 'EXTERNAL_SALES' }, deliveryInstructions: [{
        detail_ref: 'REF-1', di_no: 'DI-1', di_status: 'IN_PROGRESS', booking_no: 'BK-1',
        planned_loading_date: '2026-09-08', actual_loading_date: null,
        schedule_result: 'ON_PLAN', shipment_status: 'BOOKED'
      }], phase6Filters: { diStatus: 'IN_PROGRESS', shipmentStatus: 'BOOKED', shippingMonth: '2099-12', scheduleResult: 'ON_PLAN', paymentStatus: 'PAID' },
      phase6Search: 'hidden', phase6ShippingError: ''
    };
    globalThis.isRestrictedPhase6Role = () => true;
    globalThis.canSearchPhase6Workspace = () => false;
    globalThis.canFilterPhase6Schedule = () => true;
    globalThis.canFilterPhase6Payment = () => false;
    let markup = new Function(`return (${renderList.trim()});`)()();
    assert.doesNotMatch(markup, />Planned Qty</);
    assert.doesNotMatch(markup, />Container Plan</);
    assert.doesNotMatch(markup, />Shipping Plan</);
    assert.doesNotMatch(markup, /All shipping months/);
    await new Function(`return (${loadList.trim()});`)()();
    assert.equal(requests.at(-1), '/api/delivery-instructions/workspace?diStatus=IN_PROGRESS&shipmentStatus=BOOKED&scheduleResult=ON_PLAN');

    globalThis.state.currentUser.role = 'PRODUCTION_WAREHOUSE';
    globalThis.state.deliveryInstructions = [{
      detail_ref: 'REF-2', product_summary: 'Tapioca', packing_summary: 'Jumbo Bag', planned_qty_mt: 20,
      container_plan: '1 × 40HC', planned_loading_date: '2026-09-08', actual_loading_date: null
    }];
    globalThis.canFilterPhase6Schedule = () => false;
    markup = new Function(`return (${renderList.trim()});`)()();
    assert.doesNotMatch(markup, />DI No\.</);
    assert.doesNotMatch(markup, />Shipping Plan</);
    assert.doesNotMatch(markup, />Shipment Status</);
    assert.match(markup, />Packing</);
    await new Function(`return (${loadList.trim()});`)()();
    assert.equal(requests.at(-1), '/api/delivery-instructions/workspace');
  } finally {
    for (const name of ['fetch', 'renderView', 'canEditPhase6Shipping', 'escapePhase6Text', 'phase6StatusBadge', 'state', 'isRestrictedPhase6Role', 'canSearchPhase6Workspace', 'canFilterPhase6Schedule', 'canFilterPhase6Payment']) delete globalThis[name];
  }
});

test('Phase 6 workspace bootstrap loads the service-partner catalog', () => {
  const workspace = extractFunction('renderShippingDiWorkspace(container)');
  assert.match(workspace, /loadPhase6ServicePartnersFromApi\(\)/);
  assert.doesNotMatch(workspace, /loadPhase6PartnerSuggestionsFromApi\(\)/);
});

test('DRAFT DI selection does not fetch a shipment before confirmation', () => {
  const selectDeliveryInstruction = extractFunction('selectPhase6DeliveryInstruction(diId)');
  assert.match(selectDeliveryInstruction, /di\.di_status === 'DRAFT'/);
  assert.match(selectDeliveryInstruction, /return;/);
});

test('Draft controls use the full edit form and hard-delete endpoint, not confirmed cancellation', () => {
  const draftEditor = extractFunction('openEditPhase6DeliveryInstruction(diId)');
  const draftDeletion = extractFunction('deletePhase6DraftDeliveryInstruction(diId)');
  assert.match(draftEditor, /phase6EditLines/);
  assert.match(draftEditor, /phase6EditContainerPlan/);
  assert.match(draftDeletion, /method: 'DELETE'/);
  assert.doesNotMatch(draftDeletion, /\/cancel/);
});

test('restricted workspace rendering defines shared fields before warehouse detail uses them', () => {
  const renderDetail = extractFunction('renderPhase6DeliveryInstructionDetail(di)');
  assert.ok(renderDetail.indexOf('const field =') < renderDetail.indexOf("PRODUCTION_WAREHOUSE"));
});

test('warehouse detail render executes with the projected loading fields', () => {
  const renderDetail = extractFunction('renderPhase6DeliveryInstructionDetail(di)');
  globalThis.state = {
    currentUser: { role: 'PRODUCTION_WAREHOUSE' },
    phase6ShipmentDetail: {
      planned_loading_date: '2026-09-08',
      actual_loading_date: '2026-09-10',
      container_plan: '1 × 40HC',
      products: [{ product_name: 'Tapioca Pellet' }],
      containers: [{ container_no: 'EGSU1', seal_no: 'SEAL1', lines: [{ qty_mt: 20 }] }]
    }
  };
  globalThis.canEditPhase6Shipping = () => false;
  globalThis.escapePhase6Text = (value) => String(value ?? '');
  try {
    const html = new Function(`return (${renderDetail.trim()});`)()({ di_no: 'DI-1' });
    assert.match(html, /Loading plan/);
    assert.match(html, /EGSU1/);
  } finally {
    delete globalThis.state;
    delete globalThis.canEditPhase6Shipping;
    delete globalThis.escapePhase6Text;
  }
});

test('list actions use data attributes and escape hostile DI labels', () => {
  const list = extractFunction('renderPhase6DeliveryInstructionList()');
  const escape = extractFunction('escapePhase6Text(value)');
  const escapePhase6Text = new Function(`return (${escape.trim()});`)();
  const hostile = `O'Reilly <img src=x onerror=alert(1)>`;
  const escaped = escapePhase6Text(hostile);
  assert.match(list, /data-phase6-detail-ref/);
  assert.doesNotMatch(list, /onclick="selectPhase6DeliveryInstruction\('/);
  assert.equal(escaped, 'O&#39;Reilly &lt;img src=x onerror=alert(1)&gt;');
  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    deliveryInstructions: [{ di_id: hostile, di_no: hostile, di_status: 'CONFIRMED' }],
    phase6Filters: {}, phase6Search: '', phase6ShippingError: '', phase6ShippingLoading: false
  };
  globalThis.canSearchPhase6Workspace = () => true;
  globalThis.canFilterPhase6Schedule = () => true;
  globalThis.canFilterPhase6Payment = () => true;
  globalThis.isRestrictedPhase6Role = () => false;
  globalThis.canEditPhase6Shipping = () => false;
  globalThis.escapePhase6Text = escapePhase6Text;
  globalThis.phase6StatusBadge = (value) => `<span>${escapePhase6Text(value || '-')}</span>`;
  try {
    const markup = new Function(`return (${list.trim()});`)()();
    assert.match(markup, /data-phase6-detail-ref="O&#39;Reilly &lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.doesNotMatch(markup, /<img src=x onerror=alert/);
  } finally {
    delete globalThis.state;
    delete globalThis.canSearchPhase6Workspace;
    delete globalThis.canFilterPhase6Schedule;
    delete globalThis.canFilterPhase6Payment;
    delete globalThis.isRestrictedPhase6Role;
    delete globalThis.canEditPhase6Shipping;
    delete globalThis.escapePhase6Text;
    delete globalThis.phase6StatusBadge;
  }
});

test('detail actions keep hostile IDs out of inline JavaScript and include confirmed cancellation', () => {
  const detail = extractFunction('renderPhase6DeliveryInstructionDetail(di)');
  assert.doesNotMatch(detail, /onclick=/);
  assert.match(detail, /action\('cancel-confirmed'/);
  assert.match(detail, /data-phase6-shipment-id=/);
  assert.match(detail, /finalize-invoice/);
  const escape = new Function(`return (${extractFunction('escapePhase6Text(value)').trim()});`)();
  const hostile = `S'1 <img src=x onerror=alert(1)>`;
  globalThis.state = {
    currentUser: { role: 'EXPORT' },
    phase6ShipmentDetail: { shipment_id: hostile, status: 'PLANNING', containers: [] },
    phase6PoBalances: [], phase6ShipmentInvoices: [], phase6ShipmentHistory: [], phase6CustomerCredits: []
  };
  globalThis.canEditPhase6Shipping = () => true;
  globalThis.escapePhase6Text = escape;
  globalThis.phase6PartnerOptions = () => '';
  try {
    const markup = new Function(`return (${detail.trim()});`)()({
      di_id: hostile, di_no: hostile, di_status: 'CONFIRMED', status: 'CONFIRMED'
    });
    assert.doesNotMatch(markup, /onclick=/);
    assert.match(markup, /data-phase6-shipment-id="S&#39;1 &lt;img src=x onerror=alert\(1\)&gt;"/);
    assert.doesNotMatch(markup, /<img src=x onerror=alert/);
  } finally {
    delete globalThis.state;
    delete globalThis.canEditPhase6Shipping;
    delete globalThis.escapePhase6Text;
    delete globalThis.phase6PartnerOptions;
  }
});

test('booking fields become read-only after the Shipment is BOOKED', () => {
  const detail = extractFunction('renderPhase6DeliveryInstructionDetail(di)');
  assert.match(detail, /const bookingWritable = write && shipment\?\.status === 'PLANNING'/);
  assert.match(detail, /name === 'save-booking' && !bookingWritable/);
});

test('Phase 6 refresh actions use the selected opaque reference', () => {
  const binding = extractFunction('bindPhase6WorkspaceActions(container)');
  assert.match(binding, /refresh-detail/);
  assert.match(binding, /state\.selectedPhase6DeliveryInstructionId/);
  assert.match(binding, /cancelConfirmedPhase6DeliveryInstruction/);
});

test('confirmed DI cancellation uses its separate cancellation endpoint', async () => {
  const cancel = extractFunction('cancelConfirmedPhase6DeliveryInstruction(diId)');
  globalThis.state = {
    selectedPhase6DeliveryInstructionId: 'DI1',
    deliveryInstructions: [{ di_id: 'DI1', di_status: 'CONFIRMED' }]
  };
  globalThis.prompt = () => 'Customer cancellation';
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/delivery-instructions/DI1/cancel');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { note: 'Customer cancellation' });
    return success({ deliveryInstruction: { di_id: 'DI1', status: 'CANCELLED' } });
  };
  globalThis.clearPhase6DeliveryInstructionSelection = () => {};
  globalThis.refreshPhase6ShippingWorkspace = async () => {};
  try {
    await new Function(`return (${cancel.trim()});`)()();
  } finally {
    delete globalThis.state;
    delete globalThis.prompt;
    delete globalThis.fetch;
    delete globalThis.clearPhase6DeliveryInstructionSelection;
    delete globalThis.refreshPhase6ShippingWorkspace;
  }
});

test('optional customer DI numbers retain supplied whitespace while blank input becomes null', () => {
  const optionalDiNo = extractFunction('phase6OptionalCustomerDiNo(elementId)');
  globalThis.document = { getElementById: () => ({ value: '  Customer DI  ' }) };
  try {
    const fn = new Function(`return (${optionalDiNo.trim()});`)();
    assert.equal(fn('phase6NewDiNo'), '  Customer DI  ');
    globalThis.document = { getElementById: () => ({ value: '   ' }) };
    assert.equal(fn('phase6NewDiNo'), null);
  } finally {
    delete globalThis.document;
  }
});
