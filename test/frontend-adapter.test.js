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


