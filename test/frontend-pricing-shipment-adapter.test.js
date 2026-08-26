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
