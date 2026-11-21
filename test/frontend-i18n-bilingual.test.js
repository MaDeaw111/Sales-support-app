import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function extractFunction(name) {
  const asyncSig = `async function ${name}(`;
  const syncSig = `function ${name}(`;
  const start = html.indexOf(asyncSig) >= 0 ? html.indexOf(asyncSig) : html.indexOf(syncSig);
  assert.ok(start >= 0, `function ${name} must exist in public/index.html`);
  const openBrace = html.indexOf('{', start);
  assert.ok(openBrace >= 0, `opening brace for ${name}`);
  let depth = 1;
  let i = openBrace + 1;
  while (depth > 0 && i < html.length) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') depth--;
    i++;
  }
  return html.slice(start, i);
}

function extractI18nCore() {
  const start = html.indexOf('const UI_LANG_STORAGE_KEY =');
  const end = html.indexOf('const AUTH_STORAGE_KEY =');
  assert.ok(start >= 0 && end > start, 'I18N core block must exist before AUTH_STORAGE_KEY');
  return html.slice(start, end);
}

function createMockElement(tag = 'div', attrs = {}) {
  const classes = new Set((attrs.className || '').split(/\s+/).filter(Boolean));
  const attributes = { ...(attrs.attributes || {}) };
  return {
    tagName: tag.toUpperCase(),
    id: attrs.id || '',
    innerHTML: attrs.innerHTML || '',
    textContent: attrs.textContent || '',
    innerText: attrs.innerText || '',
    placeholder: attrs.placeholder || '',
    value: attrs.value || '',
    dataset: { ...(attrs.dataset || {}) },
    style: {},
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (x, force) => {
        if (force === true) classes.add(x);
        else if (force === false) classes.delete(x);
        else if (classes.has(x)) classes.delete(x);
        else classes.add(x);
      },
      contains: (x) => classes.has(x)
    },
    getAttribute: (k) => (k in attributes ? attributes[k] : null),
    setAttribute: (k, v) => { attributes[k] = String(v); },
    hasAttribute: (k) => k in attributes
  };
}

