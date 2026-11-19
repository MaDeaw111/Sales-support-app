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
  
  let braceCount = 1;
  let index = openBrace + 1;
  while (braceCount > 0 && index < html.length) {
    if (html[index] === '{') braceCount++;
    else if (html[index] === '}') braceCount--;
    index++;
  }
  return html.slice(start, index);
}

test('loadPriceNotesFromApi successful load replaces state.priceNotes', async () => {
  const code = extractFunction('loadPriceNotesFromApi()');
  const mockState = { priceNotes: [] };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { priceNotes: [{ id: 'PN-001' }] } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.priceNotes.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('savePriceNoteToApi calls POST /api/manager-price-notes', async () => {
  const code = extractFunction('savePriceNoteToApi(payload)');
  globalThis.fetch = async (url, options) => {
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { priceNote: { id: 'PN-002' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn({ offerPriceUsdPerMt: 360 });
    assert.equal(result.id, 'PN-002');
  } finally {
    delete globalThis.fetch;
  }
});

test('loadFreightQuotesFromApi successful load replaces state.freightQuotes', async () => {
  const code = extractFunction('loadFreightQuotesFromApi()');
  const mockState = { freightQuotes: [] };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/freight-quotes');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { freightQuotes: [{ quote_id: 'FQ-001' }] } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.freightQuotes.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveFreightQuoteToApi calls POST /api/freight-quotes', async () => {
  const code = extractFunction('saveFreightQuoteToApi(payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/freight-quotes');
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { freightQuote: { quote_id: 'FQ-002' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn({ originPort: 'BKK' });
    assert.equal(result.quote_id, 'FQ-002');
  } finally {
    delete globalThis.fetch;
  }
});

test('loadShipmentExpensesFromApi successful load replaces state.shipmentExpenses', async () => {
  const code = extractFunction('loadShipmentExpensesFromApi(shipmentId)');
  const mockState = { shipmentExpenses: [], totalActualExportCostThb: 0, freightVariance: null };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/shipments/SH1/expenses');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            expenses: [{ expense_id: 'EXP-1' }],
            totalActualExportCostThb: 15000,
            freightVariance: { variance: -100 }
          }
        };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn('SH1');
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.shipmentExpenses.length, 1);
    assert.equal(mockState.totalActualExportCostThb, 15000);
    assert.equal(mockState.freightVariance.variance, -100);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveShipmentExpenseToApi calls POST /api/shipments/:id/expenses', async () => {
  const code = extractFunction('saveShipmentExpenseToApi(shipmentId, payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments/SH1/expenses');
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { expense: { expense_id: 'EXP-2' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn('SH1', { amount: 1000 });
    assert.equal(result.expense_id, 'EXP-2');
  } finally {
    delete globalThis.fetch;
  }
});

test('loadShipmentDocumentLinksFromApi successful load replaces state.shipmentDocumentLinks', async () => {
  const code = extractFunction('loadShipmentDocumentLinksFromApi(shipmentId)');
  const mockState = { shipmentDocumentLinks: [] };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/shipments/SH1/documents');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { documentLinks: [{ link_id: 'DOC-1' }] } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn('SH1');
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.shipmentDocumentLinks.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveShipmentDocumentLinkToApi calls POST /api/shipments/:id/documents', async () => {
  const code = extractFunction('saveShipmentDocumentLinkToApi(shipmentId, payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments/SH1/documents');
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { documentLink: { link_id: 'DOC-2' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn('SH1', { title: 'PO doc' });
    assert.equal(result.link_id, 'DOC-2');
  } finally {
    delete globalThis.fetch;
  }
});

test('loadExpenseCategoriesFromApi successful load replaces state.expenseCategories', async () => {
  const code = extractFunction('loadExpenseCategoriesFromApi()');
  const mockState = { expenseCategories: [] };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/expense-categories');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { categories: [{ id: 'CAT-1' }] } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.expenseCategories.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('ensureShipmentAnchorToApi calls POST /api/shipments/:id/ensure', async () => {
  const code = extractFunction('ensureShipmentAnchorToApi(shipmentId, payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments/SH1/ensure');
    assert.equal(options.method, 'POST');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { shipment: { shipment_id: 'SH1' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn('SH1', { poId: 'PO1' });
    assert.equal(result.shipment_id, 'SH1');
  } finally {
    delete globalThis.fetch;
  }
});

test('updateShipmentToApi calls PUT /api/shipments/:id', async () => {
  const code = extractFunction('updateShipmentToApi(shipmentId, payload)');
  globalThis.fetch = async (url, options) => {
    assert.equal(url, '/api/shipments/SH1');
    assert.equal(options.method, 'PUT');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { shipment: { shipment_id: 'SH1', is_one_container: 1 } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn('SH1', { isOneContainer: 1 });
    assert.equal(result.is_one_container, 1);
  } finally {
    delete globalThis.fetch;
  }
});

test('loadShipmentDetailFromApi calls GET /api/shipments/:id', async () => {
  const code = extractFunction('loadShipmentDetailFromApi(shipmentId)');
  const mockState = { currentShipment: null };
  let renderViewCalled = false;
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/shipments/SH1');
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { shipment: { shipment_id: 'SH1' } } };
      }
    };
  };
  try {
    const fn = new Function(`return (${code.trim()});`)();
    const result = await fn('SH1');
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.currentShipment.shipment_id, 'SH1');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('filterPnCustomerDropdown filters pnCustomer select element based on selected salesperson', () => {
  const code = extractFunction('filterPnCustomerDropdown(salesUserId)');
  const mockState = {
    customers: [
      { id: 'C1', name: 'Cust 1', ownerId: 'S1' },
      { id: 'C2', name: 'Cust 2', ownerId: 'S2' }
    ]
  };
  globalThis.state = mockState;
  globalThis.getScopedCustomers = () => mockState.customers;

  const select = {
    value: 'C1',
    innerHTML: '',
  };
  globalThis.document = {
    getElementById: (id) => {
      if (id === 'pnCustomer') return select;
      return null;
    }
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    fn('S2');
    assert.match(select.innerHTML, /Cust 2/);
    assert.ok(!select.innerHTML.includes('Cust 1'));
    assert.equal(select.value, 'C2');
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.document;
  }
});

test('frontend contains zero leftover mock standard/special prices or Apps Script pricing banner', () => {
  assert.doesNotMatch(html, /STD-2026-001|STD-2026-004|SPR-2026-0012|PRD-005|PRD-007/);
  assert.doesNotMatch(html, /when the Apps Script layer is connected/);
});

test('loadPricingFromApi hydrates state.standardPrices and state.specialPrices from /api/pricing', async () => {
  const code = extractFunction('loadPricingFromApi()');
  const mockState = { standardPrices: [], specialPrices: [], pricingLoaded: false };
  let renders = 0;
  globalThis.state = mockState;
  globalThis.renderView = () => { renders += 1; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/pricing');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            standardPrices: [{ productId: 'PRD-001', productCode: 'THP65', hasActivePrice: true, id: 'STD-0001', pricePerMt: 190, fobUsdPerMt: 190, status: 'ACTIVE' }],
            specialPrices: [{ id: 'SPR-0001', customerId: 'CUST-001', productId: 'PRD-001', approvedPriceUsd: 182, approvalStatus: 'APPROVED' }]
          }
        };
      }
    };
  };

  try {
    await new Function(`return (${code.trim()});`)()();
    assert.equal(renders, 1);
    assert.equal(mockState.pricingLoaded, true);
    assert.equal(mockState.standardPrices.length, 1);
    assert.equal(mockState.specialPrices.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('renderPricing lists active D1 products with Set/Edit actions and restricts History button to MANAGER and ADMIN', () => {
  const renderPricing = new Function(`return (${extractFunction('renderPricing(container)').trim()});`)();
  const pricingStatusBadge = new Function(`return (${extractFunction('pricingStatusBadge(status)').trim()});`)();
  const canManagePricing = new Function(`return (${extractFunction('canManagePricing()').trim()});`)();

  globalThis.pricingStatusBadge = pricingStatusBadge;
  globalThis.canManagePricing = canManagePricing;
  globalThis.canWriteFreightQuotes = () => false;
  globalThis.getScopedCustomers = () => [];

  const renderForRole = (role) => {
    globalThis.state = {
      currentUser: { role },
      pricingTab: 'STANDARD',
      products: [
        { id: 'PRD-001', code: 'THP65', shortName: 'THP65', name: 'Tapioca Pellet 65%', status: 'ACTIVE' },
        { id: 'PRD-002', code: 'THP70', shortName: 'THP70', name: 'Tapioca Pellet 70%', status: 'ACTIVE' }
      ],
      standardPrices: [
        { productId: 'PRD-001', productCode: 'THP65', shortName: 'THP65', productName: 'Tapioca Pellet 65%', hasActivePrice: true, id: 'STD-0001', revisionNo: 2, pricePerMt: 190, fobUsdPerMt: 190, currency: 'USD', effectiveFrom: '2026-11-01', validUntil: '2026-12-31', status: 'ACTIVE' },
        { productId: 'PRD-002', productCode: 'THP70', shortName: 'THP70', productName: 'Tapioca Pellet 70%', hasActivePrice: false, id: null, revisionNo: 0, pricePerMt: null, fobUsdPerMt: null, currency: 'USD', effectiveFrom: null, validUntil: null, status: 'NOT_SET' }
      ],
      specialPrices: [],
      priceNotes: [],
      freightQuotes: [],
      adminUsers: []
    };
    const container = { innerHTML: '' };
    renderPricing(container);
    return container.innerHTML;
  };

  try {
    for (const role of ['MANAGER', 'ADMIN']) {
      const markup = renderForRole(role);
      assert.match(markup, /Edit Standard Price/);
      assert.match(markup, /Set Standard Price/);
      assert.match(markup, /Not Set/);
      assert.match(markup, /openProductPriceHistoryModal\('PRD-001'\)/);
      assert.match(markup, /openProductPriceHistoryModal\('PRD-002'\)/);
      assert.match(markup, />History</);
    }

    for (const role of ['SALES_SUPPORT', 'EXTERNAL_SALES']) {
      const markup = renderForRole(role);
      assert.match(markup, /USD 190\.00/);
      assert.match(markup, /Not Set/);
      assert.doesNotMatch(markup, /Set Standard Price|Edit Standard Price|openProductPriceHistoryModal/);
    }
  } finally {
    delete globalThis.pricingStatusBadge;
    delete globalThis.canManagePricing;
    delete globalThis.canWriteFreightQuotes;
    delete globalThis.getScopedCustomers;
    delete globalThis.state;
  }
});

test('saveStandardPrice and openProductPriceHistoryModal call D1 pricing endpoints and render history', async () => {
  const saveStandardPrice = new Function(`return (${extractFunction('saveStandardPrice(productId)').trim()});`)();
  const openProductPriceHistoryModal = new Function(`return (${extractFunction('openProductPriceHistoryModal(productId)').trim()});`)();
  const canManagePricing = new Function(`return (${extractFunction('canManagePricing()').trim()});`)();
  const escapePricingHtml = new Function(`return (${extractFunction('escapePricingHtml(value)').trim()});`)();

  const fields = {
    stdPriceValue: { value: '195.50' },
    stdPriceCurrency: { value: 'USD' },
    stdPriceEffective: { value: '2026-11-20' },
    stdPriceValid: { value: '2026-12-31' },
    stdPriceReason: { value: 'Market revision' },
    stdPriceFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  const calls = [];
  let modalHtml = '';
  let reloaded = 0;
  let closed = 0;

  globalThis.state = { currentUser: { role: 'MANAGER' } };
  globalThis.canManagePricing = canManagePricing;
  globalThis.escapePricingHtml = escapePricingHtml;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.openModal = (markup) => { modalHtml = markup; };
  globalThis.closeModal = () => { closed += 1; };
  globalThis.loadPricingFromApi = async () => { reloaded += 1; };
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/pricing/standard/PRD-001' && options.method === 'PUT') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardPrice: { id: 'STD-0002' } } }; } };
    }
    if (url === '/api/pricing/products/PRD-001/history') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'SUCCESS',
            data: {
              product: { id: 'PRD-001', code: 'THP65', shortName: 'THP65', name: 'Tapioca Pellet 65%' },
              standardPriceHistory: [
                { id: 'STD-0002', revisionNo: 2, previousPricePerMt: 185, pricePerMt: 195.5, currency: 'USD', effectiveFrom: '2026-11-20', validUntil: '2026-12-31', status: 'ACTIVE', changedByName: 'Manager User', changedAt: '2026-11-20 00:10:00', changeReason: 'Market revision' }
              ],
              approvedSpecialPriceHistory: [
                { id: 'SPR-0001', customerName: 'Meelunie B.V.', approvedPriceUsd: 188, validUntil: '2026-12-15', reviewedByName: 'Manager User', reason: 'Volume deal' }
              ]
            }
          };
        }
      };
    }
    throw new Error(`Unexpected fetch: ${options.method} ${url}`);
  };

  try {
    await saveStandardPrice('PRD-001');
    assert.equal(calls[0].url, '/api/pricing/standard/PRD-001');
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].body.pricePerMt, 195.5);
    assert.equal(calls[0].body.changeReason, 'Market revision');
    assert.equal(reloaded, 1);
    assert.equal(closed, 1);

    await openProductPriceHistoryModal('PRD-001');
    assert.equal(calls[1].url, '/api/pricing/products/PRD-001/history');
    assert.match(modalHtml, /Rev\.2/);
    assert.match(modalHtml, /185\.00/);
    assert.match(modalHtml, /195\.50/);
    assert.match(modalHtml, /\+10\.50/);
    assert.match(modalHtml, /Manager User/);
    assert.match(modalHtml, /Market revision/);
    assert.match(modalHtml, /Meelunie B\.V\./);
  } finally {
    delete globalThis.state;
    delete globalThis.canManagePricing;
    delete globalThis.escapePricingHtml;
    delete globalThis.document;
    delete globalThis.openModal;
    delete globalThis.closeModal;
    delete globalThis.loadPricingFromApi;
    delete globalThis.fetch;
  }
});
