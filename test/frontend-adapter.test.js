import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function functionBlock(name, nextName) {
  const start = html.indexOf(`function ${name}`);
  const syncEnd = nextName ? html.indexOf(`\n        function ${nextName}`, start) : -1;
  const asyncEnd = nextName ? html.indexOf(`\n        async function ${nextName}`, start) : -1;
  const candidates = [syncEnd, asyncEnd].filter(x => x >= 0);
  const end = candidates.length ? Math.min(...candidates) : html.length;
  assert.ok(start >= 0, `${name} function must exist`);
  return html.slice(start, end);
}

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

const adapter = functionBlock('callBackend(action, payload, onSuccess, onFailure)', 'initApp');

test('callBackend uses Cloudflare gateway fetch transport', () => {
  assert.match(adapter, /fetch\(['"]\/api\/gateway['"]/);
});

test('callBackend no longer invokes Apps Script apiGateway', () => {
  assert.doesNotMatch(adapter, /google\.script\.run[\s\S]*?\.apiGateway/);
});

test('submitLogin uses Cloudflare auth API instead of Apps Script', () => {
  const block = functionBlock('submitLogin(event)', 'bootstrapAuth');
  assert.match(block, /fetch\(['"]\/api\/auth\/login['"]/);
  assert.doesNotMatch(block, /google\.script\.run/);
  assert.doesNotMatch(block, /storeSessionToken\(/);
});

test('bootstrapAuth validates the HttpOnly cookie through /api/auth/me', () => {
  const block = functionBlock('bootstrapAuth()', 'startAuthenticatedApp');
  assert.match(block, /fetch\(['"]\/api\/auth\/me['"]/);
  assert.doesNotMatch(block, /getStoredSessionToken\(/);
  assert.doesNotMatch(block, /google\.script\.run/);
});

test('authenticated bootstrap uses D1 REST loaders and never requests legacy GET_MASTER_DATA', () => {
  const block = functionBlock('startAuthenticatedApp()', 'openChangePasswordModal');
  assert.doesNotMatch(block, /GET_MASTER_DATA/);
  assert.doesNotMatch(block, /callBackend\(/);
  assert.match(block, /loadCustomersFromApi\(\)/);
  assert.match(block, /loadProductsFromApi\(\)/);
  assert.match(block, /loadSpecParametersFromApi\(\)/);
});

test('production shell omits obsolete Sheets sync controls and prototype branding', () => {
  const visibleShell = html.slice(0, html.indexOf('<script>'));
  assert.doesNotMatch(visibleShell, /Sync ทุกเมนู \+ Sheet/);
  assert.doesNotMatch(visibleShell, /10 Core Sheets/);
  assert.doesNotMatch(visibleShell, /Live Connected/);
  assert.doesNotMatch(visibleShell, /Frontend Prototype/);
  assert.match(visibleShell, /WCAT · Sales & Export Operations/);
});

test('frontend contains no dead legacy /api/gateway callBackend invocations', () => {
  assert.doesNotMatch(html, /callBackend\(\s*['"]UPDATE_PO['"]/);
  assert.doesNotMatch(html, /callBackend\(\s*['"]SEED_ALL_MASTER_DATA['"]/);
  assert.doesNotMatch(html, /(?<!function\s)callBackend\(/);
});

test('D1-backed PO Manage detail uses a defined renderer with revision, lines, documents, and history', () => {
  const engine = functionBlock('renderPOEngine(container)', 'renderRealPOListTable');
  const detail = extractFunction('renderRealPODetailCard(po)');
  assert.match(engine, /renderRealPODetailCard\(selectedPo\)/);
  assert.doesNotMatch(detail, /google\.script\.run|callBackend\(/);
  assert.match(detail, /Overview/);
  assert.match(detail, /Lines/);
  assert.match(detail, /Documents/);
  assert.match(detail, /History/);
});

test('password change and sign out use Cloudflare auth endpoints', () => {
  const passwordBlock = functionBlock('submitPasswordChange(forced = false)', 'signOut');
  const signOutBlock = functionBlock('signOut()', 'parseNum');
  assert.match(passwordBlock, /fetch\(['"]\/api\/auth\/change-password['"]/);
  assert.match(signOutBlock, /fetch\(['"]\/api\/auth\/logout['"]/);
  assert.doesNotMatch(passwordBlock, /google\.script\.run/);
  assert.doesNotMatch(signOutBlock, /google\.script\.run/);
});

test('loadCustomersFromApi successful load replaces state.customers', async () => {
  const code = extractFunction('loadCustomersFromApi()');
  
  const mockState = { customers: [{ id: 'mock1' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/customers');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            customers: [{ id: 'api1', name: 'API Cust 1' }]
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.customers.length, 1);
    assert.equal(mockState.customers[0].id, 'api1');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadCustomersFromApi failed load preserves previous state.customers', async () => {
  const code = extractFunction('loadCustomersFromApi()');
  
  const mockState = { customers: [{ id: 'mock1' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    return {
      ok: false
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.customers.length, 1);
    assert.equal(mockState.customers[0].id, 'mock1');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadCustomersFromApi malformed DTO does not overwrite state.customers', async () => {
  const code = extractFunction('loadCustomersFromApi()');
  
  const mockState = { customers: [{ id: 'mock1' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            // customers is missing
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.customers.length, 1);
    assert.equal(mockState.customers[0].id, 'mock1');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveCustomerToApi - create uses POST /api/customers', async () => {
  const code = extractFunction('saveCustomerToApi(customer, mode)');
  
  let fetchMethod = '';
  let fetchUrl = '';
  let fetchBody = null;
  
  globalThis.fetch = async (url, options) => {
    fetchUrl = url;
    fetchMethod = options.method;
    fetchBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            customer: { id: 'CUST-NEW', name: 'Test' }
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const saved = await fn({ name: 'Test' }, 'create');
    assert.equal(fetchUrl, '/api/customers');
    assert.equal(fetchMethod, 'POST');
    assert.equal(fetchBody.name, 'Test');
    assert.equal(saved.id, 'CUST-NEW');
  } finally {
    delete globalThis.fetch;
  }
});

test('saveCustomerToApi - update uses PUT /api/customers/:id', async () => {
  const code = extractFunction('saveCustomerToApi(customer, mode)');
  
  let fetchMethod = '';
  let fetchUrl = '';
  let fetchBody = null;
  
  globalThis.fetch = async (url, options) => {
    fetchUrl = url;
    fetchMethod = options.method;
    fetchBody = JSON.parse(options.body);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            customer: { id: 'CUST-1', name: 'Updated' }
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const saved = await fn({ id: 'CUST-1', name: 'Updated' }, 'update');
    assert.equal(fetchUrl, '/api/customers/CUST-1');
    assert.equal(fetchMethod, 'PUT');
    assert.equal(fetchBody.name, 'Updated');
    assert.equal(saved.id, 'CUST-1');
  } finally {
    delete globalThis.fetch;
  }
});

test('saveCustomerToApi - throws error on failed response or malformed response', async () => {
  const code = extractFunction('saveCustomerToApi(customer, mode)');
  
  globalThis.fetch = async (url, options) => {
    return {
      ok: false,
      status: 400,
      async json() {
        return {
          status: 'ERROR',
          message: 'Validation failed'
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await assert.rejects(async () => {
      await fn({ name: 'Test' }, 'create');
    }, /Validation failed/);
  } finally {
    delete globalThis.fetch;
  }
});

test('EXTERNAL_SALES UI cannot invoke Customer mutation controls', () => {
  const canCreateCode = extractFunction('canCreateCustomer()');
  const canEditCode = extractFunction('canEditCustomer()');
  
  const fnCreate = new Function('state', `return (${canCreateCode.trim()})();`);
  const fnEdit = new Function('state', `return (${canEditCode.trim()})();`);
  
  const stateAdmin = { currentUser: { role: 'ADMIN' } };
  const stateManager = { currentUser: { role: 'MANAGER' } };
  const stateSupport = { currentUser: { role: 'SALES_SUPPORT' } };
  const stateExternal = { currentUser: { role: 'EXTERNAL_SALES' } };
  
  assert.equal(fnCreate(stateAdmin), true);
  assert.equal(fnCreate(stateManager), true);
  assert.equal(fnCreate(stateSupport), true);
  assert.equal(fnCreate(stateExternal), false);
  
  assert.equal(fnEdit(stateAdmin), true);
  assert.equal(fnEdit(stateManager), true);
  assert.equal(fnEdit(stateSupport), true);
  assert.equal(fnEdit(stateExternal), false);
});

test('getAdminDashboardData - customers metric uses scoped customers length', () => {
  const code = extractFunction('getAdminDashboardData()');
  const getScopedCustomersCode = extractFunction('getScopedCustomers()');

  const mockState = {
    customers: [
      { id: 'CUST-001', ownerId: 'USR-0001', status: 'ACTIVE_CUSTOMER' },
      { id: 'CUST-002', ownerId: 'USR-0002', status: 'ACTIVE_CUSTOMER' }
    ],
    users: [
      { id: 'USR-0001', role: 'EXTERNAL_SALES', status: 'ACTIVE' }
    ],
    products: [],
    logisticsProviders: [],
    pos: [],
    diRecords: [],
    currentUser: { id: 'USR-ADMIN', role: 'ADMIN' }
  };

  globalThis.state = mockState;
  
  globalThis.getScopedCustomers = new Function('state', `
    return (${getScopedCustomersCode.trim()})();
  `).bind(null, mockState);

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const data = fn();
    assert.equal(data.customers.length, 2);

    mockState.customers.push({ id: 'CUST-003', ownerId: 'USR-0001', status: 'ACTIVE_CUSTOMER' });
    const dataUpdated = fn();
    assert.equal(dataUpdated.customers.length, 3);
    
    assert.equal(dataUpdated.products.length, 0);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
  }
});

test('getExternalSalesDashboardData - customers metric reflects scoped customers count', () => {
  const code = extractFunction('getExternalSalesDashboardData()');

  const mockState = {
    customers: [
      { id: 'CUST-001', ownerId: 'USR-0005', status: 'ACTIVE_CUSTOMER' }
    ],
    users: [],
    pos: [],
    diRecords: [],
    currentUser: { id: 'USR-0005', role: 'EXTERNAL_SALES' }
  };

  globalThis.state = mockState;
  
  globalThis.getScopedCustomers = () => mockState.customers;
  globalThis.getScopedPOs = () => [];
  globalThis.getScopedDIRecords = () => [];
  globalThis.getDashboardPaymentRecords = () => [];

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const data = fn();
    assert.equal(data.customers.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.getScopedPOs;
    delete globalThis.getScopedDIRecords;
    delete globalThis.getDashboardPaymentRecords;
  }
});

test('renderDashboard - Active Customers counts only ACTIVE_CUSTOMER status', () => {
  const code = extractFunction('renderDashboard(container)');
  
  const mockState = {
    currentUser: { role: 'SALES_SUPPORT' }
  };
  
  globalThis.state = mockState;
  
  globalThis.getScopedCustomers = () => [
    { id: 'CUST-001', status: 'ACTIVE_CUSTOMER' },
    { id: 'CUST-002', status: 'INACTIVE_CUSTOMER' },
    { id: 'CUST-003', status: 'INACTIVE' }
  ];
  
  globalThis.getScopedPOs = () => [];
  globalThis.getScopedDIRecords = () => [];
  globalThis.getDashboardPaymentRecords = () => [];
  globalThis.deriveDIStage = () => '';
  globalThis.calculateDIActualQty = () => 0;
  globalThis.renderDashboardAction = () => '';
  globalThis.renderDashboardHeader = () => '';
  globalThis.renderDashboardCard = (label, value) => {
    if (label === 'Active Customers') {
      return `CARD:${label}:${value}`;
    }
    return '';
  };
  globalThis.renderSalesSupportWorkQueue = () => '';
  globalThis.renderSalesSupportCustomerFollowUp = () => '';
  globalThis.renderSalesSupportUpcoming = () => '';
  globalThis.renderSalesSupportPOProgress = () => '';
  globalThis.renderSalesSupportTrend = () => '';
  globalThis.renderRecentActivity = () => '';

  try {
    const container = { innerHTML: '' };
    const fn = new Function('container', `return (${code.trim()})(container);`);
    fn(container);
    
    assert.match(container.innerHTML, /CARD:Active Customers:1/);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.getScopedPOs;
    delete globalThis.getScopedDIRecords;
    delete globalThis.getDashboardPaymentRecords;
    delete globalThis.deriveDIStage;
    delete globalThis.calculateDIActualQty;
    delete globalThis.renderDashboardAction;
    delete globalThis.renderDashboardHeader;
    delete globalThis.renderDashboardCard;
    delete globalThis.renderSalesSupportWorkQueue;
    delete globalThis.renderSalesSupportCustomerFollowUp;
    delete globalThis.renderSalesSupportUpcoming;
    delete globalThis.renderSalesSupportPOProgress;
    delete globalThis.renderSalesSupportTrend;
    delete globalThis.renderRecentActivity;
  }
});

test('loadCustomerOwnersFromApi successful load replaces state.customerOwners', async () => {
  const code = extractFunction('loadCustomerOwnersFromApi()');
  
  const mockState = { customerOwners: [] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/customer-owners');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            owners: [{ id: 'USR-0002', name: 'Sales 1' }]
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.customerOwners.length, 1);
    assert.equal(mockState.customerOwners[0].id, 'USR-0002');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadCustomerOwnersFromApi failed/malformed response preserves previous owner state', async () => {
  const code = extractFunction('loadCustomerOwnersFromApi()');
  
  const mockState = { customerOwners: [{ id: 'prev' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  
  globalThis.fetch = async (url) => {
    return { ok: false };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.customerOwners.length, 1);
    assert.equal(mockState.customerOwners[0].id, 'prev');
  } finally {
    delete globalThis.fetch;
  }

  globalThis.fetch = async (url) => {
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: {} };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.customerOwners.length, 1);
    assert.equal(mockState.customerOwners[0].id, 'prev');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('Add Customer and Edit Customer dropdown generation and preservation', () => {
  const openAddBlock = extractFunction('openAddCustomerModal()');
  const openEditBlock = extractFunction('openEditCustomer(id)');

  assert.doesNotMatch(openAddBlock, /state\.users\.filter/);
  assert.doesNotMatch(openEditBlock, /state\.users\.filter/);

  assert.match(openAddBlock, /state\.customerOwners/);

  assert.match(openAddBlock, /-- ไม่ระบุ \/ Unassigned --/);
  
  assert.match(openEditBlock, /Legacy\/Unavailable/);
});

test('saveEditCustomer - mappings, fallbacks, and payload validations', async () => {
  const code = extractFunction('saveEditCustomer(e, id)');
  
  const mockState = {
    customers: [
      { id: 'CUST-1', code: 'C1', name: 'Original Name', source: 'EXTERNAL_SALES', ownerId: 'USR-LEGACY', status: 'ACTIVE_CUSTOMER', contacts: [{ id: 'CONT-1', name: 'Primary contact', isPrimary: true }] }
    ],
    customerOwners: [
      { id: 'USR-1', name: 'Sales Owner 1' }
    ]
  };
  
  let renderViewCalled = false;
  let closeModalCalled = false;
  let saveCustomerToApiPayload = null;
  let saveCustomerToApiMode = null;
  
  globalThis.state = mockState;
  globalThis.getScopedCustomers = () => mockState.customers;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.closeModal = () => { closeModalCalled = true; };
  
  globalThis.saveCustomerToApi = async (payload, mode) => {
    saveCustomerToApiPayload = payload;
    saveCustomerToApiMode = mode;
    return {
      id: payload.id,
      code: payload.code,
      name: payload.name,
      country: payload.country,
      source: payload.source,
      ownerId: payload.ownerId,
      status: payload.status,
      notes: payload.notes,
      contacts: payload.contacts
    };
  };

  const mockElements = {
    editCName: { value: 'New Name' },
    editCCountry: { value: 'Thailand' },
    editCOwner: { value: 'USR-1' },
    editCStatus: { value: 'INACTIVE' },
    editCNotes: { value: 'CRM Notes' }
  };
  
  globalThis.document = {
    getElementById(id) {
      if (mockElements[id]) return mockElements[id];
      return { classList: { add() {}, remove() {} }, textContent: '' };
    }
  };
  
  globalThis.currentEditContacts = [
    { id: 'CONT-1', name: 'Primary contact', isPrimary: true }
  ];

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const e = { preventDefault() {} };
    await fn(e, 'CUST-1');
    
    assert.equal(closeModalCalled, true);
    assert.equal(renderViewCalled, true);
    assert.equal(saveCustomerToApiMode, 'update');
    
    assert.equal(saveCustomerToApiPayload.status, 'INACTIVE_CUSTOMER');
    
    assert.equal(saveCustomerToApiPayload.billingAddress, undefined);
    assert.equal(saveCustomerToApiPayload.defaultPaymentTerm, undefined);
    assert.equal(saveCustomerToApiPayload.creditLimitUsd, undefined);
    assert.equal(saveCustomerToApiPayload.customerTier, undefined);
    assert.equal(saveCustomerToApiPayload.dischargePort, undefined);
    assert.equal(saveCustomerToApiPayload.packagingPreference, undefined);
    
    assert.equal(saveCustomerToApiPayload.source, 'EXTERNAL_SALES');
    assert.equal(saveCustomerToApiPayload.code, 'C1');
    
    assert.equal(saveCustomerToApiPayload.contacts.length, 1);
    assert.equal(saveCustomerToApiPayload.contacts[0].id, 'CONT-1');
    assert.equal(saveCustomerToApiPayload.contacts[0].isPrimary, true);
    
    assert.equal(mockState.customers[0].name, 'New Name');
    assert.equal(mockState.customers[0].status, 'INACTIVE_CUSTOMER');
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.renderView;
    delete globalThis.closeModal;
    delete globalThis.saveCustomerToApi;
    delete globalThis.document;
    delete globalThis.currentEditContacts;
  }
});

test('saveEditCustomer - rejects saving legacy ownerId and displays inline error', async () => {
  const code = extractFunction('saveEditCustomer(e, id)');
  
  const mockState = {
    customers: [
      { id: 'CUST-1', code: 'C1', name: 'Company', source: 'DIRECT', ownerId: 'USR-LEGACY', status: 'ACTIVE_CUSTOMER', contacts: [] }
    ],
    customerOwners: [
      { id: 'USR-VALID', name: 'Valid Owner' }
    ]
  };
  
  let renderViewCalled = false;
  let saveCustomerToApiCalled = false;
  
  globalThis.state = mockState;
  globalThis.getScopedCustomers = () => mockState.customers;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.saveCustomerToApi = async (payload) => {
    saveCustomerToApiCalled = true;
    return { id: payload.id || 'CUST-1' };
  };

  const errDiv = {
    classList: {
      add(cls) {
        if (cls === 'hidden') errDiv.hidden = true;
      },
      remove(cls) {
        if (cls === 'hidden') errDiv.hidden = false;
      }
    },
    hidden: true,
    textContent: ''
  };

  const mockElements = {
    editCName: { value: 'Company' },
    editCCountry: { value: 'Thailand' },
    editCOwner: { value: 'USR-LEGACY' },
    editCOwnershipType: { value: 'ASSIGNED_SALES' },
    editCStatus: { value: 'ACTIVE' },
    editCNotes: { value: '' },
    editCustomerError: errDiv
  };
  
  globalThis.document = {
    getElementById(id) {
      if (mockElements[id]) return mockElements[id];
      return { classList: { add() {}, remove() {} }, textContent: '' };
    }
  };
  
  globalThis.currentEditContacts = [];

  try {
    const fn = new Function(`return (${code.trim()});`)();
    const e = { preventDefault() {} };
    await fn(e, 'CUST-1');
    
    assert.equal(saveCustomerToApiCalled, false, 'Should NOT call API');
    assert.equal(renderViewCalled, false, 'Should NOT render view');
    assert.equal(errDiv.hidden, false, 'Error div should be visible');
    assert.match(errDiv.textContent, /Owner is no longer available/);
    
    mockElements.editCOwner.value = 'USR-VALID';
    await fn(e, 'CUST-1');
    assert.equal(saveCustomerToApiCalled, true, 'Should call API when valid owner is selected');
    
    saveCustomerToApiCalled = false;
    mockElements.editCOwnershipType.value = 'HOUSE_ACCOUNT';
    mockElements.editCOwner.value = '';
    await fn(e, 'CUST-1');
    assert.equal(saveCustomerToApiCalled, true, 'Should call API when unassigned');
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.renderView;
    delete globalThis.saveCustomerToApi;
    delete globalThis.document;
    delete globalThis.currentEditContacts;
  }
});

test('loadExternalSalesFromApi success replaces state.externalSales', async () => {
  const code = extractFunction('loadExternalSalesFromApi()');
  
  const mockState = { externalSales: [] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/external-sales');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            externalSales: [{ id: 'USR-0002', name: 'Sira' }]
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.externalSales.length, 1);
    assert.equal(mockState.externalSales[0].name, 'Sira');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadExternalSalesFromApi failed/malformed response preserves previous state', async () => {
  const code = extractFunction('loadExternalSalesFromApi()');
  
  const mockState = { externalSales: [{ id: 'prev' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    return { ok: false };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.externalSales.length, 1);
    assert.equal(mockState.externalSales[0].id, 'prev');
  } finally {
    delete globalThis.fetch;
  }
});

test('External Sales UI and Save Flow validation checks', () => {
  const getRowsBlock = extractFunction('getExternalSalesManagementRows()');
  const saveProfileBlock = extractFunction('saveExternalSalesProfile(userId)');
  const openModalBlock = extractFunction('openExternalSalesModal(userId)');

  assert.doesNotMatch(getRowsBlock, /state\.users/);
  assert.match(getRowsBlock, /state\.externalSales/);

  assert.match(openModalBlock, /disabled/);
  assert.match(openModalBlock, /Prototype only/);

  assert.doesNotMatch(saveProfileBlock, /google\.script\.run/);
  assert.doesNotMatch(saveProfileBlock, /Save is available only in the deployed/);

  assert.match(saveProfileBlock, /fetch\([`'"]\/api\/external-sales/);
});

test('External Sales Front-end RBAC and Users Fallback check', () => {
  const canViewFn = extractFunction('canViewExternalSalesManagement()');
  const canManageFn = extractFunction('canManageExternalSales()');
  
  // Verify canViewExternalSalesManagement rules
  globalThis.state = { currentUser: { role: 'ADMIN' } };
  const canView = new Function(`return (${canViewFn.trim()});`)();
  assert.equal(canView(), true);
  state.currentUser.role = 'MANAGER';
  assert.equal(canView(), true);
  state.currentUser.role = 'SALES_SUPPORT';
  assert.equal(canView(), true);
  state.currentUser.role = 'EXTERNAL_SALES';
  assert.equal(canView(), false);

  // Verify canManageExternalSales rules
  const canManage = new Function(`return (${canManageFn.trim()});`)();
  state.currentUser.role = 'ADMIN';
  assert.equal(canManage(), true);
  state.currentUser.role = 'MANAGER';
  assert.equal(canManage(), true);
  state.currentUser.role = 'SALES_SUPPORT';
  assert.equal(canManage(), false);
  state.currentUser.role = 'EXTERNAL_SALES';
  assert.equal(canManage(), false);

  delete globalThis.state;

  // Verify no state.users fallback in External Sales UI helpers
  const openModalBlock = extractFunction('openExternalSalesModal(userId)');
  const openAddModalBlock = extractFunction('openAddExternalSalesModal()');
  const saveNewBlock = extractFunction('saveNewExternalSales()');

  // Verify openExternalSalesModal lookup only uses state.externalSales
  assert.doesNotMatch(openModalBlock, /\(state\.users \|\| \[\]\)\.find\(u => u\.id === userId/);

  // Verify saveNewExternalSales contains the reload calls
  assert.match(saveNewBlock, /loadCustomersFromApi/);
  assert.match(saveNewBlock, /loadExternalSalesFromApi/);
  assert.match(saveNewBlock, /loadCustomerOwnersFromApi/);
});

test('loadUsersFromApi success replaces state.adminUsers', async () => {
  const code = extractFunction('loadUsersFromApi()');
  
  const mockState = { adminUsers: [] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    assert.equal(url, '/api/users');
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            users: [{ id: 'api-u1', name: 'API User 1' }]
          }
        };
      }
    };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, true);
    assert.equal(mockState.adminUsers.length, 1);
    assert.equal(mockState.adminUsers[0].id, 'api-u1');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('loadUsersFromApi failure preserves state.adminUsers', async () => {
  const code = extractFunction('loadUsersFromApi()');
  
  const mockState = { adminUsers: [{ id: 'prev' }] };
  let renderViewCalled = false;
  
  globalThis.state = mockState;
  globalThis.renderView = () => { renderViewCalled = true; };
  globalThis.fetch = async (url) => {
    return { ok: false };
  };

  try {
    const fn = new Function(`return (${code.trim()});`)();
    await fn();
    
    assert.equal(renderViewCalled, false);
    assert.equal(mockState.adminUsers.length, 1);
    assert.equal(mockState.adminUsers[0].id, 'prev');
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('Users management UI and action logic uses state.adminUsers and D1 endpoints', () => {
  const renderUsersBlock = extractFunction('renderUsers');
  const openUserModalBlock = extractFunction('openUserModal');
  const saveUserBlock = extractFunction('saveUser');
  const resetUserPasswordBlock = extractFunction('resetUserPasswordFromUI');

  // Verify renderUsers uses state.adminUsers instead of state.users
  assert.doesNotMatch(renderUsersBlock, /state\.users/);
  assert.match(renderUsersBlock, /state\.adminUsers/);

  // Verify openUserModal lookup uses state.adminUsers instead of state.users
  assert.doesNotMatch(openUserModalBlock, /state\.users/);
  assert.match(openUserModalBlock, /state\.adminUsers/);

  // Verify saveUser does not fallback to google.script.run
  assert.doesNotMatch(saveUserBlock, /google\.script\.run/);
  assert.match(saveUserBlock, /fetch\([`'"]\/api\/users/);

  // Verify resetUserPasswordFromUI does not fallback to google.script.run
  assert.doesNotMatch(resetUserPasswordBlock, /google\.script\.run/);
  assert.match(resetUserPasswordBlock, /fetch\([`'"]\/api\/users\/.*?\/reset-password/);
  assert.match(resetUserPasswordBlock, /confirm\(/);
});

test('userScopeForRole maps roles to correct D1 customer scopes', () => {
  const scopeFn = extractFunction('userScopeForRole');
  const fn = new Function(`return (${scopeFn.trim()});`)();
  
  assert.equal(fn('ADMIN'), 'ALL');
  assert.equal(fn('MANAGER'), 'ALL');
  assert.equal(fn('SALES_SUPPORT'), 'ALL');
  assert.equal(fn('EXTERNAL_SALES'), 'OWN_CUSTOMERS');
  assert.equal(fn('EXPORT'), 'NONE');
  assert.equal(fn('PRODUCTION_WAREHOUSE'), 'NONE');
});

test('Product and Spec Master shows parameter maintenance only to ADMIN and MANAGER', () => {
  const renderProducts = new Function(`return (${extractFunction('renderProducts').trim()});`)();
  const renderFor = (role) => {
    globalThis.state = {
      currentUser: { role },
      products: [],
      specParameters: [{ id: 'PAR-001', code: 'STARCH', name: 'Starch', defaultUnit: '%', status: 'ACTIVE' }]
    };
    globalThis.lucide = { createIcons() {} };
    const container = { innerHTML: '' };
    renderProducts(container);
    return container.innerHTML;
  };

  try {
    for (const role of ['ADMIN', 'MANAGER']) {
      const html = renderFor(role);
      assert.match(html, /Spec Parameter Master/);
      assert.match(html, /\+ Add Parameter/);
      assert.match(html, /STARCH/);
      assert.match(html, /Edit Parameter/);
    }
    for (const role of ['SALES_SUPPORT', 'EXTERNAL_SALES', 'EXPORT']) {
      assert.doesNotMatch(renderFor(role), /Spec Parameter Master|\+ Add Parameter|Edit Parameter/);
    }
  } finally {
    delete globalThis.state;
    delete globalThis.lucide;
  }
});

test('saveSpecParameter reuses POST, refreshes parameters, and surfaces duplicate-code errors', async () => {
  const saveSpecParameter = new Function(`return (${extractFunction('saveSpecParameter').trim()});`)();
  const fields = {
    specParameterCode: { value: 'STARCH' },
    specParameterName: { value: 'Starch' },
    specParameterDataType: { value: 'NUMBER' },
    specParameterDefaultUnit: { value: '%' },
    specParameterSortOrder: { value: '1' },
    specParameterStatus: { value: 'ACTIVE' },
    specParameterFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };
  let request;
  let refreshes = 0;
  let closes = 0;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { async json() { return { status: 'SUCCESS', data: { parameter: { id: 'PAR-001' } } }; } };
  };
  globalThis.loadSpecParametersFromApi = async () => { refreshes += 1; };
  globalThis.closeModal = () => { closes += 1; };

  try {
    await saveSpecParameter();
    assert.equal(request.url, '/api/spec-parameters');
    assert.equal(request.options.method, 'POST');
    assert.deepEqual(JSON.parse(request.options.body), {
      code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', sortOrder: 1, status: 'ACTIVE'
    });
    assert.equal(refreshes, 1);
    assert.equal(closes, 1);

    globalThis.fetch = async () => ({ async json() { return { status: 'ERROR', message: 'Parameter code already exists.' }; } });
    await saveSpecParameter();
    assert.match(fields.specParameterFormError.textContent, /Parameter code already exists/);
    assert.equal(refreshes, 1);
  } finally {
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.loadSpecParametersFromApi;
    delete globalThis.closeModal;
  }
});

test('saveSpecParameter uses PUT for immutable-code status edits', async () => {
  const saveSpecParameter = new Function(`return (${extractFunction('saveSpecParameter').trim()});`)();
  const fields = {
    specParameterCode: { value: 'STARCH' },
    specParameterName: { value: 'Starch' },
    specParameterDataType: { value: 'NUMBER' },
    specParameterDefaultUnit: { value: '%' },
    specParameterSortOrder: { value: '2' },
    specParameterStatus: { value: 'INACTIVE' },
    specParameterFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };
  let request;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return { async json() { return { status: 'SUCCESS', data: { parameter: { id: 'PAR-001' } } }; } };
  };
  globalThis.loadSpecParametersFromApi = async () => {};
  globalThis.closeModal = () => {};

  try {
    await saveSpecParameter('PAR-001');
    assert.equal(request.url, '/api/spec-parameters/PAR-001');
    assert.equal(request.options.method, 'PUT');
    assert.deepEqual(JSON.parse(request.options.body), {
      name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', sortOrder: 2, status: 'INACTIVE'
    });
  } finally {
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.loadSpecParametersFromApi;
    delete globalThis.closeModal;
  }
});

test('Product list and detail render nested category and form DTO values', () => {
  const renderProducts = new Function(`return (${extractFunction('renderProducts').trim()});`)();
  const renderProductDashboard = new Function(`return (${extractFunction('renderProductDashboard').trim()});`)();
  const product = {
    id: 'PROD-001', code: 'TAP', name: 'Tapioca', shortName: 'TAP', status: 'ACTIVE', defaultUnit: 'MT',
    category: { id: 'CAT-001', name: 'Starch' }, form: { id: 'FORM-001', name: 'Powder' }, applications: ['FEED_GRADE']
  };
  globalThis.state = {
    currentUser: { role: 'ADMIN' }, products: [product], specParameters: [], selectedProductId: product.id,
    selectedProductApp: 'FEED_GRADE', currentStandardSpecs: [], productCategories: [], productForms: []
  };
  globalThis.lucide = { createIcons() {} };
  globalThis.changeView = () => {};
  try {
    const list = { innerHTML: '' };
    const detail = { innerHTML: '' };
    renderProducts(list);
    renderProductDashboard(detail);
    for (const html of [list.innerHTML, detail.innerHTML]) {
      assert.match(html, /Starch/);
      assert.match(html, /Powder/);
      assert.doesNotMatch(html, /undefined/);
    }
  } finally {
    delete globalThis.state;
    delete globalThis.lucide;
    delete globalThis.changeView;
  }
});

test('Phase 7 Operations Calendar fetches /api/operations-calendar and never reads mock calendar prototype arrays', () => {
  const calendarStart = html.indexOf('// --- CALENDAR ---');
  const calendarEnd = html.indexOf('// --- UTILS & MODAL ---', calendarStart);
  assert.ok(calendarStart >= 0 && calendarEnd > calendarStart, 'calendar section must exist');
  const calendarSection = html.slice(calendarStart, calendarEnd);

  assert.match(calendarSection, /\/api\/operations-calendar/);
  assert.match(calendarSection, /\/api\/shipments-v2\/\$\{encodeURIComponent\(/);
  assert.doesNotMatch(calendarSection, /state\.loadingEvents/);
  assert.doesNotMatch(calendarSection, /state\.diRecords/);
  assert.doesNotMatch(calendarSection, /state\.truckBookings/);
  assert.doesNotMatch(calendarSection, /state\.surveyAssignments/);
  assert.doesNotMatch(calendarSection, /state\.paymentRecords/);
  assert.doesNotMatch(calendarSection, /CALENDAR_DAILY_MAX_CONTAINERS/);
  assert.doesNotMatch(calendarSection, /PO_VALID_UNTIL/);
});

test('loadOperationsCalendarFromApi sends role-safe query params and updates state.operationsCalendar', async () => {
  const loaderCode = extractFunction('loadOperationsCalendarFromApi');
  const rangeCode = extractFunction('calendarVisibleRange');
  const isoCode = extractFunction('calendarIso');
  const capturedUrls = [];

  globalThis.state = {
    currentView: 'calendar',
    currentUser: { id: 'U_WAREHOUSE', role: 'PRODUCTION_WAREHOUSE' },
    calendarYear: 2026,
    calendarMonth: 11,
    calendarView: 'MONTH',
    calendarAnchorDate: '2026-11-19',
    calendarFilters: { customerId: 'C1', salesOwnerId: 'U1', productId: 'P1', eventType: 'LOADING_PLANNED', status: 'BOOKED' },
    operationsCalendar: { range: null, events: [], dailyLoadingSummary: [], loading: false, error: null, lastRequestKey: '' }
  };
  globalThis.calendarIso = new Function(`return (${isoCode.trim()});`)();
  globalThis.calendarVisibleRange = new Function(`return (${rangeCode.trim()});`)();
  globalThis.renderView = () => {};
  globalThis.fetch = async (url) => {
    capturedUrls.push(url);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            range: { from: '2026-11-01', to: '2026-11-30' },
            events: [{ event_id: 'e1', event_type: 'LOADING_PLANNED', event_date: '2026-11-12' }],
            dailyLoadingSummary: [{ date: '2026-11-12', shipment_count: 1, actual_container_count: 0, planned_qty_mt: 20 }]
          }
        };
      }
    };
  };

  try {
    const load = new Function(`return (${loaderCode.trim()});`)();
    await load({ force: true });
    assert.equal(capturedUrls.length, 1);
    assert.match(capturedUrls[0], /^\/api\/operations-calendar\?/);
    assert.match(capturedUrls[0], /from=2026-11-01/);
    assert.match(capturedUrls[0], /to=2026-11-30/);
    assert.match(capturedUrls[0], /productId=P1/);
    assert.match(capturedUrls[0], /eventType=LOADING_PLANNED/);
    // Warehouse must NOT send hidden filter params
    assert.doesNotMatch(capturedUrls[0], /customerId=/);
    assert.doesNotMatch(capturedUrls[0], /salesOwnerId=/);
    assert.doesNotMatch(capturedUrls[0], /status=/);
    assert.equal(globalThis.state.operationsCalendar.events.length, 1);
    assert.equal(globalThis.state.operationsCalendar.dailyLoadingSummary.length, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.calendarIso;
    delete globalThis.calendarVisibleRange;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('Phase 7 renderCalendarFilters mirrors server RBAC for PRODUCTION_WAREHOUSE and EXTERNAL_SALES', () => {
  const renderFilters = new Function(
    'CALENDAR_EVENT_TYPES',
    'CALENDAR_WAREHOUSE_TYPES',
    'calendarEventAllowedForRole',
    'escapeCalendarHtml',
    `return (${extractFunction('renderCalendarFilters').trim()});`
  )(
    {
      LOADING_PLANNED: { label: 'Planned Loading' },
      LOADING_ACTUAL: { label: 'Actual Loading' },
      ETD: { label: 'ETD (Vessel)' },
      ETA: { label: 'ETA (Arrival)' },
      PO_DELIVERY_START: { label: 'PO Delivery Start' },
      PO_DELIVERY_END: { label: 'PO Delivery End' }
    },
    ['LOADING_PLANNED', 'LOADING_ACTUAL'],
    (type, role = globalThis.state.currentUser.role) => (role === 'PRODUCTION_WAREHOUSE' ? ['LOADING_PLANNED', 'LOADING_ACTUAL'].includes(type) : true),
    (v) => String(v ?? '')
  );

  globalThis.getScopedCustomers = () => [{ id: 'C1', name: 'Cust 1' }];
  try {
    globalThis.state = {
      currentUser: { role: 'PRODUCTION_WAREHOUSE' },
      calendarFilters: { customerId: 'ALL', salesOwnerId: 'ALL', productId: 'ALL', eventType: 'ALL', status: 'ALL' },
      customerOwners: [{ user_id: 'U1', full_name: 'Owner 1', status: 'ACTIVE' }],
      products: [{ id: 'P1', shortName: 'THP65' }]
    };
    const whHtml = renderFilters();
    assert.doesNotMatch(whHtml, />Customer</);
    assert.doesNotMatch(whHtml, />Sales Owner</);
    assert.doesNotMatch(whHtml, />Status</);
    assert.match(whHtml, /Planned Loading/);
    assert.doesNotMatch(whHtml, /ETD \(Vessel\)/);

    globalThis.state.currentUser = { role: 'EXTERNAL_SALES' };
    const salesHtml = renderFilters();
    assert.doesNotMatch(salesHtml, />Customer</);
    assert.doesNotMatch(salesHtml, />Sales Owner</);
    assert.doesNotMatch(salesHtml, />Product</);
    assert.match(salesHtml, />Status</);
    assert.match(salesHtml, /ETD \(Vessel\)/);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
  }
});

test('saveCalendarPlannedLoadingDate submits to Phase 6 PUT /api/shipments-v2/:id/schedule and reloads calendar', async () => {
  const saveFn = new Function(`return (${extractFunction('saveCalendarPlannedLoadingDate').trim()});`)();
  const calls = [];
  let reloaded = false;
  let closed = false;
  globalThis.state = { calendarYear: 2026, calendarMonth: 11, calendarAnchorDate: '2026-11-12' };
  globalThis.document = {
    getElementById(id) {
      if (id === 'calendarRescheduleDate') return { value: '2026-11-19' };
      if (id === 'calendarRescheduleError') return { textContent: '', classList: { remove() {} } };
      return null;
    }
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { status: 'SUCCESS', data: { shipment: { shipment_id: 'S1' } } }; } };
  };
  globalThis.closeModal = () => { closed = true; };
  globalThis.loadOperationsCalendarFromApi = async (opts) => { reloaded = !!opts?.force; };

  try {
    await saveFn('S1');
    assert.deepEqual(calls, [{
      url: '/api/shipments-v2/S1/schedule',
      method: 'PUT',
      body: { plannedLoadingDate: '2026-11-19' }
    }]);
    assert.equal(closed, true);
    assert.equal(reloaded, true);
    assert.equal(globalThis.state.calendarAnchorDate, '2026-11-19');
  } finally {
    delete globalThis.state;
    delete globalThis.document;
    delete globalThis.fetch;
    delete globalThis.closeModal;
    delete globalThis.loadOperationsCalendarFromApi;
  }
});



test('Phase 8 Logistics Partners renderers use D1 state and never read mock logisticsProviders arrays', () => {
  const listCode = extractFunction('renderLogisticsPartners');
  const detailCode = extractFunction('renderLogisticsPartnerDetail');
  const editorCode = extractFunction('openProviderEditor');
  const rateEditorCode = extractFunction('openProviderPriceEditor');
  const combined = [listCode, detailCode, editorCode, rateEditorCode].join('\n');

  assert.doesNotMatch(combined, /state\.logisticsProviders/);
  assert.doesNotMatch(combined, /state\.providerPrices/);
  assert.doesNotMatch(combined, /state\.providerUsageRecords/);
  assert.doesNotMatch(combined, /FREIGHT_FORWARDER/);
  assert.match(listCode, /state\.logisticsPartners/);
  assert.match(listCode, /FORWARDER/);
  assert.match(listCode, /SHIPPING_LINE/);
  assert.match(listCode, /TRUCKING/);
  assert.match(listCode, /SURVEYOR/);
  assert.match(detailCode, /openPhase6ShipmentFromCalendar/);
});

test('canManageLogisticsPartners allows ADMIN, MANAGER, EXPORT and denies SALES_SUPPORT', () => {
  const fn = new Function(`return (${extractFunction('canManageLogisticsPartners').trim()});`)();
  try {
    for (const role of ['ADMIN', 'MANAGER', 'EXPORT']) {
      globalThis.state = { currentUser: { role } };
      assert.equal(fn(), true, `${role} should be allowed to manage logistics partners`);
    }
    for (const role of ['SALES_SUPPORT', 'EXTERNAL_SALES', 'PRODUCTION_WAREHOUSE']) {
      globalThis.state = { currentUser: { role } };
      assert.equal(fn(), false, `${role} should not be allowed to manage logistics partners`);
    }
  } finally {
    delete globalThis.state;
  }
});

test('loadLogisticsPartnersFromApi fetches /api/logistics-partners and populates state.logisticsPartners', async () => {
  const code = extractFunction('loadLogisticsPartnersFromApi');
  const capturedUrls = [];
  let rendered = 0;

  globalThis.state = {
    providerTypeFilter: 'ALL',
    logisticsPartners: { items: [], detail: null, loading: false, detailLoading: false, error: null, loaded: false, statusFilter: 'ALL', search: '' }
  };
  globalThis.renderView = () => { rendered++; };
  globalThis.fetch = async (url) => {
    capturedUrls.push(url);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            partners: [
              { partner_id: 'SP-001', partner_type: 'TRUCKING', partner_name: 'Siam Truck', status: 'ACTIVE', active_rate_count: 2, usage_count: 3 }
            ]
          }
        };
      }
    };
  };

  try {
    const load = new Function(`return (${code.trim()});`)();
    await load();
    assert.deepEqual(capturedUrls, ['/api/logistics-partners']);
    assert.equal(globalThis.state.logisticsPartners.loaded, true);
    assert.equal(globalThis.state.logisticsPartners.items.length, 1);
    assert.equal(globalThis.state.logisticsPartners.items[0].partner_id, 'SP-001');
    assert.ok(rendered >= 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('saveLogisticsPartnerToApi submits POST for create and PUT for edit and syncs Phase 6 partners', async () => {
  const code = extractFunction('saveLogisticsPartnerToApi');
  const calls = [];
  let phase6Synced = 0;
  let closed = 0;
  let listReloaded = 0;
  let detailReloaded = 0;

  const fields = {
    lgpName: { value: 'Kerry Ocean' },
    lgpType: { value: 'FORWARDER' },
    lgpStatus: { value: 'ACTIVE' },
    lgpContact: { value: 'Malee' },
    lgpPhone: { value: '081-000-0001' },
    lgpEmail: { value: 'malee@kerry.co.th' },
    lgpTax: { value: '0105551111111' },
    lgpAddress: { value: 'Bangkok' },
    lgpNote: { value: 'Preferred' },
    lgpFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'MANAGER' }, selectedLogisticsProviderId: null };
  globalThis.canManageLogisticsPartners = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadLogisticsPartnersFromApi = async () => { listReloaded++; };
  globalThis.loadLogisticsPartnerDetailFromApi = async () => { detailReloaded++; };
  globalThis.loadPhase6ServicePartnersFromApi = async () => { phase6Synced++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { partner: { partner_id: 'SP-001' } } };
      }
    };
  };

  try {
    const save = new Function(`return (${code.trim()});`)();
    await save('');
    assert.equal(calls[0].url, '/api/logistics-partners');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.partnerType, 'FORWARDER');
    assert.equal(calls[0].body.partnerName, 'Kerry Ocean');

    await save('SP-001');
    assert.equal(calls[1].url, '/api/logistics-partners/SP-001');
    assert.equal(calls[1].method, 'PUT');
    assert.equal('partnerType' in calls[1].body, false, 'PUT edit payload should omit immutable partnerType');
    assert.equal(phase6Synced, 2);
    assert.equal(closed, 2);
    assert.equal(listReloaded, 2);
    assert.equal(detailReloaded, 2);
  } finally {
    delete globalThis.state;
    delete globalThis.canManageLogisticsPartners;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadLogisticsPartnersFromApi;
    delete globalThis.loadLogisticsPartnerDetailFromApi;
    delete globalThis.loadPhase6ServicePartnersFromApi;
    delete globalThis.fetch;
  }
});

test('saveLogisticsPartnerRateToApi submits POST for create and PATCH for edit', async () => {
  const code = extractFunction('saveLogisticsPartnerRateToApi');
  const calls = [];
  let closed = 0;
  let listReloaded = 0;
  let detailReloaded = 0;

  const fields = {
    lgpRateService: { value: 'Trucking' },
    lgpRateRoute: { value: 'Factory -> LCB' },
    lgpRateContainer: { value: '40HC' },
    lgpRateUnit: { value: 'THB / Container' },
    lgpRatePrice: { value: '8500' },
    lgpRateCurrency: { value: 'THB' },
    lgpRateEffective: { value: '2026-11-01' },
    lgpRateValidUntil: { value: '2026-12-31' },
    lgpRateStatus: { value: 'ACTIVE' },
    lgpRateNote: { value: 'Standard' },
    lgpRateFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'EXPORT' }, providerDetailTab: 'PROFILE' };
  globalThis.canManageLogisticsPartners = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadLogisticsPartnersFromApi = async () => { listReloaded++; };
  globalThis.loadLogisticsPartnerDetailFromApi = async () => { detailReloaded++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return {
      ok: true,
      async json() {
        return { status: 'SUCCESS', data: { rate: { rate_id: 'SPR-0001' } } };
      }
    };
  };

  try {
    const saveRate = new Function(`return (${code.trim()});`)();
    await saveRate('SP-001', '');
    assert.equal(calls[0].url, '/api/logistics-partners/SP-001/rates');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.price, 8500);
    assert.equal(calls[0].body.currency, 'THB');
    assert.equal(calls[0].body.containerSize, '40HC');

    await saveRate('SP-001', 'SPR-0001');
    assert.equal(calls[1].url, '/api/logistics-partners/SP-001/rates/SPR-0001');
    assert.equal(calls[1].method, 'PATCH');
    assert.equal(closed, 2);
    assert.equal(listReloaded, 2);
    assert.equal(detailReloaded, 2);
  } finally {
    delete globalThis.state;
    delete globalThis.canManageLogisticsPartners;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadLogisticsPartnersFromApi;
    delete globalThis.loadLogisticsPartnerDetailFromApi;
    delete globalThis.fetch;
  }
});

test('Logistics Partners directory and detail hide write controls for SALES_SUPPORT and show them for ADMIN/MANAGER/EXPORT', () => {
  const escapeFn = new Function(`return (${extractFunction('escapeLogisticsPartnerHtml').trim()});`)();
  const canManageFn = new Function(`return (${extractFunction('canManageLogisticsPartners').trim()});`)();
  const renderList = new Function(`return (${extractFunction('renderLogisticsPartners').trim()});`)();
  const renderDetail = new Function(`return (${extractFunction('renderLogisticsPartnerDetail').trim()});`)();

  globalThis.escapeLogisticsPartnerHtml = escapeFn;
  globalThis.canManageLogisticsPartners = canManageFn;
  globalThis.getTodayIso = () => '2026-11-19';
  globalThis.loadLogisticsPartnersFromApi = async () => {};
  globalThis.loadLogisticsPartnerDetailFromApi = async () => {};

  const samplePartner = {
    partner_id: 'SP-001',
    partner_type: 'FORWARDER',
    partner_name: 'Kerry Ocean',
    contact_name: 'Malee',
    contact_phone: '081-000-0001',
    contact_email: 'malee@kerry.co.th',
    tax_id: '010555',
    address: 'Bangkok',
    status: 'ACTIVE',
    note: 'Preferred',
    active_rate_count: 1,
    usage_count: 1
  };
  const sampleDetail = {
    partner: samplePartner,
    rates: [{
      rate_id: 'SPR-0001',
      partner_id: 'SP-001',
      service_type: 'Export Clearance',
      route_scope: 'LCB -> Hamburg',
      container_size: '40HC',
      unit: 'USD / Container',
      price: 1850,
      currency: 'USD',
      effective_date: '2026-10-01',
      valid_until: '2026-11-01',
      status: 'ACTIVE',
      note: 'Expired test'
    }],
    usage: [{
      di_id: 'DI-1',
      shipment_id: 'SHP-1',
      di_no: 'DI-2026-001',
      customer_name: 'Acme',
      booking_no: 'BK-001',
      vessel: 'EVER GIVEN',
      container_plan: '2 x 40HC',
      usage_date: '2026-11-12',
      partner_role: 'FORWARDER',
      di_status: 'IN_PROGRESS',
      shipment_status: 'LOADED',
      actual_container_count: 2
    }]
  };

  try {
    // Directory: SALES_SUPPORT cannot see + Add Partner; MANAGER/ADMIN/EXPORT can
    for (const [role, expectWrite] of [['SALES_SUPPORT', false], ['ADMIN', true], ['MANAGER', true], ['EXPORT', true]]) {
      globalThis.state = {
        currentUser: { role },
        selectedLogisticsProviderId: null,
        providerTypeFilter: 'ALL',
        providerDetailTab: 'PRICE',
        logisticsPartners: {
          items: [samplePartner],
          detail: sampleDetail,
          loading: false,
          detailLoading: false,
          error: null,
          loaded: true,
          statusFilter: 'ALL',
          search: ''
        }
      };

      const listContainer = { innerHTML: '' };
      renderList(listContainer);
      assert.equal(listContainer.innerHTML.includes('+ Add Partner'), expectWrite, `${role} directory + Add Partner visibility`);

      const detailContainer = { innerHTML: '' };
      renderDetail(detailContainer);
      assert.equal(detailContainer.innerHTML.includes('Edit Profile'), expectWrite, `${role} detail Edit Profile visibility`);
      assert.equal(detailContainer.innerHTML.includes('+ Add Rate'), expectWrite, `${role} detail + Add Rate visibility`);
      assert.equal(detailContainer.innerHTML.includes('Deactivate'), expectWrite, `${role} detail Deactivate visibility`);
      assert.match(detailContainer.innerHTML, /Expired/, 'expired rate badge should render when valid_until < today');
    }
  } finally {
    delete globalThis.state;
    delete globalThis.escapeLogisticsPartnerHtml;
    delete globalThis.canManageLogisticsPartners;
    delete globalThis.getTodayIso;
    delete globalThis.loadLogisticsPartnersFromApi;
    delete globalThis.loadLogisticsPartnerDetailFromApi;
  }
});

test('Phase 9 Payment Status renderers use D1 state and never read mock paymentRecords or expose hard delete', () => {
  const renderCode = extractFunction('renderPayments');
  const detailCode = extractFunction('openPaymentDetailModal');
  const cashCode = extractFunction('openRecordPaymentModal');
  const creditCode = extractFunction('openCreateCustomerCreditModal');
  const applyCode = extractFunction('openApplyCreditModal');
  const combined = [renderCode, detailCode, cashCode, creditCode, applyCode].join('\n');

  assert.doesNotMatch(combined, /state\.paymentRecords/);
  assert.doesNotMatch(combined, /deletePaymentRecord/);
  assert.doesNotMatch(combined, /savePaymentRecord/);
  assert.match(renderCode, /state\.paymentsDashboard/);
  assert.match(renderCode, /totals_by_currency/);
  assert.match(renderCode, /openPhase6ShipmentFromCalendar/);
});

test('loadPaymentsDashboardFromApi fetches /api/payments, omits customerId for EXTERNAL_SALES, and updates state', async () => {
  const code = extractFunction('loadPaymentsDashboardFromApi');
  const capturedUrls = [];
  let rendered = 0;

  globalThis.state = {
    currentUser: { id: 'U_SALES1', role: 'EXTERNAL_SALES' },
    paymentsDashboard: {
      summary: null,
      items: [],
      customerCredits: [],
      detail: null,
      loading: false,
      detailLoading: false,
      error: null,
      loaded: false,
      activeTab: 'SHIPMENTS',
      filters: { paymentStatus: 'PARTIAL', invoiceReadiness: 'ALL', shipmentStatus: 'ALL', currency: 'USD', customerId: 'C2', search: '' }
    }
  };
  globalThis.renderView = () => { rendered++; };
  globalThis.fetch = async (url) => {
    capturedUrls.push(url);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            summary: { total_shipments: 1, paid_count: 0, partial_count: 1, unpaid_count: 0, final_invoiced_count: 1, awaiting_final_invoice_count: 0, totals_by_currency: [] },
            items: [{ di_no: 'DI-001', payment_status: 'PARTIAL', final_invoice_total: 10000, payment_total: 4000, outstanding_balance: 6000 }],
            customerCredits: []
          }
        };
      }
    };
  };

  try {
    const load = new Function(`return (${code.trim()});`)();
    await load();
    assert.equal(capturedUrls.length, 1);
    assert.match(capturedUrls[0], /^\/api\/payments\?/);
    assert.match(capturedUrls[0], /paymentStatus=PARTIAL/);
    assert.match(capturedUrls[0], /currency=USD/);
    assert.doesNotMatch(capturedUrls[0], /customerId=/, 'EXTERNAL_SALES must not send customerId query param');
    assert.equal(globalThis.state.paymentsDashboard.loaded, true);
    assert.equal(globalThis.state.paymentsDashboard.items.length, 1);
    assert.ok(rendered >= 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('submitShipmentCashPaymentToApi calls Phase 6 PUT /api/shipments-v2/:id/payment and reloads dashboard', async () => {
  const code = extractFunction('submitShipmentCashPaymentToApi');
  const calls = [];
  let closed = 0;
  let reloaded = 0;

  const fields = {
    payCashAmount: { value: '6500.5' },
    payCashNote: { value: 'TT Ref 2026-11' },
    payCashFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'EXPORT' } };
  globalThis.canEditPayment = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadPaymentsDashboardFromApi = async () => { reloaded++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { status: 'SUCCESS', data: { shipment: { shipment_id: 'SHP-1' } } }; } };
  };

  try {
    const submit = new Function(`return (${code.trim()});`)();
    await submit('SHP-1');
    assert.deepEqual(calls, [{
      url: '/api/shipments-v2/SHP-1/payment',
      method: 'PUT',
      body: { cashReceivedAmount: 6500.5, paymentNote: 'TT Ref 2026-11' }
    }]);
    assert.equal(closed, 1);
    assert.equal(reloaded, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.canEditPayment;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadPaymentsDashboardFromApi;
    delete globalThis.fetch;
  }
});

test('submitCustomerCreditToApi and submitApplyCustomerCreditToApi call Phase 6 endpoints with requestKey', async () => {
  const createCode = extractFunction('submitCustomerCreditToApi');
  const applyCode = extractFunction('submitApplyCustomerCreditToApi');
  const calls = [];
  let closed = 0;
  let reloaded = 0;

  const fields = {
    creditCustomerId: { value: 'C1' },
    creditAmount: { value: '1200' },
    creditReason: { value: 'Overpayment balance' },
    creditFormError: { textContent: '', classList: { add() {}, remove() {} } },
    applyCreditId: { value: 'CR-1' },
    applyCreditAmount: { value: '500' },
    applyCreditInvoiceId: { value: 'INV-1' },
    applyCreditFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'MANAGER' } };
  globalThis.canEditPayment = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadPaymentsDashboardFromApi = async () => { reloaded++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { status: 'SUCCESS', data: {} }; } };
  };

  try {
    const createCredit = new Function(`return (${createCode.trim()});`)();
    const applyCredit = new Function(`return (${applyCode.trim()});`)();

    await createCredit();
    assert.equal(calls[0].url, '/api/customer-credits');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.customerId, 'C1');
    assert.equal(calls[0].body.amount, 1200);
    assert.equal(calls[0].body.reason, 'Overpayment balance');
    assert.ok(typeof calls[0].body.requestKey === 'string' && calls[0].body.requestKey.length > 0);

    await applyCredit('SHP-1');
    assert.equal(calls[1].url, '/api/shipments-v2/SHP-1/credit-usage');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].body.creditId, 'CR-1');
    assert.equal(calls[1].body.amount, 500);
    assert.equal(calls[1].body.invoiceId, 'INV-1');
    assert.ok(typeof calls[1].body.requestKey === 'string' && calls[1].body.requestKey.length > 0);

    assert.equal(closed, 2);
    assert.equal(reloaded, 2);
  } finally {
    delete globalThis.state;
    delete globalThis.canEditPayment;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadPaymentsDashboardFromApi;
    delete globalThis.fetch;
  }
});

test('renderPayments enforces role-aware UI for EXTERNAL_SALES, SALES_SUPPORT, and ADMIN/MANAGER/EXPORT', () => {
  const escapeFn = new Function(`return (${extractFunction('escapePaymentHtml').trim()});`)();
  const canEditFn = new Function(`return (${extractFunction('canEditPayment').trim()});`)();
  const badgeFn = new Function(`return (${extractFunction('paymentStatusBadge').trim()});`)();
  const formatFn = new Function(`return (${extractFunction('formatMoney').trim()});`)();
  const renderFn = new Function(`return (${extractFunction('renderPayments').trim()});`)();

  globalThis.escapePaymentHtml = escapeFn;
  globalThis.canEditPayment = canEditFn;
  globalThis.paymentStatusBadge = badgeFn;
  globalThis.formatMoney = formatFn;
  globalThis.loadPaymentsDashboardFromApi = async () => {};
  globalThis.lucide = { createIcons() {} };

  const baseDashboard = {
    summary: {
      total_shipments: 1,
      paid_count: 0,
      partial_count: 1,
      unpaid_count: 0,
      final_invoiced_count: 1,
      awaiting_final_invoice_count: 0,
      totals_by_currency: [{ currency: 'USD', shipment_count: 1, final_invoice_total: 10000, cash_received_total: 4000, allocated_credit_total: 1000, payment_total: 5000, outstanding_total: 5000 }],
      customer_credits_summary: { total_credits: 1, active_credits_count: 1, total_remaining_amount: 500 }
    },
    items: [{
      shipment_id: 'SHP-1',
      di_id: 'DI-1',
      di_no: 'DI-001',
      customer_po_no: 'CPO-1',
      customer_name: 'Meelunie',
      currency: 'USD',
      shipment_status: 'DOCS_SENT',
      invoice_readiness: 'FINALIZED',
      final_invoice_nos: 'WCAT-001',
      final_invoice_total: 10000,
      cash_received_amount: 4000,
      allocated_credit_amount: 1000,
      payment_total: 5000,
      outstanding_balance: 5000,
      payment_status: 'PARTIAL',
      commission_ready: false
    }],
    customerCredits: [{ credit_id: 'CR-1', customer_name: 'Meelunie', amount: 1500, used_amount: 1000, remaining_amount: 500, usage_count: 1, reason: 'Overpayment', created_at: '2026-11-01' }],
    detail: null,
    loading: false,
    detailLoading: false,
    error: null,
    loaded: true,
    activeTab: 'SHIPMENTS',
    filters: { paymentStatus: 'ALL', invoiceReadiness: 'ALL', shipmentStatus: 'ALL', currency: 'ALL', customerId: 'ALL', search: '' }
  };

  try {
    for (const [role, expectWrite, expectCreditsTab] of [
      ['EXTERNAL_SALES', false, false],
      ['SALES_SUPPORT', false, true],
      ['ADMIN', true, true],
      ['MANAGER', true, true],
      ['EXPORT', true, true]
    ]) {
      globalThis.state = {
        currentUser: { role },
        customers: [{ id: 'C1', name: 'Meelunie' }],
        paymentsDashboard: structuredClone(baseDashboard)
      };
      const container = { innerHTML: '' };
      renderFn(container);
      assert.equal(container.innerHTML.includes('+ Add Customer Credit'), expectWrite, `${role} + Add Customer Credit visibility`);
      assert.equal(container.innerHTML.includes('Record Payment'), expectWrite, `${role} Record Payment visibility`);
      assert.equal(container.innerHTML.includes('Customer Credits'), expectCreditsTab, `${role} Customer Credits tab visibility`);
      assert.equal(container.innerHTML.includes('Delete'), false, `${role} must never see Delete Payment button`);
    }
  } finally {
    delete globalThis.state;
    delete globalThis.escapePaymentHtml;
    delete globalThis.canEditPayment;
    delete globalThis.paymentStatusBadge;
    delete globalThis.formatMoney;
    delete globalThis.loadPaymentsDashboardFromApi;
    delete globalThis.lucide;
  }
});

test('Phase 10 Commission Settlement renderers use D1 state and never read mock commissionPaidSnapshots or commissionRateChangeRequests', () => {
  const renderCode = extractFunction('renderCommissions');
  const settleModalCode = extractFunction('openSettleCommissionModal');
  const detailModalCode = extractFunction('openCommissionDetailModal');
  const combined = [renderCode, settleModalCode, detailModalCode].join('\n');

  assert.doesNotMatch(combined, /state\.commissionPaidSnapshots/);
  assert.doesNotMatch(combined, /state\.commissionRateChangeRequests/);
  assert.doesNotMatch(combined, /reviewCommissionRateChange/);
  assert.doesNotMatch(combined, /prompt\(/);
  assert.match(renderCode, /state\.commissionsDashboard/);
  assert.match(renderCode, /openSettleCommissionModal/);
  assert.match(renderCode, /openCommissionDetailModal/);
});

test('loadCommissionsDashboardFromApi fetches /api/commissions, omits hidden params for EXTERNAL_SALES, and updates state', async () => {
  const code = extractFunction('loadCommissionsDashboardFromApi');
  const capturedUrls = [];
  let rendered = 0;

  globalThis.state = {
    currentUser: { id: 'U_SALES1', role: 'EXTERNAL_SALES' },
    commissionsDashboard: {
      summary: null,
      items: [],
      recipients: [],
      detail: null,
      loading: false,
      error: null,
      loaded: false,
      filters: { status: 'PAYABLE', recipientUserId: 'U_SALES2', customerId: 'C2', paidDateFrom: '', paidDateTo: '', search: 'DI-001' }
    }
  };
  globalThis.renderView = () => { rendered++; };
  globalThis.fetch = async (url) => {
    capturedUrls.push(url);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            summary: { total_count: 1, pending_count: 0, payable_count: 1, paid_count: 0, pending_usd: 0, payable_usd: 200, paid_usd: 0, total_usd: 200 },
            items: [{ di_no: 'DI-001', status: 'PAYABLE', commission_amount_usd: 200 }],
            recipients: []
          }
        };
      }
    };
  };

  try {
    const load = new Function(`return (${code.trim()});`)();
    await load();
    assert.equal(capturedUrls.length, 1);
    assert.match(capturedUrls[0], /^\/api\/commissions\?/);
    assert.match(capturedUrls[0], /status=PAYABLE/);
    assert.match(capturedUrls[0], /search=DI-001/);
    assert.doesNotMatch(capturedUrls[0], /recipientUserId=/, 'EXTERNAL_SALES must not send recipientUserId');
    assert.doesNotMatch(capturedUrls[0], /customerId=/, 'EXTERNAL_SALES must not send customerId');
    assert.equal(globalThis.state.commissionsDashboard.loaded, true);
    assert.equal(globalThis.state.commissionsDashboard.items.length, 1);
    assert.ok(rendered >= 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('submitCommissionSettlementToApi posts to /api/commissions/settle with requestKey and reloads dashboard', async () => {
  const code = extractFunction('submitCommissionSettlementToApi');
  const calls = [];
  let closed = 0;
  let reloaded = 0;

  const fields = {
    commSettlePaidDate: { value: '2026-11-19' },
    commSettleRef: { value: 'WIRE-2026-1119' },
    commSettleNote: { value: 'Settled November payout' },
    commSettleFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'MANAGER' } };
  globalThis.canSettleCommission = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadCommissionsDashboardFromApi = async () => { reloaded++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { status: 'SUCCESS', data: { settlement: { settlement_id: 'CS-0001' } } }; } };
  };

  try {
    const submit = new Function(`return (${code.trim()});`)();
    await submit('SHP-1', 'U_SALES1');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/commissions/settle');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.shipmentId, 'SHP-1');
    assert.equal(calls[0].body.recipientUserId, 'U_SALES1');
    assert.equal(calls[0].body.paidDate, '2026-11-19');
    assert.equal(calls[0].body.paymentReference, 'WIRE-2026-1119');
    assert.equal(calls[0].body.note, 'Settled November payout');
    assert.ok(typeof calls[0].body.requestKey === 'string' && calls[0].body.requestKey.length > 0);
    assert.equal(closed, 1);
    assert.equal(reloaded, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.canSettleCommission;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadCommissionsDashboardFromApi;
    delete globalThis.fetch;
  }
});

test('updateCommissionNoteToApi patches /api/commissions/:settlementId and reloads dashboard', async () => {
  const code = extractFunction('updateCommissionNoteToApi');
  const calls = [];
  let closed = 0;
  let reloaded = 0;

  const fields = {
    commDetailRef: { value: 'WIRE-REV-2' },
    commDetailNote: { value: 'Verified receipt' },
    commDetailFormError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  globalThis.state = { currentUser: { role: 'ADMIN' } };
  globalThis.canSettleCommission = () => true;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.closeModal = () => { closed++; };
  globalThis.loadCommissionsDashboardFromApi = async () => { reloaded++; };
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return { ok: true, async json() { return { status: 'SUCCESS', data: { settlement: { settlement_id: 'CS-0001' } } }; } };
  };

  try {
    const update = new Function(`return (${code.trim()});`)();
    await update('CS-0001');
    assert.deepEqual(calls, [{
      url: '/api/commissions/CS-0001',
      method: 'PATCH',
      body: { paymentReference: 'WIRE-REV-2', note: 'Verified receipt' }
    }]);
    assert.equal(closed, 1);
    assert.equal(reloaded, 1);
  } finally {
    delete globalThis.state;
    delete globalThis.canSettleCommission;
    delete globalThis.document;
    delete globalThis.closeModal;
    delete globalThis.loadCommissionsDashboardFromApi;
    delete globalThis.fetch;
  }
});

test('renderCommissions hides settle controls and recipient strip for EXTERNAL_SALES and shows them for ADMIN/MANAGER', () => {
  const escapeFn = new Function(`return (${extractFunction('escapeCommissionHtml').trim()});`)();
  const canSettleFn = new Function(`return (${extractFunction('canSettleCommission').trim()});`)();
  const statusBadgeFn = new Function(`return (${extractFunction('commissionStatusBadge').trim()});`)();
  const payBadgeFn = new Function(`return (${extractFunction('paymentStatusBadge').trim()});`)();
  const formatFn = new Function(`return (${extractFunction('formatMoney').trim()});`)();
  const renderFn = new Function(`return (${extractFunction('renderCommissions').trim()});`)();

  globalThis.escapeCommissionHtml = escapeFn;
  globalThis.canSettleCommission = canSettleFn;
  globalThis.commissionStatusBadge = statusBadgeFn;
  globalThis.paymentStatusBadge = payBadgeFn;
  globalThis.formatMoney = formatFn;
  globalThis.loadCommissionsDashboardFromApi = async () => {};
  globalThis.lucide = { createIcons() {} };

  const sampleDashboard = {
    summary: { total_count: 2, pending_count: 0, payable_count: 1, paid_count: 1, pending_usd: 0, payable_usd: 200, paid_usd: 150, total_usd: 350 },
    items: [
      {
        settlement_id: null,
        shipment_id: 'SHP-1',
        di_id: 'DI-1',
        di_no: 'DI-001',
        customer_po_no: 'CPO-1',
        customer_name: 'Meelunie',
        recipient_user_id: 'U_SALES1',
        recipient_name: 'Sira TTPagro',
        final_invoice_nos: 'WCAT-001',
        actual_shipped_mt: 20,
        planned_qty_mt: 20,
        rate_usd_mt: 10,
        commission_amount_usd: 200,
        currency: 'USD',
        payment_status: 'PAID',
        shipment_status: 'COMPLETED',
        status: 'PAYABLE',
        can_settle: true
      },
      {
        settlement_id: 'CS-0001',
        shipment_id: 'SHP-2',
        di_id: 'DI-2',
        di_no: 'DI-002',
        customer_po_no: 'CPO-2',
        customer_name: 'Meelunie',
        recipient_user_id: 'U_SALES1',
        recipient_name: 'Sira TTPagro',
        final_invoice_nos: 'WCAT-002',
        actual_shipped_mt: 15,
        planned_qty_mt: 15,
        rate_usd_mt: 10,
        commission_amount_usd: 150,
        currency: 'USD',
        payment_status: 'PAID',
        shipment_status: 'COMPLETED',
        status: 'PAID',
        paid_date: '2026-11-19',
        payment_reference: 'WIRE-001',
        can_settle: false
      }
    ],
    recipients: [{ user_id: 'U_SALES1', full_name: 'Sira TTPagro', pending_usd: 0, payable_usd: 200, paid_usd: 150, payable_count: 1, total_count: 2 }],
    detail: null,
    loading: false,
    error: null,
    loaded: true,
    filters: { status: 'ALL', recipientUserId: 'ALL', customerId: 'ALL', paidDateFrom: '', paidDateTo: '', search: '' }
  };

  try {
    for (const [role, expectSettle, expectRecipientStrip] of [
      ['EXTERNAL_SALES', false, false],
      ['MANAGER', true, true],
      ['ADMIN', true, true]
    ]) {
      globalThis.state = {
        currentUser: { role },
        commissionsDashboard: structuredClone(sampleDashboard)
      };
      const container = { innerHTML: '' };
      renderFn(container);
      assert.equal(container.innerHTML.includes('Settle / Pay'), expectSettle, `${role} Settle / Pay visibility`);
      assert.equal(container.innerHTML.includes('All Salespeople'), expectRecipientStrip, `${role} recipient filter visibility`);
      assert.match(container.innerHTML, /Receipt/, `${role} should see Receipt action on PAID row`);
    }
  } finally {
    delete globalThis.state;
    delete globalThis.escapeCommissionHtml;
    delete globalThis.canSettleCommission;
    delete globalThis.commissionStatusBadge;
    delete globalThis.paymentStatusBadge;
    delete globalThis.formatMoney;
    delete globalThis.loadCommissionsDashboardFromApi;
    delete globalThis.lucide;
  }
});

test('loadDashboardSummaryFromApi fetches /api/dashboard and updates state.dashboardSummary', async () => {
  const code = extractFunction('loadDashboardSummaryFromApi');
  const capturedUrls = [];
  let rendered = 0;

  globalThis.state = {
    currentUser: { id: 'U_MGR', role: 'MANAGER' },
    dashboardSummary: { data: null, loading: false, error: null, loadedRole: '' }
  };
  globalThis.renderView = () => { rendered++; };
  globalThis.fetch = async (url) => {
    capturedUrls.push(url);
    return {
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            role: 'MANAGER',
            as_of_date: '2026-11-19',
            kpis: { active_customers_count: 5, open_pos_count: 3, active_contract_mt: 250, active_shipments_count: 4, completed_shipments_count: 2 }
          }
        };
      }
    };
  };

  try {
    const load = new Function(`return (${code.trim()});`)();
    await load();
    assert.deepEqual(capturedUrls, ['/api/dashboard']);
    assert.equal(globalThis.state.dashboardSummary.loadedRole, 'MANAGER');
    assert.equal(globalThis.state.dashboardSummary.data.kpis.open_pos_count, 3);
    assert.ok(rendered >= 1);
  } finally {
    delete globalThis.state;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});

test('renderDashboard uses live D1 dashboardSummary across all 6 roles with zero mock array reads', () => {
  const dashCode = extractFunction('renderDashboard(container)');
  const bootstrapCode = functionBlock('startAuthenticatedApp()', 'openChangePasswordModal');

  assert.match(bootstrapCode, /loadDashboardSummaryFromApi\(/);
  assert.doesNotMatch(dashCode, /state\.loadingEvents/);
  assert.doesNotMatch(dashCode, /state\.surveyAssignments/);
  assert.doesNotMatch(dashCode, /state\.paymentRecords/);
  assert.doesNotMatch(dashCode, /2026-08-21/);
  assert.doesNotMatch(dashCode, /2026-08-22/);
  assert.doesNotMatch(dashCode, /getProductionOrderRows/);
  assert.match(dashCode, /state\.dashboardSummary/);

  const escapeFn = new Function(`return (${extractFunction('escapeDashboardHtml').trim()});`)();
  const renderCardFn = new Function(`return (${extractFunction('renderDashboardCard').trim()});`)();
  const renderActionFn = new Function(`return (${extractFunction('renderDashboardAction').trim()});`)();
  const renderHeaderFn = new Function(`return (${extractFunction('renderDashboardHeader').trim()});`)();
  const formatMoneyFn = new Function(`return (${extractFunction('formatMoney').trim()});`)();
  const paymentBadgeFn = new Function(`return (${extractFunction('paymentStatusBadge').trim()});`)();
  const renderDashboardFn = new Function('container', `return (${dashCode.trim()})(container);`);

  globalThis.escapeDashboardHtml = escapeFn;
  globalThis.renderDashboardCard = renderCardFn;
  globalThis.renderDashboardAction = renderActionFn;
  globalThis.renderDashboardHeader = renderHeaderFn;
  globalThis.formatMoney = formatMoneyFn;
  globalThis.paymentStatusBadge = paymentBadgeFn;
  globalThis.loadDashboardSummaryFromApi = async () => {};
  globalThis.getScopedCustomers = () => [];
  globalThis.lucide = { createIcons() {} };

  const sharedTeamOverview = {
    active_pos: {
      active_po_count: 2,
      total_contract_mt: 175,
      product_breakdown: [
        { product_id: 'P1', product_code: 'THP-65', product_name: 'Tapioca Pellet 65%', short_name: 'THP65', po_count: 1, contract_qty_mt: 100, shipped_qty_mt: 20, remaining_qty_mt: 80 },
        { product_id: 'P2', product_code: 'THS-85', product_name: 'Tapioca Starch 85%', short_name: 'THS85', po_count: 2, contract_qty_mt: 75, shipped_qty_mt: 0, remaining_qty_mt: 75 }
      ]
    },
    fulfillment: { total_contract_mt: 175, actual_shipped_mt: 20, remaining_contract_mt: 155, shipped_pct: 11.4 },
    this_month: { month: '2026-11', total_mt: 35, total_containers: 3, shipment_count: 2, shipped_mt: 20, shipped_containers: 1, shipped_count: 1, remaining_mt: 15, remaining_containers: 2, remaining_count: 1 },
    next_month: { month: '2026-12', planned_mt: 67, planned_containers: 4, shipment_count: 2, shipped_mt: 0, shipped_containers: 0, shipped_count: 0, remaining_mt: 67, remaining_containers: 4, remaining_count: 2 }
  };

  const payloads = {
    ADMIN: {
      role: 'ADMIN',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { active_users: 7, inactive_users: 1, customers_count: 4, active_customers_count: 4, total_products: 5, active_products: 5, total_logistics_partners: 3, active_logistics_partners: 3, open_pos: 2, payable_commissions_count: 1 },
      role_breakdown: [{ role: 'ADMIN', total_count: 1, active_count: 1 }],
      health: [{ key: 'PARTNER_CONTACT', label: 'Active Logistics Partners without Contact Info', count: 1, view: 'logistics_partners' }]
    },
    MANAGER: {
      role: 'MANAGER',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { active_customers_count: 4, total_customers_count: 4, open_pos_count: 2, active_contract_mt: 150, active_shipments_count: 3, completed_shipments_count: 1 },
      payments_summary: { paid_count: 1, partial_count: 1, unpaid_count: 1, totals_by_currency: [{ currency: 'USD', final_invoice_total: 10000, payment_total: 6000, outstanding_total: 4000 }] },
      commissions_summary: { pending_usd: 100, payable_usd: 200, paid_usd: 50, payable_count: 1 },
      outstanding_payments: [{ shipment_id: 'SHP-1', di_id: 'DI-1', di_no: 'DI-001', customer_name: 'Meelunie', currency: 'USD', final_invoice_total: 10000, payment_total: 6000, outstanding_balance: 4000, payment_status: 'PARTIAL' }],
      upcoming_milestones: []
    },
    SALES_SUPPORT: {
      role: 'SALES_SUPPORT',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { active_customers_count: 4, open_pos_count: 2, draft_pos_count: 1, active_dis_count: 2, booking_pending_count: 1, payment_followup_count: 2 },
      payments_summary: { paid_count: 1, partial_count: 1, unpaid_count: 1, totals_by_currency: [] },
      upcoming_milestones: []
    },
    EXTERNAL_SALES: {
      role: 'EXTERNAL_SALES',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { my_customers_count: 2, my_active_customers_count: 2, my_open_pos_count: 1, my_active_shipments_count: 1, my_unpaid_shipments_count: 0, my_commission_pending_usd: 0, my_commission_payable_usd: 200, my_commission_paid_usd: 50 },
      recent_shipments: [{ di_no: 'DI-001', customer_name: 'Meelunie', customer_po_no: 'CPO-1', currency: 'USD', shipment_status: 'COMPLETED', etd: '2026-11-25', final_invoice_total: 10000, payment_total: 10000, outstanding_balance: 0, payment_status: 'PAID', commission_ready: true }],
      upcoming_milestones: []
    },
    EXPORT: {
      role: 'EXPORT',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { loading_today_count: 1, booking_pending_count: 1, awaiting_loading_count: 1, docs_pending_count: 1, awaiting_final_invoice_count: 1, payment_followup_count: 2, active_logistics_partners_count: 3 },
      upcoming_milestones: [],
      readiness_queue: [{ shipment_id: 'SHP-2', di_id: 'DI-2', di_no: 'DI-002', customer_name: 'EuroStarch', booking_no: 'BK-002', etd: '2026-11-25', planned_loading_date: '2026-11-21', shipment_status: 'BOOKED', invoice_readiness: 'NO_INVOICE', payment_status: 'UNPAID' }]
    },
    PRODUCTION_WAREHOUSE: {
      role: 'PRODUCTION_WAREHOUSE',
      as_of_date: '2026-11-19',
      team_overview: sharedTeamOverview,
      kpis: { loading_today_count: 1, due_next_7_days_count: 1, planned_shipments_count: 1, loaded_this_month_count: 2, upcoming_planned_mt: 15 },
      upcoming_loadings: [{ planned_loading_date: '2026-11-21', actual_loading_date: null, container_plan: '1 x 20GP', planned_qty_mt: 15, actual_container_count: 0, products: [{ product_code: 'THS-85', product_name: 'Tapioca Starch 85%', planned_qty_mt: 15, packing_snapshot: 'Jumbo Bag' }] }]
    }
  };

  try {
    for (const [role, data] of Object.entries(payloads)) {
      globalThis.state = {
        currentUser: { role },
        dashboardSummary: { data, loading: false, error: null, loadedRole: role }
      };
      const container = { innerHTML: '' };
      renderDashboardFn(container);
      assert.ok(container.innerHTML.length > 100, `${role} dashboard should render live D1 content`);
      if (['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT'].includes(role)) {
        assert.match(container.innerHTML, /data-section="wcat-team-overview"/, `${role} must render WCAT Team Overview`);
        assert.match(container.innerHTML, /WCAT Team Overview/);
        assert.match(container.innerHTML, /THP-65/);
        assert.match(container.innerHTML, /175/);
        assert.match(container.innerHTML, /Nov 2026/);
        assert.match(container.innerHTML, /Dec 2026/);
      } else {
        assert.doesNotMatch(container.innerHTML, /wcat-team-overview|WCAT Team Overview/, `${role} must NEVER render WCAT Team Overview`);
      }
      if (role === 'PRODUCTION_WAREHOUSE') {
        assert.match(container.innerHTML, /THS-85/);
        assert.doesNotMatch(container.innerHTML, /Meelunie|EuroStarch|Commission|Outstanding/);
      }
      if (role === 'EXTERNAL_SALES') {
        assert.match(container.innerHTML, /DI-001/);
        assert.match(container.innerHTML, /200\.00/);
      }
    }
  } finally {
    delete globalThis.state;
    delete globalThis.escapeDashboardHtml;
    delete globalThis.renderDashboardCard;
    delete globalThis.renderDashboardAction;
    delete globalThis.renderDashboardHeader;
    delete globalThis.formatMoney;
    delete globalThis.paymentStatusBadge;
    delete globalThis.loadDashboardSummaryFromApi;
    delete globalThis.getScopedCustomers;
    delete globalThis.lucide;
  }
});

test('Customers table & detail resolve live D1 owner (no Sarah Jenkins mock fallback)', () => {
  assert.doesNotMatch(html, /Sarah Jenkins/, 'Mock user Sarah Jenkins must not exist in public/index.html');

  const renderCustomersCode = extractFunction('renderCustomers(container)');
  const renderCustomerDetailCode = extractFunction('renderCustomerDetail(container, id)');
  assert.doesNotMatch(renderCustomersCode, /state\.users/, 'renderCustomers must not read mock state.users');
  assert.doesNotMatch(renderCustomerDetailCode, /state\.users/, 'renderCustomerDetail must not read mock state.users');

  const renderCustomersFn = new Function('container', `return (${renderCustomersCode.trim()})(container);`);

  globalThis.state = {
    currentUser: { id: 'USR-0001', name: 'Chiradet', role: 'ADMIN' },
    users: [{ id: 'USR-0002', name: 'Stale Mock User', role: 'SALES_SUPPORT' }],
    customerOwners: [{ id: 'USR-0002', name: 'Sira', role: 'EXTERNAL_SALES' }],
    adminUsers: [],
    externalSales: [],
    customers: [
      { id: 'CUST-0001', code: 'C-C-001', name: 'MEELUNIE B.V.', country: 'The Netherlands', source: 'EXTERNAL_SALES', ownerId: 'USR-0002', ownerName: 'Sira', ownerRole: 'EXTERNAL_SALES', ownershipType: 'ASSIGNED_SALES', status: 'ACTIVE_CUSTOMER' },
      { id: 'CUST-0002', code: 'C-C-002', name: 'House Buyer', country: 'USA', source: 'DIRECT', ownerId: '', ownerName: '', ownerRole: '', ownershipType: 'HOUSE_ACCOUNT', status: 'ACTIVE_CUSTOMER' }
    ]
  };
  globalThis.getScopedCustomers = () => globalThis.state.customers;
  globalThis.canCreateCustomer = () => true;
  globalThis.canEditCustomer = () => true;
  globalThis.lucide = { createIcons() {} };

  try {
    const container = { innerHTML: '' };
    renderCustomersFn(container);
    assert.match(container.innerHTML, /MEELUNIE B\.V\./);
    assert.match(container.innerHTML, /Sira/);
    assert.match(container.innerHTML, /House Account/);
    assert.doesNotMatch(container.innerHTML, /Stale Mock User/);
    assert.doesNotMatch(container.innerHTML, /Sarah Jenkins/);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.canCreateCustomer;
    delete globalThis.canEditCustomer;
    delete globalThis.lucide;
  }
});

test('Product cards render compact Standard Spec summary badges and empty fallback', () => {
  const renderProducts = new Function(`return (${extractFunction('renderProducts').trim()});`)();
  const products = [
    {
      id: 'PRD-001',
      code: 'THP65',
      name: 'Tapioca Hard Pellet 65%',
      shortName: 'THP65',
      hsCode: '0714.10',
      status: 'ACTIVE',
      category: { id: 'CAT-001', name: 'Tapioca' },
      form: { id: 'FRM-001', name: 'Pellet' },
      applications: ['FEED_GRADE'],
      standardSpecs: [
        {
          id: 'STD-001',
          application: 'FEED_GRADE',
          revisionNo: 0,
          status: 'ACTIVE',
          items: [
            { parameterId: 'PAR-001', parameterCode: 'STARCH', parameterName: 'Starch', operator: 'MIN', numericValue: 65, unit: '%' },
            { parameterId: 'PAR-002', parameterCode: 'MOISTURE', parameterName: 'Moisture', operator: 'MAX', numericValue: 14, unit: '%' },
            { parameterId: 'PAR-003', parameterCode: 'PH', parameterName: 'pH', operator: 'RANGE', numericValue: 6, numericValueTo: 7.5, unit: '' },
            { parameterId: 'PAR-004', parameterCode: 'COLOR', parameterName: 'Color', operator: 'TEXT', textValue: 'Cream', unit: '' },
            { parameterId: 'PAR-005', parameterCode: 'ASH', parameterName: 'Ash', operator: 'MAX', numericValue: 3, unit: '%' }
          ]
        }
      ]
    },
    {
      id: 'PRD-002',
      code: 'THS85',
      name: 'Tapioca Starch 85%',
      shortName: 'THS85',
      status: 'ACTIVE',
      category: { id: 'CAT-001', name: 'Tapioca' },
      form: { id: 'FRM-002', name: 'Powder' },
      applications: ['PET_GRADE'],
      standardSpecs: []
    }
  ];

  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    products,
    specParameters: []
  };
  globalThis.lucide = { createIcons() {} };

  try {
    const container = { innerHTML: '' };
    renderProducts(container);
    assert.match(container.innerHTML, /สเปกมาตรฐาน \(Standard Spec\)/);
    assert.match(container.innerHTML, /Starch ≥ 65%/);
    assert.match(container.innerHTML, /Moisture ≤ 14%/);
    assert.match(container.innerHTML, /pH 6–7\.5/);
    assert.match(container.innerHTML, /Color: Cream/);
    assert.match(container.innerHTML, /\+1/);
    assert.match(container.innerHTML, /5 เกณฑ์/);
    assert.match(container.innerHTML, /สเปกมาตรฐาน: ยังไม่ได้กำหนด/);
    assert.doesNotMatch(container.innerHTML, /undefined/);
  } finally {
    delete globalThis.state;
    delete globalThis.lucide;
  }
});

test('openAddProductModal renders Standard Spec Parameters section with active parameters and default_unit auto-fill', () => {
  const helperNames = [
    'escapeProductSpecHtml',
    'getActiveSpecParametersForProductModal',
    'serializeProductSpecItems',
    'buildProductSpecOperatorOptionsHtml',
    'buildProductSpecRowHtml',
    'onProductSpecParameterChange',
    'onProductSpecOperatorChange',
    'loadProductModalStandardSpecs',
    'openAddProductModal'
  ];
  for (const name of helperNames) {
    globalThis[name] = new Function(`return (${extractFunction(name).trim()});`)();
  }

  let modalHtml = '';
  globalThis.openModal = (markup) => { modalHtml = markup; };
  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    products: [],
    productCategories: [{ id: 'CAT-001', code: 'TAP', name: 'Tapioca' }],
    productForms: [{ id: 'FRM-001', code: 'PEL', name: 'Pellet' }],
    specParameters: [
      { id: 'PAR-001', code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 1 },
      { id: 'PAR-002', code: 'COLOR', name: 'Color', dataType: 'TEXT', defaultUnit: '', status: 'ACTIVE', sortOrder: 2 },
      { id: 'PAR-003', code: 'LEGACY', name: 'Legacy Ash', dataType: 'NUMBER', defaultUnit: '%', status: 'ARCHIVED', sortOrder: 3 }
    ]
  };

  try {
    globalThis.openAddProductModal();
    assert.match(modalHtml, /เกรดการใช้งานที่อนุญาต \(Applications\)/);
    assert.match(modalHtml, /ข้อกำหนดสเปกมาตรฐาน \(Standard Spec Parameters\)/);
    assert.match(modalHtml, /\+ เพิ่มเกณฑ์สเปก/);
    assert.ok(
      modalHtml.indexOf('เกรดการใช้งานที่อนุญาต (Applications)') < modalHtml.indexOf('ข้อกำหนดสเปกมาตรฐาน (Standard Spec Parameters)'),
      'Standard Spec Parameters section must appear below Applications'
    );

    const rowHtml = globalThis.buildProductSpecRowHtml({ parameterId: 'PAR-001' });
    assert.match(rowHtml, /Starch \(STARCH\)/);
    assert.match(rowHtml, /Color \(COLOR\)/);
    assert.doesNotMatch(rowHtml, /Legacy Ash/);
    assert.match(rowHtml, /value="%"/);

    // Simulate parameter change from NUMBER to TEXT -> auto-fills unit and forces TEXT operator
    const classes = {
      num: new Set(),
      sep: new Set(['hidden']),
      numTo: new Set(['hidden']),
      text: new Set(['hidden'])
    };
    const makeClassList = (set) => ({
      toggle(cls, force) { if (force) set.add(cls); else set.delete(cls); }
    });
    const unitInput = { value: '%' };
    const opSelect = { value: 'MIN', innerHTML: '', closest: () => fakeRow };
    const numInput = { classList: makeClassList(classes.num), placeholder: '' };
    const rangeSep = { classList: makeClassList(classes.sep) };
    const numToInput = { classList: makeClassList(classes.numTo) };
    const textInput = { classList: makeClassList(classes.text) };
    const fakeRow = {
      querySelector(sel) {
        if (sel === '.prod-spec-unit') return unitInput;
        if (sel === '.prod-spec-operator') return opSelect;
        if (sel === '.prod-spec-num') return numInput;
        if (sel === '.prod-spec-range-sep') return rangeSep;
        if (sel === '.prod-spec-num-to') return numToInput;
        if (sel === '.prod-spec-text') return textInput;
        return null;
      }
    };
    globalThis.onProductSpecParameterChange({ value: 'PAR-002', closest: () => fakeRow });
    assert.equal(unitInput.value, '');
    assert.equal(opSelect.value, 'TEXT');
    assert.equal(classes.num.has('hidden'), true);
    assert.equal(classes.text.has('hidden'), false);
  } finally {
    for (const name of helperNames) delete globalThis[name];
    delete globalThis.openModal;
    delete globalThis.state;
  }
});

test('saveProduct (Create) validates specs first, creates product, then saves and activates Standard Spec via Phase 5D APIs', async () => {
  const helperNames = [
    'serializeProductSpecItems',
    'readProductSpecRowsFromDom',
    'validateAndNormalizeProductSpecRows',
    'saveProduct'
  ];
  for (const name of helperNames) {
    globalThis[name] = new Function(`return (${extractFunction(name).trim()});`)();
  }

  let specDomRows = [];
  const makeRowEl = (row) => ({
    querySelector(sel) {
      if (sel === '.prod-spec-param') return { value: row.parameterId || '' };
      if (sel === '.prod-spec-operator') return { value: row.operator || 'MIN' };
      if (sel === '.prod-spec-unit') return { value: row.unit ?? '' };
      if (sel === '.prod-spec-num') return { value: row.numericValue ?? '' };
      if (sel === '.prod-spec-num-to') return { value: row.numericValueTo ?? '' };
      if (sel === '.prod-spec-text') return { value: row.textValue ?? '' };
      if (sel === '.prod-spec-notes') return { value: row.notes ?? '' };
      return null;
    }
  });

  const errorClasses = new Set(['hidden']);
  const fields = {
    prodCode: { value: 'THP75', disabled: false },
    prodName: { value: 'Tapioca Hard Pellet 75%' },
    prodShortName: { value: 'THP75' },
    prodHsCode: { value: '0714.10' },
    prodCategoryId: { value: 'CAT-001' },
    prodFormId: { value: 'FRM-001' },
    prodDefaultUnit: { value: 'MT' },
    prodStatus: { value: 'ACTIVE' },
    prodAppFeed: { checked: true },
    prodAppPet: { checked: false },
    prodSpecAppScope: { value: 'ALL' },
    productSpecRows: { querySelectorAll: () => specDomRows.map(makeRowEl) },
    productFormError: {
      innerText: '',
      classList: { add: (c) => errorClasses.add(c), remove: (c) => errorClasses.delete(c) }
    },
    saveProductSubmitBtn: { disabled: false, textContent: 'Save Product', setAttribute() {} }
  };

  const calls = [];
  let modalClosed = 0;
  let productsReloaded = 0;
  let viewedPage = '';

  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    currentView: 'products',
    specParameters: [
      { id: 'PAR-001', code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE' },
      { id: 'PAR-002', code: 'PH', name: 'pH', dataType: 'NUMBER', defaultUnit: '', status: 'ACTIVE' }
    ],
    productModalSpecState: {
      productId: null,
      activeScope: 'ALL',
      rowsByApp: {},
      loadedSpecsByApp: {},
      originalSnapshotByApp: {},
      userModified: true
    }
  };
  globalThis.closeModal = () => { modalClosed += 1; };
  globalThis.loadProductsFromApi = async () => { productsReloaded += 1; };
  globalThis.changeView = (v) => { viewedPage = v; };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    if (url === '/api/products' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { product: { id: 'PRD-099', code: 'THP75' } } }; } };
    }
    if (url === '/api/standard-specs' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-099', status: 'DRAFT' } } }; } };
    }
    if (url === '/api/standard-specs/STD-099' && options.method === 'PUT') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-099', items: body.items } } }; } };
    }
    if (url === '/api/standard-specs/STD-099/activate' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-099', status: 'ACTIVE' } } }; } };
    }
    throw new Error(`Unexpected fetch: ${options.method} ${url}`);
  };

  try {
    // 1. Invalid RANGE (max <= min) must fail BEFORE POST /api/products
    specDomRows = [{ parameterId: 'PAR-002', operator: 'RANGE', numericValue: '8', numericValueTo: '6', unit: '' }];
    await globalThis.saveProduct(null);
    assert.equal(calls.length, 0, 'Must not create product when spec validation fails');
    assert.equal(errorClasses.has('hidden'), false);
    assert.match(fields.productFormError.innerText, /ค่าสูงสุด/);

    // 2. Valid spec rows -> POST /api/products -> POST /api/standard-specs -> PUT /api/standard-specs/:id -> POST activate
    specDomRows = [
      { parameterId: 'PAR-001', operator: 'MIN', numericValue: '75', unit: '%', notes: 'Min starch' },
      { parameterId: 'PAR-002', operator: 'RANGE', numericValue: '6', numericValueTo: '7.5', unit: '' }
    ];
    await globalThis.saveProduct(null);
    assert.equal(calls.length, 4);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, '/api/products');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[1].url, '/api/standard-specs');
    assert.equal(calls[1].body.productId, 'PRD-099');
    assert.equal(calls[1].body.application, 'FEED_GRADE');
    assert.equal(calls[2].method, 'PUT');
    assert.equal(calls[2].url, '/api/standard-specs/STD-099');
    assert.equal(calls[2].body.items.length, 2);
    assert.equal(calls[2].body.items[0].numericValue, 75);
    assert.equal(calls[2].body.items[1].numericValue, 6);
    assert.equal(calls[2].body.items[1].numericValueTo, 7.5);
    assert.equal(calls[3].method, 'POST');
    assert.equal(calls[3].url, '/api/standard-specs/STD-099/activate');
    assert.equal(modalClosed, 1);
    assert.equal(productsReloaded, 1);
    assert.equal(viewedPage, 'products');
  } finally {
    for (const name of helperNames) delete globalThis[name];
    delete globalThis.document;
    delete globalThis.state;
    delete globalThis.closeModal;
    delete globalThis.loadProductsFromApi;
    delete globalThis.changeView;
    delete globalThis.fetch;
  }
});

test('Edit Product pre-loads standard specs, skips redundant spec revisions when unchanged, and updates/activates when modified', async () => {
  const helperNames = [
    'escapeProductSpecHtml',
    'getActiveSpecParametersForProductModal',
    'serializeProductSpecItems',
    'buildProductSpecOperatorOptionsHtml',
    'buildProductSpecRowHtml',
    'readProductSpecRowsFromDom',
    'renderProductSpecRowsIntoDom',
    'validateAndNormalizeProductSpecRows',
    'loadProductModalStandardSpecs',
    'saveProduct'
  ];
  for (const name of helperNames) {
    globalThis[name] = new Function(`return (${extractFunction(name).trim()});`)();
  }

  let specDomRows = [];
  const makeRowEl = (row) => ({
    querySelector(sel) {
      if (sel === '.prod-spec-param') return { value: row.parameterId || '' };
      if (sel === '.prod-spec-operator') return { value: row.operator || 'MIN' };
      if (sel === '.prod-spec-unit') return { value: row.unit ?? '' };
      if (sel === '.prod-spec-num') return { value: row.numericValue ?? '' };
      if (sel === '.prod-spec-num-to') return { value: row.numericValueTo ?? '' };
      if (sel === '.prod-spec-text') return { value: row.textValue ?? '' };
      if (sel === '.prod-spec-notes') return { value: row.notes ?? '' };
      return null;
    }
  });

  const fields = {
    prodCode: { value: 'THP65', disabled: true },
    prodName: { value: 'Tapioca Hard Pellet 65% Updated' },
    prodShortName: { value: 'THP65' },
    prodHsCode: { value: '0714.10.90' },
    prodCategoryId: { value: 'CAT-001' },
    prodFormId: { value: 'FRM-001' },
    prodDefaultUnit: { value: 'MT' },
    prodStatus: { value: 'ACTIVE' },
    prodAppFeed: { checked: true },
    prodAppPet: { checked: false },
    prodSpecAppScope: { value: 'FEED_GRADE' },
    productSpecRows: { innerHTML: '', querySelectorAll: () => specDomRows.map(makeRowEl) },
    productSpecEmptyHint: { classList: { add() {}, remove() {} } },
    productSpecLoadingHint: { classList: { add() {}, remove() {} } },
    productFormError: { innerText: '', classList: { add() {}, remove() {} } },
    saveProductSubmitBtn: { disabled: false, textContent: 'Save Product', setAttribute() {} }
  };

  const calls = [];
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    currentView: 'products',
    specParameters: [
      { id: 'PAR-001', code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE' }
    ],
    productModalSpecState: {
      productId: 'PRD-001',
      activeScope: 'FEED_GRADE',
      rowsByApp: {},
      loadedSpecsByApp: {},
      originalSnapshotByApp: {},
      userModified: false
    }
  };
  globalThis.closeModal = () => {};
  globalThis.loadProductsFromApi = async () => {};
  globalThis.changeView = () => {};
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method || 'GET', body });
    if (url === '/api/products/PRD-001/standard-specs?application=FEED_GRADE') {
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            status: 'SUCCESS',
            data: {
              standardSpecs: [
                {
                  id: 'STD-001',
                  application: 'FEED_GRADE',
                  status: 'ACTIVE',
                  items: [{ parameterId: 'PAR-001', operator: 'MIN', numericValue: 65, numericValueTo: null, textValue: null, unit: '%', notes: '' }]
                }
              ]
            }
          };
        }
      };
    }
    if (url === '/api/products/PRD-001' && options.method === 'PUT') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { product: { id: 'PRD-001' } } }; } };
    }
    if (url === '/api/standard-specs' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-002', status: 'DRAFT' } } }; } };
    }
    if (url === '/api/standard-specs/STD-002' && options.method === 'PUT') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-002', items: body.items } } }; } };
    }
    if (url === '/api/standard-specs/STD-002/activate' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { standardSpec: { id: 'STD-002', status: 'ACTIVE' } } }; } };
    }
    throw new Error(`Unexpected fetch: ${options.method} ${url}`);
  };

  try {
    // 1. Pre-load active spec for PRD-001
    await globalThis.loadProductModalStandardSpecs('PRD-001', ['FEED_GRADE']);
    assert.equal(globalThis.state.productModalSpecState.rowsByApp.FEED_GRADE.length, 1);
    assert.equal(globalThis.state.productModalSpecState.rowsByApp.FEED_GRADE[0].numericValue, 65);
    assert.match(fields.productSpecRows.innerHTML, /value="65"/);

    // 2. Save without changing spec items -> only PUT /api/products/PRD-001 (no redundant standard-spec revision)
    calls.length = 0;
    specDomRows = [{ parameterId: 'PAR-001', operator: 'MIN', numericValue: '65', unit: '%', notes: '' }];
    await globalThis.saveProduct('PRD-001');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PUT');
    assert.equal(calls[0].url, '/api/products/PRD-001');

    // 3. Re-open state and modify spec from 65 -> 68 -> PUT product + POST draft + PUT items + POST activate
    globalThis.state.productModalSpecState = {
      productId: 'PRD-001',
      activeScope: 'FEED_GRADE',
      rowsByApp: {},
      loadedSpecsByApp: {},
      originalSnapshotByApp: {},
      userModified: false
    };
    await globalThis.loadProductModalStandardSpecs('PRD-001', ['FEED_GRADE']);
    calls.length = 0;
    specDomRows = [{ parameterId: 'PAR-001', operator: 'MIN', numericValue: '68', unit: '%', notes: 'Upgraded grade' }];
    await globalThis.saveProduct('PRD-001');
    assert.equal(calls.length, 4);
    assert.equal(calls[0].url, '/api/products/PRD-001');
    assert.equal(calls[1].url, '/api/standard-specs');
    assert.equal(calls[2].url, '/api/standard-specs/STD-002');
    assert.equal(calls[2].body.items[0].numericValue, 68);
    assert.equal(calls[3].url, '/api/standard-specs/STD-002/activate');
  } finally {
    for (const name of helperNames) delete globalThis[name];
    delete globalThis.document;
    delete globalThis.state;
    delete globalThis.closeModal;
    delete globalThis.loadProductsFromApi;
    delete globalThis.changeView;
    delete globalThis.fetch;
  }
});

test('Product and Spec Master shows Category & Form maintenance only to ADMIN and MANAGER', () => {
  const renderProducts = new Function(`return (${extractFunction('renderProducts').trim()});`)();
  const renderFor = (role) => {
    globalThis.state = {
      currentUser: { role },
      products: [],
      productCategories: [{ id: 'CAT-001', code: 'TAPIOCA', name: 'Tapioca', status: 'ACTIVE' }],
      productForms: [{ id: 'FRM-001', code: 'PELLET', name: 'Pellet', status: 'ACTIVE' }],
      specParameters: []
    };
    globalThis.lucide = { createIcons() {} };
    const container = { innerHTML: '' };
    renderProducts(container);
    return container.innerHTML;
  };

  try {
    for (const role of ['ADMIN', 'MANAGER']) {
      const markup = renderFor(role);
      assert.match(markup, /หมวดสินค้า \(Product Categories\)/);
      assert.match(markup, /รูปแบบสินค้า \(Product Forms\)/);
      assert.match(markup, /\+ เพิ่มหมวดสินค้า/);
      assert.match(markup, /\+ เพิ่มรูปแบบสินค้า/);
      assert.match(markup, /TAPIOCA/);
      assert.match(markup, /PELLET/);
    }
    for (const role of ['SALES_SUPPORT', 'EXTERNAL_SALES', 'EXPORT']) {
      const markup = renderFor(role);
      assert.doesNotMatch(markup, /\+ เพิ่มหมวดสินค้า|\+ เพิ่มรูปแบบสินค้า|openCategoryMasterModal|openFormMasterModal/);
    }
  } finally {
    delete globalThis.state;
    delete globalThis.lucide;
  }
});

test('Product modal enables Category/Form dropdowns and supports inline quick-add with auto-select', async () => {
  const helperNames = [
    'escapeProductSpecHtml',
    'getActiveSpecParametersForProductModal',
    'serializeProductSpecItems',
    'buildProductSpecOperatorOptionsHtml',
    'buildProductSpecRowHtml',
    'refreshProductModalMasterSelect',
    'saveInlineProductCategory',
    'saveInlineProductForm',
    'loadProductModalStandardSpecs',
    'openAddProductModal'
  ];
  for (const name of helperNames) {
    globalThis[name] = new Function(`return (${extractFunction(name).trim()});`)();
  }

  let modalHtml = '';
  globalThis.openModal = (markup) => { modalHtml = markup; };
  globalThis.state = {
    currentUser: { role: 'ADMIN' },
    products: [],
    productCategories: [{ id: 'CAT-001', code: 'TAPIOCA', name: 'Tapioca', status: 'ACTIVE' }],
    productForms: [{ id: 'FRM-001', code: 'PELLET', name: 'Pellet', status: 'ACTIVE' }],
    specParameters: []
  };

  const catSelect = { innerHTML: '', value: 'CAT-001' };
  const formSelect = { innerHTML: '', value: 'FRM-001' };
  const catBoxHidden = new Set();
  const formBoxHidden = new Set();
  const fields = {
    prodCategoryId: catSelect,
    prodFormId: formSelect,
    inlineNewCategoryCode: { value: 'SWEET_POTATO' },
    inlineNewCategoryName: { value: 'Sweet Potato' },
    inlineNewCategoryError: { textContent: '', classList: { add() {}, remove() {} } },
    inlineAddCategoryBox: { classList: { add: (c) => catBoxHidden.add(c), remove: (c) => catBoxHidden.delete(c) } },
    inlineNewFormCode: { value: 'CHIP' },
    inlineNewFormName: { value: 'Chip' },
    inlineNewFormError: { textContent: '', classList: { add() {}, remove() {} } },
    inlineAddFormBox: { classList: { add: (c) => formBoxHidden.add(c), remove: (c) => formBoxHidden.delete(c) } }
  };

  const calls = [];
  let catRefreshes = 0;
  let formRefreshes = 0;
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.loadProductCategoriesFromApi = async () => { catRefreshes += 1; };
  globalThis.loadProductFormsFromApi = async () => { formRefreshes += 1; };
  globalThis.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body });
    if (url === '/api/product-categories' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { category: { id: 'CAT-002', code: body.code, name: body.name, status: 'ACTIVE' } } }; } };
    }
    if (url === '/api/product-forms' && options.method === 'POST') {
      return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: { form: { id: 'FRM-002', code: body.code, name: body.name, status: 'ACTIVE' } } }; } };
    }
    throw new Error(`Unexpected fetch: ${options.method} ${url}`);
  };

  try {
    globalThis.openAddProductModal();
    assert.match(modalHtml, /<select id="prodCategoryId" class="ui-input">/);
    assert.match(modalHtml, /<select id="prodFormId" class="ui-input">/);
    assert.doesNotMatch(modalHtml, /id="prodCategoryId"[^>]*disabled/);
    assert.doesNotMatch(modalHtml, /id="prodFormId"[^>]*disabled/);
    assert.match(modalHtml, /\+ เพิ่มหมวดใหม่/);
    assert.match(modalHtml, /\+ เพิ่มรูปแบบใหม่/);

    await globalThis.saveInlineProductCategory();
    assert.equal(calls[0].url, '/api/product-categories');
    assert.equal(calls[0].body.code, 'SWEET_POTATO');
    assert.equal(catSelect.value, 'CAT-002');
    assert.match(catSelect.innerHTML, /Sweet Potato \(SWEET_POTATO\)/);
    assert.equal(catBoxHidden.has('hidden'), true);
    assert.equal(catRefreshes, 1);

    await globalThis.saveInlineProductForm();
    assert.equal(calls[1].url, '/api/product-forms');
    assert.equal(calls[1].body.code, 'CHIP');
    assert.equal(formSelect.value, 'FRM-002');
    assert.match(formSelect.innerHTML, /Chip \(CHIP\)/);
    assert.equal(formBoxHidden.has('hidden'), true);
    assert.equal(formRefreshes, 1);
  } finally {
    for (const name of helperNames) delete globalThis[name];
    delete globalThis.openModal;
    delete globalThis.state;
    delete globalThis.document;
    delete globalThis.loadProductCategoriesFromApi;
    delete globalThis.loadProductFormsFromApi;
    delete globalThis.fetch;
  }
});

test('saveCategoryMaster and saveFormMaster use POST for create and PUT for edit', async () => {
  const saveCategoryMaster = new Function(`return (${extractFunction('saveCategoryMaster').trim()});`)();
  const saveFormMaster = new Function(`return (${extractFunction('saveFormMaster').trim()});`)();

  const fields = {
    productCategoryCode: { value: 'tapioca' },
    productCategoryName: { value: 'Tapioca' },
    productCategoryStatus: { value: 'ACTIVE' },
    productCategoryFormError: { textContent: '', classList: { add() {}, remove() {} } },
    productFormCode: { value: 'pellet' },
    productFormName: { value: 'Pellet' },
    productFormStatus: { value: 'ACTIVE' },
    productFormMasterError: { textContent: '', classList: { add() {}, remove() {} } }
  };

  const calls = [];
  globalThis.document = { getElementById: (id) => fields[id] || null };
  globalThis.loadProductCategoriesFromApi = async () => {};
  globalThis.loadProductFormsFromApi = async () => {};
  globalThis.loadProductsFromApi = async () => {};
  globalThis.closeModal = () => {};
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method, body: JSON.parse(options.body) });
    return { ok: true, status: 200, async json() { return { status: 'SUCCESS', data: {} }; } };
  };

  try {
    await saveCategoryMaster(null);
    await saveCategoryMaster('CAT-001');
    await saveFormMaster(null);
    await saveFormMaster('FRM-001');

    assert.equal(calls[0].url, '/api/product-categories');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].body.code, 'TAPIOCA');

    assert.equal(calls[1].url, '/api/product-categories/CAT-001');
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].body.code, 'TAPIOCA');

    assert.equal(calls[2].url, '/api/product-forms');
    assert.equal(calls[2].method, 'POST');
    assert.equal(calls[2].body.code, 'PELLET');

    assert.equal(calls[3].url, '/api/product-forms/FRM-001');
    assert.equal(calls[3].method, 'PUT');
    assert.equal(calls[3].body.code, 'PELLET');
  } finally {
    delete globalThis.document;
    delete globalThis.loadProductCategoriesFromApi;
    delete globalThis.loadProductFormsFromApi;
    delete globalThis.loadProductsFromApi;
    delete globalThis.closeModal;
    delete globalThis.fetch;
  }
});

test('PO Management removes hardcoded mock POs and loads live D1 POs from GET /api/pos', async () => {
  const stateBlockStart = html.indexOf('const state = {');
  const stateBlockEnd = html.indexOf('shipments: [', stateBlockStart);
  assert.ok(stateBlockStart >= 0 && stateBlockEnd > stateBlockStart);
  const stateInitPrefix = html.slice(stateBlockStart, stateBlockEnd);

  assert.match(stateInitPrefix, /pos:\s*\[\s*\]/);
  assert.match(stateInitPrefix, /customers:\s*\[\s*\]/);
  assert.doesNotMatch(stateInitPrefix, /PO-2026-001|PO-2026-002|PO-2026-003|PO-MEEL-2601|PO-MEEL-2608|PO-LKO-2604/);
  assert.doesNotMatch(stateInitPrefix, /CUST-001|CUST-002/);

  const bootstrapCode = functionBlock('startAuthenticatedApp()', 'openChangePasswordModal');
  assert.match(bootstrapCode, /loadPOsFromApi\(\)/);

  const changeViewCode = functionBlock('changeView(id)', 'goToPODetail');
  assert.match(changeViewCode, /po_engine[\s\S]*?loadPOsFromApi\(\)/);

  const loadPOsCode = extractFunction('loadPOsFromApi()');
  const renderListCode = extractFunction('renderRealPOListTable()');
  const loadPOsFn = new Function(`return (${loadPOsCode.trim()});`)();
  const renderListFn = new Function(`return (${renderListCode.trim()});`)();

  let renderCount = 0;
  globalThis.state = {
    pos: [],
    posLoaded: false,
    posLoading: false,
    posError: '',
    poFilters: { search: '', customerId: 'ALL', status: 'ALL' },
    customers: [{ id: 'CUST-0001', code: 'C-C-001', name: 'MEELUNIE B.V.', ownershipType: 'ASSIGNED_SALES' }],
    products: [{ id: 'PRD-002', code: 'WCAT_PRO_001', shortName: 'TRP_45', name: 'Tapioca Residue Pellet' }],
    currentUser: { id: 'USR-0001', role: 'ADMIN' }
  };
  globalThis.getScopedCustomers = () => globalThis.state.customers;
  globalThis.renderView = () => { renderCount++; };

  try {
    // 1. Live D1 returns empty array -> clean empty state, no mock POs
    globalThis.fetch = async (url) => {
      assert.equal(url, '/api/pos');
      return { ok: true, async json() { return { status: 'SUCCESS', data: { pos: [] } }; } };
    };
    await loadPOsFn();
    assert.equal(globalThis.state.posLoaded, true);
    assert.equal(globalThis.state.posLoading, false);
    assert.equal(globalThis.state.pos.length, 0);
    assert.equal(renderCount, 1);

    const emptyHtml = renderListFn();
    assert.match(emptyHtml, /No POs yet/);
    assert.doesNotMatch(emptyHtml, /PO-2026-001|PO-2026-002|PO-2026-003|CUST-001|CUST-002/);

    // 2. Live D1 returns real PO -> renders live D1 PO cleanly and ignores legacy flat mock objects
    globalThis.fetch = async () => ({
      ok: true,
      async json() {
        return {
          status: 'SUCCESS',
          data: {
            pos: [{
              header: { po_id: 'PO-2026-010', customer_id: 'CUST-0001', header_status: 'OPEN' },
              revisions: [{
                revision_id: 'REV-1',
                revision_no: 1,
                status: 'ACTIVE',
                customer_po_no: 'MEEL-LIVE-01',
                po_date: '2026-09-01',
                lines: [{ product_id: 'PRD-002', contract_qty_mt: 540 }]
              }]
            }]
          }
        };
      }
    });
    await loadPOsFn();
    const liveHtml = renderListFn();
    assert.match(liveHtml, /PO-2026-010/);
    assert.match(liveHtml, /MEEL-LIVE-01/);
    assert.match(liveHtml, /MEELUNIE B\.V\./);
    assert.match(liveHtml, /TRP_45/);
    assert.match(liveHtml, /540 MT/);
  } finally {
    delete globalThis.state;
    delete globalThis.getScopedCustomers;
    delete globalThis.renderView;
    delete globalThis.fetch;
  }
});