function createI18nHarness(extraSources = [], options = {}) {
  const storage = new Map(Object.entries(options.initialStorage || {}));
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };

  const i18nNodes = [
    createMockElement('span', { attributes: { 'data-i18n': 'login.badge' } }),
    createMockElement('h1', { attributes: { 'data-i18n': 'login.title' } }),
    createMockElement('button', { id: 'loginSubmitBtn', attributes: { 'data-i18n': 'login.signIn' } }),
    createMockElement('span', { attributes: { 'data-i18n': 'header.changePassword' } }),
    createMockElement('span', { attributes: { 'data-i18n': 'header.signOut' } })
  ];
  const placeholderNodes = [
    createMockElement('input', { id: 'loginEmail', attributes: { 'data-i18n-placeholder': 'login.emailPlaceholder' } }),
    createMockElement('input', { id: 'loginPassword', attributes: { 'data-i18n-placeholder': 'login.passwordPlaceholder' } })
  ];
  const ariaNodes = [
    createMockElement('div', { id: 'headerLangToggle', attributes: { 'data-i18n-aria-label': 'common.languageSwitcher' } })
  ];
  const langButtons = [
    createMockElement('button', { attributes: { 'data-lang-btn': 'TH' } }),
    createMockElement('button', { attributes: { 'data-lang-btn': 'EN' } }),
    createMockElement('button', { attributes: { 'data-lang-btn': 'TH' } }),
    createMockElement('button', { attributes: { 'data-lang-btn': 'EN' } })
  ];

  const byId = new Map([
    ['loginSubmitBtn', i18nNodes[2]],
    ['loginEmail', placeholderNodes[0]],
    ['loginPassword', placeholderNodes[1]],
    ['headerLangToggle', ariaNodes[0]],
    ['sidebarNav', createMockElement('nav', { id: 'sidebarNav' })],
    ['mobileSidebarNav', createMockElement('nav', { id: 'mobileSidebarNav' })],
    ['headerUserName', createMockElement('span', { id: 'headerUserName' })],
    ['headerUserRole', createMockElement('span', { id: 'headerUserRole' })],
    ['loginScreen', createMockElement('div', { id: 'loginScreen', className: 'hidden' })],
    ['appShell', createMockElement('div', { id: 'appShell' })]
  ]);

  const document = {
    documentElement: { lang: 'th' },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (sel) => {
      if (sel === '[data-i18n]') return i18nNodes;
      if (sel === '[data-i18n-placeholder]') return placeholderNodes;
      if (sel === '[data-i18n-aria-label]') return ariaNodes;
      if (sel === '[data-lang-btn]') return langButtons;
      return [];
    }
  };

  let lastModalHtml = '';
  let renderSidebarCount = 0;
  let renderViewCount = 0;
  let lastCopiedText = '';

  const state = {
    currentLang: 'TH',
    currentView: 'dashboard',
    currentUser: { id: 'u-admin', name: 'Admin One', email: 'admin@wcat.local', role: 'ADMIN' },
    users: [{ id: 'u-admin', name: 'Admin One', email: 'admin@wcat.local', role: 'ADMIN', status: 'ACTIVE' }],
    customers: [{ id: 'c1', customer_id: 'c1', code: 'CUST01', name: 'Nordic Feed Co', customer_name: 'Nordic Feed Co', source: 'HOUSE', ownerId: 'u-admin', status: 'ACTIVE', country: 'Sweden' }],
    customerOwners: [{ user_id: 'u-admin', full_name: 'Admin One', status: 'ACTIVE' }],
    products: [{
      id: 'p1',
      code: 'THP65',
      name: 'Tapioca Hard Pellet 65%',
      shortName: 'THP65',
      hsCode: '0714.10',
      defaultUnit: 'MT',
      status: 'ACTIVE',
      category: { id: 'cat1', code: 'TAPIOCA', name: 'Tapioca' },
      form: { id: 'frm1', code: 'PELLET', name: 'Pellet' },
      applications: ['FEED_GRADE'],
      standardSpecs: [{
        id: 'spec1',
        application: 'FEED_GRADE',
        revisionNo: 1,
        effectiveDate: '2026-01-01',
        items: [{
          parameterId: 'par1',
          parameterCode: 'STARCH',
          parameterName: 'Starch',
          operator: 'MIN',
          numericValue: 65,
          unit: '%',
          notes: 'Min starch'
        }]
      }]
    }],
    productCategories: [{ id: 'cat1', code: 'TAPIOCA', name: 'Tapioca', status: 'ACTIVE' }],
    productForms: [{ id: 'frm1', code: 'PELLET', name: 'Pellet', status: 'ACTIVE' }],
    specParameters: [{ id: 'par1', code: 'STARCH', name: 'Starch', dataType: 'NUMBER', defaultUnit: '%', status: 'ACTIVE', sortOrder: 1 }],
    productViewMode: 'CARDS',
    productFilters: { search: '', categoryId: 'ALL', status: 'ALL' },
    selectedSpecProductId: 'p1',
    pricingTab: 'STANDARD',
    standardPrices: [{ id: 'sp1', productId: 'p1', productName: 'Tapioca Hard Pellet 65%', productCode: 'THP65', fobPriceUsdMt: 245, effectiveDate: '2026-01-01', validUntil: '', status: 'ACTIVE' }],
    specialPrices: [],
    priceNotes: [],
    freightQuotes: [],
    pricingSalesFilter: 'ALL',
    realPos: [{
      po_id: 'PO-001',
      po_number: 'PO-2026-001',
      customer_po_no: 'CPO-889',
      customer_name: 'Nordic Feed Co',
      po_date: '2026-02-01',
      delivery_start_date: '2026-03-01',
      delivery_end_date: '2026-03-31',
      po_status: 'OPEN',
      total_contract_qty_mt: 500,
      main_product_name: 'Tapioca Hard Pellet 65%',
      active_revision_no: 1,
      draft_revision_no: null
    }],
    realPosLoaded: true,
    realPosLoading: false,
    poSearch: '',
    poStatusFilter: 'ALL',
    selectedPoId: null,
    selectedPoDetail: null,
    phase6ShippingLoaded: true,
    phase6ShippingLoading: false,
    phase6Search: '',
    phase6Filters: { diStatus: 'ALL', shipmentStatus: 'ALL', month: 'ALL', scheduleResult: 'ALL', paymentStatus: 'ALL' },
    deliveryInstructions: [{
      di_id: 'di1',
      di_no: 'DI-2026-001',
      di_status: 'CONFIRMED',
      shipment_id: 'sh1',
      shipment_status: 'BOOKED',
      customer_name: 'Nordic Feed Co',
      customer_po_no: 'CPO-889',
      product_summary: 'THP65 · 100 MT',
      packing_summary: '4 x 20FT',
      planned_loading_date: '2026-03-10',
      actual_loading_date: '',
      booking_no: 'BK12345',
      bl_no: 'BL9988',
      etd: '2026-03-15',
      eta: '2026-04-10',
      schedule_result: 'ON_PLAN',
      payment_status: 'UNPAID'
    }],
    phase6: {
      loaded: true,
      loading: false,
      error: null,
      items: [{
        di_id: 'di1',
        di_no: 'DI-2026-001',
        di_status: 'CONFIRMED',
        shipment_id: 'sh1',
        shipment_status: 'BOOKED',
        customer_name: 'Nordic Feed Co',
        customer_po_no: 'CPO-889',
        product_summary: 'THP65 · 100 MT',
        packing_summary: '4 x 20FT',
        planned_loading_date: '2026-03-10',
        actual_loading_date: '',
        booking_no: 'BK12345',
        bl_no: 'BL9988',
        etd: '2026-03-15',
        eta: '2026-04-10',
        schedule_result: 'ON_PLAN',
        payment_status: 'UNPAID'
      }],
      summary: { active_di: 1, draft_or_planning: 0, booked: 1, loaded: 0, docs_sent: 0, completed: 0 },
      filters: { search: '', diStatus: 'ALL', shipmentStatus: 'ALL', month: 'ALL', scheduleResult: 'ALL', paymentStatus: 'ALL' },
      selectedDiId: null,
      selectedDetail: null
    },
    shippingWorkspace: 'PHASE6',
    logisticsPartners: {
      loaded: true,
      loading: false,
      error: null,
      items: [{ partner_id: 'lp1', partner_code: 'FWD01', partner_name: 'Siam Freight', partner_type: 'FORWARDER', contact_name: 'Somchai', status: 'ACTIVE', active_rate_count: 2, usage_count: 3 }],
      filters: { search: '', partnerType: 'ALL', status: 'ALL' },
      selectedPartnerId: null,
      selectedDetail: null,
      activeDetailTab: 'PROFILE'
    },
    paymentsDashboard: {
      loaded: true,
      loading: false,
      error: null,
      activeTab: 'SHIPMENTS',
      summary: {
        total_shipments: 1,
        paid_count: 0,
        partial_count: 0,
        unpaid_count: 1,
        awaiting_final_invoice_count: 0,
        totals_by_currency: [{ currency: 'USD', shipment_count: 1, final_invoice_total: 24500, payment_total: 0, cash_received_total: 0, allocated_credit_total: 0, outstanding_total: 24500 }],
        customer_credits_summary: { total_remaining_amount: 0 }
      },
      items: [{
        shipment_id: 'sh1',
        di_id: 'di1',
        di_no: 'DI-2026-001',
        customer_name: 'Nordic Feed Co',
        customer_po_no: 'CPO-889',
        currency: 'USD',
        invoice_readiness: 'FINALIZED',
        final_invoice_nos: 'INV-2026-001',
        final_invoice_total: 24500,
        payment_total: 0,
        cash_received_amount: 0,
        allocated_credit_amount: 0,
        outstanding_balance: 24500,
        shipment_status: 'BOOKED',
        payment_status: 'UNPAID',
        commission_ready: false
      }],
      customerCredits: [],
      filters: { paymentStatus: 'ALL', invoiceReadiness: 'ALL', shipmentStatus: 'ALL', currency: 'ALL', customerId: 'ALL', search: '' }
    },
    commissionsDashboard: {
      loaded: true,
      loading: false,
      error: null,
      summary: { total_count: 1, pending_count: 0, payable_count: 1, paid_count: 0, pending_usd: 0, payable_usd: 500, paid_usd: 0, total_usd: 500 },
      items: [{
        shipment_id: 'sh1',
        di_id: 'di1',
        di_no: 'DI-2026-001',
        recipient_user_id: 'u-ext',
        recipient_name: 'Elena External',
        customer_name: 'Nordic Feed Co',
        customer_po_no: 'CPO-889',
        final_invoice_nos: 'INV-2026-001',
        actual_shipped_mt: 100,
        rate_usd_mt: 5,
        payment_status: 'PAID',
        commission_amount_usd: 500,
        status: 'PAYABLE'
      }],
      recipients: [{ user_id: 'u-ext', full_name: 'Elena External', payable_usd: 500, paid_usd: 0 }],
      filters: { status: 'ALL', recipientUserId: 'ALL', customerId: 'ALL', paidDateFrom: '', paidDateTo: '', search: '' }
    },
    dashboardSummary: {
      loaded: true,
      loading: false,
      error: null,
      data: {
        role: 'ADMIN',
        kpis: { active_users: 5, inactive_users: 0, total_customers: 3, active_products: 2, active_logistics_partners: 4, payable_commissions_count: 1 },
        team_overview: {
          active_pos: { active_po_count: 1, total_contract_mt: 500, product_breakdown: [{ product_code: 'THP65', product_name: 'Tapioca Hard Pellet 65%', contract_mt: 500 }] },
          fulfillment: { total_contract_mt: 500, actual_shipped_mt: 100, remaining_contract_mt: 400, shipped_pct: 20 },
          this_month: { month: '2026-03', total_mt: 200, container_count: 8, shipment_count: 2, shipped_or_loaded_count: 1 },
          next_month: { month: '2026-04', total_mt: 100, container_count: 4, shipment_count: 1 },
          upcoming_milestones: [{ di_id: 'di1', di_no: 'DI-2026-001', customer_name: 'Nordic Feed Co', planned_loading_date: '2026-03-10', etd: '2026-03-15', shipment_status: 'BOOKED' }]
        },
        health: [
          { key: 'CUSTOMER_OWNER', label: 'Customers without Sales Owner', count: 1, view: 'customers' },
          { key: 'UNPAID_SHIPMENTS', label: 'Unpaid Shipments', count: 2, view: 'payments' }
        ],
        role_breakdown: [{ role: 'ADMIN', active_count: 1, total_count: 1 }]
      }
    },
    calendarYear: 2026,
    calendarMonth: 3,
    calendarView: 'MONTH',
    calendarAnchorDate: '2026-03-10',
    calendarFilters: { customerId: 'ALL', salesOwnerId: 'ALL', productId: 'ALL', eventType: 'ALL', status: 'ALL' },
    operationsCalendar: {
      lastRequestKey: 'ADMIN|from=2026-03-01&to=2026-03-31',
      loading: false,
      error: null,
      events: [{
        event_id: 'ev1',
        event_type: 'LOADING_PLANNED',
        event_date: '2026-03-10',
        di_id: 'di1',
        di_no: 'DI-2026-001',
        customer_name: 'Nordic Feed Co',
        container_plan: '4 x 20FT',
        planned_loading_date: '2026-03-10',
        shipment_status: 'BOOKED',
        can_reschedule: true
      }],
      dailyLoadingSummary: []
    },
    ...(options.stateOverrides || {})
  };

  const navMatch = html.match(/const navConfig = \[[\s\S]*?\];/);
  assert.ok(navMatch, 'navConfig must exist');
  const navSectionMatch = html.match(/const navSectionOrder = \[[\s\S]*?\];/);
  assert.ok(navSectionMatch, 'navSectionOrder must exist');

  const roleOrderMatch = html.match(/const CALENDAR_EVENT_TYPES = \{[\s\S]*?\};/);
  assert.ok(roleOrderMatch, 'CALENDAR_EVENT_TYPES must exist');

  const code = `
    ${extractI18nCore()}
    ${navMatch[0]}
    ${navSectionMatch[0]}
    ${roleOrderMatch[0]}
    const CALENDAR_WAREHOUSE_TYPES = ['LOADING_PLANNED', 'LOADING_ACTUAL'];
    function openModal(h) { __setModal(h); }
    function closeModal() { __setModal(''); }
    function getScopedCustomers() { return state.customers || []; }
    function canEditPayment() { return ['ADMIN', 'MANAGER', 'EXPORT'].includes(state.currentUser?.role); }
    function canViewPaymentDetail() { return state.currentUser?.role !== 'EXTERNAL_SALES'; }
    function canSettleCommission() { return ['ADMIN', 'MANAGER'].includes(state.currentUser?.role); }
    function canManageLogisticsPartners() { return ['ADMIN', 'MANAGER', 'EXPORT'].includes(state.currentUser?.role); }
    function canManagePricing() { return ['ADMIN', 'MANAGER'].includes(state.currentUser?.role); }
    function canManagePO() { return ['ADMIN', 'MANAGER', 'SALES_SUPPORT'].includes(state.currentUser?.role); }
    function canWritePO() { return ['ADMIN', 'MANAGER', 'SALES_SUPPORT'].includes(state.currentUser?.role); }
    function escapeDashboardHtml(v) { return escapePaymentHtml(v); }
    function canCreatePhase6DeliveryInstruction() { return ['ADMIN', 'MANAGER', 'SALES_SUPPORT', 'EXPORT'].includes(state.currentUser?.role); }
    function canSearchPhase6Workspace() { return true; }
    function canFilterPhase6Schedule() { return true; }
    function canFilterPhase6Payment() { return true; }
    function canViewLegacyShipping() { return false; }
    function canEditPhase6Shipping() { return ['ADMIN', 'MANAGER', 'EXPORT'].includes(state.currentUser?.role); }
    function escapePhase6Text(v) { return escapePaymentHtml(v); }
    function escapeLogisticsPartnerHtml(v) { return escapePaymentHtml(v); }
    function renderDashboardAction(label, onClick) { return '<button onclick="' + onClick + '">' + label + '</button>'; }
    function getPhase6WorkspaceSummary(items) { return state.phase6.summary; }
    function getPhase6FilterMonthOptions() { return ['2026-03']; }
    function filterPhase6DeliveryInstructions(items) { return items || []; }
    function formatMt(v) { return Number(v || 0).toFixed(1) + ' MT'; }
    function formatNum(v) { return Number(v || 0).toLocaleString(); }
    function escapeHtml(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function loadPaymentsDashboardFromApi() {}
    function loadCommissionsDashboardFromApi() {}
    function loadOperationsCalendarFromApi() {}
    function loadDashboardSummaryFromApi() {}
    function loadRealPOsFromApi() {}
    function loadPhase6DeliveryInstructionsFromApi() {}
    function loadDeliveryInstructionsFromApi() { return Promise.resolve(); }
    function loadPhase6ServicePartnersFromApi() { return Promise.resolve(); }
    function bindPhase6WorkspaceActions() {}
    function loadLogisticsPartnersFromApi() {}
    function ensureResponsiveTables() {}
    function getTodayIso() { return '2026-03-10'; }
    function escapePaymentHtml(v) { return String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function escapeCommissionHtml(v) { return escapePaymentHtml(v); }
    function escapeCalendarHtml(v) { return escapePaymentHtml(v); }
    function escapeLogisticsHtml(v) { return escapePaymentHtml(v); }
    function escapePhase6Html(v) { return escapePaymentHtml(v); }
    function formatMoney(v, cur = 'USD') { return cur + ' ' + Number(v || 0).toFixed(2); }
    function paymentStatusBadge(s) { return '<span>' + String(s || 'UNPAID') + '</span>'; }
    function commissionStatusBadge(s) { return '<span>' + String(s || 'PENDING') + '</span>'; }
    function phase6StatusBadge(s) { return '<span>' + String(s || '-') + '</span>'; }
    function calendarToneClasses() { return ''; }
    function calendarLoadingSummaryForDate() { return null; }
    function renderCalendarDailySummaryBadge() { return ''; }
    function calendarEventDisplay(e) { return { primary: e.di_no || 'Event', secondary: e.customer_name || '', badge: 'PLAN' }; }
    function calendarEventStatusValue(e) { return e.shipment_status || ''; }
    function calendarStatusBadge(s) { return s ? '<span>' + s + '</span>' : ''; }
    function calendarEventAllowedForRole(type) { return state.currentUser?.role === 'PRODUCTION_WAREHOUSE' ? CALENDAR_WAREHOUSE_TYPES.includes(type) : true; }
    function calendarIso(y, m, d) { return y + '-' + String(m).padStart(2,'0') + '-' + String(d).padStart(2,'0'); }
    function calendarVisibleRange() { return { from: '2026-03-01', to: '2026-03-31' }; }
    function renderCalendarEventChip(e) { return '<div>' + (e.di_no || '') + '</div>'; }
    function renderCalendarEventCard(e) { return '<div>' + (e.di_no || '') + '</div>'; }
    function getPriceNoteOwnerName() { return 'Admin One'; }
    function pricingStatusBadge(s) { return '<span>' + s + '</span>'; }
    function renderSidebar() { __onRenderSidebar(); }
    function renderView() { __onRenderView(); }
    ${extraSources.join('\n\n')}
    return {
      I18N,
      UI_LANG_STORAGE_KEY,
      normalizeUiLanguage,
      getUiLanguage,
      t,
      translateRole,
      translateStatus,
      applyStaticShellTranslations,
      setUiLanguage,
      ${options.exports ? options.exports.join(', ') : ''}
    };
  `;

  const lucide = { createIcons: () => {} };
  const windowObj = { lucide };
  const navigatorObj = {
    clipboard: {
      writeText: async (txt) => { lastCopiedText = txt; }
    }
  };

  const fn = new Function(
    'state', 'document', 'localStorage', 'lucide', 'window', 'navigator',
    '__setModal', '__onRenderSidebar', '__onRenderView',
    code
  );

  const api = fn(
    state, document, localStorage, lucide, windowObj, navigatorObj,
    (h) => { lastModalHtml = h; },
    () => { renderSidebarCount++; },
    () => { renderViewCount++; }
  );

  return {
    api,
    state,
    storage,
    document,
    byId,
    i18nNodes,
    placeholderNodes,
    ariaNodes,
    langButtons,
    getModalHtml: () => lastModalHtml,
    getRenderCounts: () => ({ sidebar: renderSidebarCount, view: renderViewCount }),
    getCopiedText: () => lastCopiedText
  };
}

test('I18N dictionary has 100% TH/EN key & placeholder parity and covers all static keys in index.html', () => {
  const { api } = createI18nHarness();
  const thKeys = Object.keys(api.I18N.TH);
  const enKeys = Object.keys(api.I18N.EN);
  assert.ok(thKeys.length >= 1000, `Expected comprehensive dictionary (>=1000 keys), got ${thKeys.length}`);
  assert.deepEqual(new Set(thKeys), new Set(enKeys), 'I18N.TH and I18N.EN must have identical key sets');

  for (const key of thKeys) {
    assert.ok(String(api.I18N.TH[key]).trim().length > 0, `Empty TH value for ${key}`);
    if (!key.endsWith('Hint')) {
      assert.ok(String(api.I18N.EN[key]).trim().length > 0, `Empty EN value for ${key}`);
    }
    const thParams = [...String(api.I18N.TH[key]).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    const enParams = [...String(api.I18N.EN[key]).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
    assert.deepEqual(thParams, enParams, `Placeholder mismatch for key ${key}`);
  }

  // Verify every static t('...'), tr('...'), and data-i18n*="..." key in index.html exists in both TH and EN
  const usedKeys = new Set();
  for (const m of html.matchAll(/(?:\btr|\bt)\(\s*'([a-zA-Z0-9_.-]+)'/g)) {
    if (!m[1].endsWith('.')) usedKeys.add(m[1]);
  }
  for (const m of html.matchAll(/data-i18n(?:-[a-z-]+)?="([a-zA-Z0-9_.-]+)"/g)) {
    usedKeys.add(m[1]);
  }
  for (const key of usedKeys) {
    assert.ok(Object.hasOwn(api.I18N.TH, key), `Missing TH key: ${key}`);
    assert.ok(Object.hasOwn(api.I18N.EN, key), `Missing EN key: ${key}`);
  }
});

test('TH | EN toggle pill exists in Login card and Top Header with mobile responsive CSS and preserved DOM IDs', () => {
  assert.match(html, /id="loginLangToggle"[\s\S]*?onclick="setUiLanguage\('TH'\)"[\s\S]*?onclick="setUiLanguage\('EN'\)"/);
  assert.match(html, /id="headerLangToggle"[\s\S]*?onclick="setUiLanguage\('TH'\)"[\s\S]*?onclick="setUiLanguage\('EN'\)"/);
  assert.match(html, /id="headerChangePasswordBtn"/);
  assert.match(html, /id="headerSignOutBtn"/);
  assert.match(html, /\.lang-toggle-pill/);
  assert.match(html, /@media \(max-width: 640px\)[\s\S]*?\.lang-toggle-btn/);
});

test('localStorage persistence (wcat_ui_lang), default TH, and instant re-render preserve view, filters, and session', () => {
  // Default to TH when empty
  const h1 = createI18nHarness();
  assert.equal(h1.api.UI_LANG_STORAGE_KEY, 'wcat_ui_lang');
  assert.equal(h1.api.getUiLanguage(), 'TH');
  assert.equal(h1.api.normalizeUiLanguage('invalid'), 'TH');
  assert.equal(h1.api.normalizeUiLanguage('en'), 'EN');

  // Set custom view & active filters before switching
  h1.state.currentView = 'products';
  h1.state.productFilters = { search: 'starch', categoryId: 'cat1', status: 'ACTIVE' };
  const originalUser = h1.state.currentUser;

  // Switch TH -> EN
  h1.api.setUiLanguage('EN');
  assert.equal(h1.state.currentLang, 'EN');
  assert.equal(h1.storage.get('wcat_ui_lang'), 'EN');
  assert.equal(h1.document.documentElement.lang, 'en');
  assert.equal(h1.i18nNodes[2].textContent, 'Sign in');
  assert.equal(h1.i18nNodes[3].textContent, 'Change Password');
  assert.equal(h1.i18nNodes[4].textContent, 'Sign Out');
  assert.equal(h1.placeholderNodes[0].getAttribute('placeholder'), 'name@company.com');
  assert.equal(h1.langButtons[1].getAttribute('aria-pressed'), 'true');
  assert.equal(h1.langButtons[0].getAttribute('aria-pressed'), 'false');

  // Must preserve view, filters, and session AND trigger instant re-render
  assert.equal(h1.state.currentView, 'products');
  assert.deepEqual(h1.state.productFilters, { search: 'starch', categoryId: 'cat1', status: 'ACTIVE' });
  assert.equal(h1.state.currentUser, originalUser);
  assert.equal(h1.getRenderCounts().sidebar, 1);
  assert.equal(h1.getRenderCounts().view, 1);

  // Switch EN -> TH
  h1.api.setUiLanguage('TH');
  assert.equal(h1.storage.get('wcat_ui_lang'), 'TH');
  assert.equal(h1.document.documentElement.lang, 'th');
  assert.equal(h1.i18nNodes[2].textContent, 'เข้าสู่ระบบ');
  assert.equal(h1.i18nNodes[4].textContent, 'ออกจากระบบ');
  assert.equal(h1.getRenderCounts().sidebar, 2);
  assert.equal(h1.getRenderCounts().view, 2);
});

test('Login & Change Password modal translate cleanly between TH and EN', () => {
  const h = createI18nHarness(
    [extractFunction('openChangePasswordModal')],
    { exports: ['openChangePasswordModal'] }
  );

  h.api.setUiLanguage('TH');
  h.api.openChangePasswordModal(false);
  assert.match(h.getModalHtml(), /เปลี่ยนรหัสผ่าน/);
  assert.match(h.getModalHtml(), /รหัสผ่านปัจจุบัน/);

  h.api.setUiLanguage('EN');
  h.api.openChangePasswordModal(false);
  assert.match(h.getModalHtml(), /Change Password/);
  assert.match(h.getModalHtml(), /Current Password/);
  assert.match(h.getModalHtml(), /Save Password/);
});

test('Sidebar Navigation translates sections/items and preserves RBAC visibility in both TH and EN', () => {
  const h = createI18nHarness(
    [extractFunction('getRoleNavLabel'), extractFunction('renderSidebar')],
    { exports: ['renderSidebar'] }
  );

  // EXTERNAL_SALES in TH and EN
  h.state.currentUser = { id: 'u-ext', name: 'Elena', role: 'EXTERNAL_SALES' };
  h.api.setUiLanguage('TH');
  h.api.renderSidebar();
  const extTh = h.byId.get('sidebarNav').innerHTML;
  assert.match(extTh, /ยอดขายของฉัน/);
  assert.match(extTh, /คอมมิชชั่นของฉัน/);
  assert.doesNotMatch(extTh, /changeView\('users'\)/);
  assert.doesNotMatch(extTh, /changeView\('logistics_partners'\)/);

  h.api.setUiLanguage('EN');
  h.api.renderSidebar();
  const extEn = h.byId.get('sidebarNav').innerHTML;
  assert.match(extEn, /My Sales/);
  assert.match(extEn, /My Customers/);
  assert.match(extEn, /My Commission/);
  assert.doesNotMatch(extEn, /changeView\('users'\)/);
  assert.doesNotMatch(extEn, /changeView\('logistics_partners'\)/);

  // PRODUCTION_WAREHOUSE keeps strict 3-item RBAC menu in EN
  h.state.currentUser = { id: 'u-wh', name: 'Somkid', role: 'PRODUCTION_WAREHOUSE' };
  h.api.renderSidebar();
  const whEn = h.byId.get('sidebarNav').innerHTML;
  assert.match(whEn, /Production Plan/);
  assert.match(whEn, /Loading Calendar/);
  assert.doesNotMatch(whEn, /changeView\('pricing'\)/);
  assert.doesNotMatch(whEn, /changeView\('payments'\)/);
});

test('Dashboard & Admin Data Health alerts switch cleanly between TH and EN', () => {
  const h = createI18nHarness(
    [
      extractFunction('renderDashboardCard'),
      extractFunction('renderDashboardHeader'),
      extractFunction('renderDashboard')
    ],
    { exports: ['renderDashboard'] }
  );
  const container = createMockElement('div');

  h.api.setUiLanguage('TH');
  h.api.renderDashboard(container);
  assert.match(container.innerHTML, /ศูนย์บริหารจัดการระบบ/);
  assert.match(container.innerHTML, /ภาพรวมทีม WCAT/);
  assert.match(container.innerHTML, /ลูกค้าแบบ Assigned Sales ที่ยังไม่มีผู้ดูแลใช้งานอยู่/);

  h.api.setUiLanguage('EN');
  h.api.renderDashboard(container);
  assert.match(container.innerHTML, /System Administration/);
  assert.match(container.innerHTML, /WCAT Team Overview/);
  assert.match(container.innerHTML, /Assigned Customers without Active Owner/);
  assert.match(container.innerHTML, /Shipments Pending Payment Follow-up/);
});

test('Product & Spec Master (Cards / List / Spec Sheet + Copy Spec output) switches cleanly between TH and EN', async () => {
  const h = createI18nHarness(
    [
      extractFunction('buildProductSpecSummaryText'),
      extractFunction('copyProductSpecSummary'),
      extractFunction('renderProductSpecSheet'),
      extractFunction('renderProducts')
    ],
    { exports: ['buildProductSpecSummaryText', 'copyProductSpecSummary', 'renderProducts'] }
  );
  const container = createMockElement('div');

  // TH Cards + Copy Spec
  h.api.setUiLanguage('TH');
  h.state.productViewMode = 'CARDS';
  h.api.renderProducts(container);
  assert.match(container.innerHTML, /สินค้า & ข้อกำหนดคุณภาพ/);
  assert.match(container.innerHTML, /แสดง 1 \/ 1 รายการ/);

  const thCopy = await h.api.copyProductSpecSummary('p1');
  assert.match(thCopy, /^\[THP65\] Tapioca Hard Pellet 65% \(THP65\)/);
  assert.match(thCopy, /หมวดหมู่: Tapioca \| รูปแบบ: Pellet \| พิกัด HS: 0714\.10/);
  assert.match(thCopy, /สเปกมาตรฐาน \(Standard Specifications\):/);
  assert.match(thCopy, /1\. Starch \(STARCH\): ≥ 65% \[FEED_GRADE\]/);

  // EN Cards + List + Spec Sheet + Copy Spec
  h.api.setUiLanguage('EN');
  h.state.productViewMode = 'CARDS';
  h.api.renderProducts(container);
  assert.match(container.innerHTML, /Product & Spec Master/);
  assert.match(container.innerHTML, /Showing 1 \/ 1 items/);
  assert.match(container.innerHTML, /View Spec/);

  h.state.productViewMode = 'LIST';
  h.api.renderProducts(container);
  assert.match(container.innerHTML, /Category & Form \(HS\)/);
  assert.match(container.innerHTML, /Standard Specs/);

  h.state.productViewMode = 'SPEC_SHEET';
  h.api.renderProducts(container);
  assert.match(container.innerHTML, /Copy Spec/);
  assert.match(container.innerHTML, /Standard Specification/);
  assert.match(container.innerHTML, /1 parameters/);

  const enCopy = await h.api.copyProductSpecSummary('p1');
  assert.match(enCopy, /^\[THP65\] Tapioca Hard Pellet 65% \(THP65\)/);
  assert.match(enCopy, /Category: Tapioca \| Form: Pellet \| HS Code: 0714\.10 \| Unit: MT \| Status: ACTIVE/);
  assert.match(enCopy, /Applications: FEED_GRADE/);
  assert.match(enCopy, /Standard Specifications:\n1\. Starch \(STARCH\): ≥ 65% \[FEED_GRADE\]/);
  assert.equal(h.getCopiedText(), enCopy);
});

test('Pricing, PO Management, Shipping / DI, Calendar, Logistics Partners, Payments, and Commission switch cleanly TH ↔ EN', () => {
  const h = createI18nHarness(
    [
      extractFunction('escapePricingHtml'),
      extractFunction('pricingProductSubtitle'),
      extractFunction('renderPricingProduct'),
      extractFunction('getPoProductSummary'),
      extractFunction('renderPricing'),
      extractFunction('renderRealPOListTable'),
      extractFunction('renderPOEngine'),
      extractFunction('renderPhase6DeliveryInstructionList'),
      extractFunction('renderShippingDiWorkspace'),
      extractFunction('renderShipping'),
      extractFunction('calendarMonthLabel'),
      extractFunction('renderCalendarFilters'),
      extractFunction('renderOperationsMonth'),
      extractFunction('renderOperationsWeek'),
      extractFunction('renderOperationsAgenda'),
      extractFunction('renderCalendarLegend'),
      extractFunction('renderCalendar'),
      extractFunction('renderLogisticsPartners'),
      extractFunction('renderPayments'),
      extractFunction('renderCommissions')
    ],
    {
      exports: [
        'renderPricing',
        'renderPOEngine',
        'renderShipping',
        'renderCalendar',
        'renderLogisticsPartners',
        'renderPayments',
        'renderCommissions'
      ]
    }
  );
  const container = createMockElement('div');

  // Pricing TH vs EN
  h.api.setUiLanguage('TH');
  h.api.renderPricing(container);
  assert.match(container.innerHTML, /ราคามาตรฐาน/);
  assert.match(container.innerHTML, /บันทึกแจ้งราคาผู้บริหาร/);
  h.api.setUiLanguage('EN');
  h.api.renderPricing(container);
  assert.match(container.innerHTML, />Pricing</);
  assert.match(container.innerHTML, /Standard Prices/);
  assert.match(container.innerHTML, /Manager Price Notes/);
  assert.match(container.innerHTML, /Freight Quotes/);

  // PO Management TH vs EN
  h.api.setUiLanguage('TH');
  h.api.renderPOEngine(container);
  assert.match(container.innerHTML, /สร้าง PO ใหม่/);
  h.api.setUiLanguage('EN');
  h.api.renderPOEngine(container);
  assert.match(container.innerHTML, /PO Management/);
  assert.match(container.innerHTML, /New PO/);
  assert.match(container.innerHTML, /Total \(MT\)/);

  // Shipping / DI TH vs EN (keeps BL No., ETD, ETA, DI)
  h.api.setUiLanguage('TH');
  h.api.renderShipping(container);
  assert.match(container.innerHTML, /สร้าง DI ใหม่/);
  assert.match(container.innerHTML, /Booking \/ BL No\./);
  h.api.setUiLanguage('EN');
  h.api.renderShipping(container);
  assert.match(container.innerHTML, /DI \/ Shipment List/);
  assert.match(container.innerHTML, /Create DI/);
  assert.match(container.innerHTML, /Booking \/ BL No\./);

  // Operations Calendar TH vs EN
  h.api.setUiLanguage('TH');
  h.api.renderCalendar(container);
  assert.match(container.innerHTML, /ปฏิทินปฏิบัติการ/);
  assert.match(container.innerHTML, /วันโหลดตามแผน/);
  h.api.setUiLanguage('EN');
  h.api.renderCalendar(container);
  assert.match(container.innerHTML, /Operations Calendar/);
  assert.match(container.innerHTML, /Planned Loading/);
  assert.match(container.innerHTML, /ETD \(Vessel\)/);

  // Logistics Partners TH vs EN
  h.api.setUiLanguage('TH');
  h.api.renderLogisticsPartners(container);
  assert.match(container.innerHTML, /พาร์ทเนอร์ขนส่ง/);
  assert.match(container.innerHTML, /\+ เพิ่มพาร์ทเนอร์/);
  h.api.setUiLanguage('EN');
  h.api.renderLogisticsPartners(container);
  assert.match(container.innerHTML, /Logistics Partners/);
  assert.match(container.innerHTML, /\+ Add Partner/);

  // Payment Status TH vs EN (also verifies currency totals map does not shadow t())
  h.api.setUiLanguage('TH');
  h.api.renderPayments(container);
  assert.match(container.innerHTML, /สถานะการรับชำระเงิน/);
  assert.match(container.innerHTML, /ยอดรวม USD/);
  assert.match(container.innerHTML, /บันทึกการรับชำระ/);
  h.api.setUiLanguage('EN');
  h.api.renderPayments(container);
  assert.match(container.innerHTML, /Payment Status/);
  assert.match(container.innerHTML, /USD Totals \(1 shipments\)/);
  assert.match(container.innerHTML, /Record Payment/);

  // Commission TH vs EN
  h.api.setUiLanguage('TH');
  h.api.renderCommissions(container);
  assert.match(container.innerHTML, /ระบบคำนวณและจ่ายคอมมิชชั่น/);
  assert.match(container.innerHTML, /บันทึกจ่าย/);
  h.api.setUiLanguage('EN');
  h.api.renderCommissions(container);
  assert.match(container.innerHTML, /Commission Settlement/);
  assert.match(container.innerHTML, /Settle \/ Pay/);
});
