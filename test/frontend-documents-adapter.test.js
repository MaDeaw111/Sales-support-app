import {semanticBadges} from './semantic-badge-fixture.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
Object.assign(globalThis,semanticBadges);

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
  assert.ok(start >= 0 && end > start, 'I18N core block must exist');
  return html.slice(start, end);
}

function extractDocumentsModule() {
  const start = html.indexOf('// --- DOCUMENT ATTACHMENTS (R2) & 30-DAY PAYMENT COUNTDOWN ---');
  const end = html.indexOf('// --- UTILS & MODAL ---');
  assert.ok(start >= 0 && end > start, 'Document attachments module must exist before UTILS & MODAL');
  return html.slice(start, end);
}

function createHarness(options = {}) {
  const storage = new Map(Object.entries({ wcat_ui_lang: options.lang || 'TH' }));
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  const elements = new Map();
  const document = {
    documentElement: { lang: 'th' },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => []
  };
  const state = {
    role: options.role || 'ADMIN',
    currentUser: { user_id: options.userId || 'U_ADMIN', role: options.role || 'ADMIN' },
    documentAttachmentsCache: {},
    deliveryInstructions: [],
    selectedPhase6DeliveryInstructionId: null,
    phase6ShipmentDetail: null,
    phase6Search: '',
    phase6Filters: { diStatus: 'ALL', shipmentStatus: 'ALL', shippingMonth: 'ALL', scheduleResult: 'ALL', paymentStatus: 'ALL' },
    customers: [],
    servicePartners: [],
    payments: [],
    poDetails: {},
    ...options.state
  };
  const toasts = [];
  let renderCount = 0;

  const extraFns = (options.extractFunctions || []).map(extractFunction).join('\n\n');
  const source = `
    ${extractI18nCore()}
    function tr(key, fallback, params) {
      const val = t(key, params);
      return val === key ? (fallback || key) : val;
    }
    ${extractDocumentsModule()}
    ${extraFns}
    return {
      t, tr, getUiLanguage, setUiLanguage,
      computePaymentCountdown30,
      renderPaymentCountdownBadge,
      canUiUploadDocument,
      loadDocumentsForEntity,
      uploadDocumentsForEntity,
      deleteDocumentAttachment,
      renderDocumentCategoryBlock,
      renderShipmentCustomerDocsSection,
      renderShipmentInternalDiDocsSection,
      renderPoAttachmentsSection,
      renderPaymentSlipSection,
      ${(options.extractFunctions || []).join(', ')}
    };
  `;

  const factory = new Function(
    'window', 'document', 'localStorage', 'state', 'fetch', 'showToast', 'renderView', 'openModal', 'closeModal',
    'confirm', 'alert', 'loadPaymentsDashboardFromApi', 'loadDeliveryInstructionsFromApi',
    source
  );

  const api = factory(
    {},
    document,
    localStorage,
    state,
    options.fetch || (async () => ({ ok: true, json: async () => ({ status: 'SUCCESS', data: { documents: [] } }) })),
    (msg) => toasts.push(msg),
    () => { renderCount++; },
    () => {},
    () => {},
    () => true,
    (msg) => toasts.push(msg),
    async () => {},
    async () => {}
  );

  return {
    api,
    state,
    toasts,
    elements,
    getRenderCount: () => renderCount
  };
}

test('computePaymentCountdown30 and renderPaymentCountdownBadge handle all states in TH and EN', () => {
  const { api } = createHarness({ lang: 'EN' });
  const now = '2026-11-20T12:00:00.000Z';

  // 1) Waiting when no All Ship Doc uploaded yet
  const waiting = api.computePaymentCountdown30(null, 'UNPAID', 0, now);
  assert.equal(waiting.state, 'WAITING');
  assert.match(api.renderPaymentCountdownBadge(null, 'UNPAID', 0, now), /Starts once All Ship Doc is uploaded/);

  // 2) Active within 30 days (uploaded 10 days ago -> 20 days left)
  const active = api.computePaymentCountdown30('2026-11-10T12:00:00.000Z', 'UNPAID', 0, now);
  assert.equal(active.state, 'ACTIVE');
  assert.equal(active.daysRemaining, 20);
  assert.match(api.renderPaymentCountdownBadge('2026-11-10T12:00:00.000Z', 'UNPAID', 0, now), /20 days left/);

  // 3) Due today (uploaded exactly 30 days ago)
  const dueToday = api.computePaymentCountdown30('2026-10-21T12:00:00.000Z', 'PARTIAL', 0, now);
  assert.equal(dueToday.state, 'DUE_TODAY');
  assert.match(api.renderPaymentCountdownBadge('2026-10-21T12:00:00.000Z', 'PARTIAL', 0, now), /Due today/);

  // 4) Overdue (uploaded 35 days ago -> 5 days overdue)
  const overdue = api.computePaymentCountdown30('2026-10-16T12:00:00.000Z', 'UNPAID', 0, now);
  assert.equal(overdue.state, 'OVERDUE');
  assert.equal(overdue.overdueDays, 5);
  assert.match(api.renderPaymentCountdownBadge('2026-10-16T12:00:00.000Z', 'UNPAID', 0, now), /Overdue by 5 days/);

  // 5) Cleared when PAID or when Payment Slip is attached
  assert.equal(api.computePaymentCountdown30('2026-10-01T00:00:00.000Z', 'PAID', 0, now).state, 'CLEARED');
  assert.equal(api.computePaymentCountdown30('2026-10-01T00:00:00.000Z', 'UNPAID', 1, now).state, 'CLEARED');
  assert.match(api.renderPaymentCountdownBadge('2026-10-01T00:00:00.000Z', 'PAID', 0, now), /Cleared/);

  // Switch to Thai and verify Thai copy
  api.setUiLanguage('TH');
  assert.match(api.renderPaymentCountdownBadge('2026-10-16T12:00:00.000Z', 'UNPAID', 0, now), /เกินกำหนด 5 วัน/);
  assert.match(api.renderPaymentCountdownBadge('2026-10-16T12:00:00.000Z', 'PAID', 0, now), /ชำระแล้ว \/ แนบสลิปเรียบร้อย/);
});

test('Shipment Customer Post-Loading Docs and Internal DI sections enforce role visibility and preview/download links', () => {
  const sampleDocs = [
    { id: 'D-STF', entity_type: 'SHIPMENT', entity_id: 'SHP-1', doc_category: 'STUFFING_REPORT', file_name: 'stuffing.pdf', content_type: 'application/pdf', file_size: 204800, uploaded_by: 'U_EXPORT', uploaded_by_name: 'Export Staff', uploaded_at: '2026-11-12T10:00:00.000Z', can_delete: false },
    { id: 'D-ALL', entity_type: 'SHIPMENT', entity_id: 'SHP-1', doc_category: 'ALL_SHIP_DOC', file_name: 'all_ship_docs.pdf', content_type: 'application/pdf', file_size: 512000, uploaded_by: 'U_EXPORT', uploaded_by_name: 'Export Staff', uploaded_at: '2026-11-13T10:00:00.000Z', can_delete: false },
    { id: 'D-DI', entity_type: 'SHIPMENT', entity_id: 'SHP-1', doc_category: 'DI', file_name: 'internal_di.pdf', content_type: 'application/pdf', file_size: 102400, uploaded_by: 'U_EXPORT', uploaded_by_name: 'Export Staff', uploaded_at: '2026-11-11T10:00:00.000Z', can_delete: true }
  ];

  // 1) EXTERNAL_SALES sees Customer Post-Loading Docs with Preview + Download, NO Upload/Delete, NO Internal DI
  const salesHarness = createHarness({
    role: 'EXTERNAL_SALES',
    lang: 'EN',
    state: {
      documentAttachmentsCache: {
        'SHIPMENT:REF-1': { loaded: true, loading: false, error: null, documents: sampleDocs }
      }
    }
  });
  const salesCustomerHtml = salesHarness.api.renderShipmentCustomerDocsSection('REF-1');
  assert.match(salesCustomerHtml, /Customer Post-Loading Documents/);
  assert.match(salesCustomerHtml, /Docs Ready \(2\)/);
  assert.match(salesCustomerHtml, /stuffing\.pdf/);
  assert.match(salesCustomerHtml, /all_ship_docs\.pdf/);
  assert.match(salesCustomerHtml, /\/api\/documents\/D-STF\/download/);
  assert.match(salesCustomerHtml, /\/api\/documents\/D-ALL\/download\?download=1/);
  assert.doesNotMatch(salesCustomerHtml, /Upload File/);
  assert.doesNotMatch(salesCustomerHtml, /deleteDocumentAttachment/);
  assert.equal(salesHarness.api.renderShipmentInternalDiDocsSection('REF-1'), '');

  // 2) PRODUCTION_WAREHOUSE sees ONLY Internal DI (no Upload, no Customer Post-Loading Docs)
  const whHarness = createHarness({
    role: 'PRODUCTION_WAREHOUSE',
    lang: 'EN',
    state: {
      documentAttachmentsCache: {
        'SHIPMENT:REF-2': { loaded: true, loading: false, error: null, documents: sampleDocs }
      }
    }
  });
  assert.equal(whHarness.api.renderShipmentCustomerDocsSection('REF-2'), '');
  const whDiHtml = whHarness.api.renderShipmentInternalDiDocsSection('REF-2');
  assert.match(whDiHtml, /Internal DI Attachments/);
  assert.match(whDiHtml, /internal_di\.pdf/);
  assert.doesNotMatch(whDiHtml, /Upload File/);

  // 3) EXPORT sees both Customer Post-Loading Docs AND Internal DI with Upload buttons
  const expHarness = createHarness({
    role: 'EXPORT',
    lang: 'EN',
    state: {
      documentAttachmentsCache: {
        'SHIPMENT:SHP-1': { loaded: true, loading: false, error: null, documents: sampleDocs }
      }
    }
  });
  const expCustomerHtml = expHarness.api.renderShipmentCustomerDocsSection('SHP-1');
  const expDiHtml = expHarness.api.renderShipmentInternalDiDocsSection('SHP-1');
  assert.match(expCustomerHtml, /Upload File/);
  assert.match(expDiHtml, /Upload File/);
  assert.match(expDiHtml, /internal_di\.pdf/);
});

test('renderPhase6DeliveryInstructionList displays Docs Ready badge for ADMIN and EXTERNAL_SALES, hides for PRODUCTION_WAREHOUSE', () => {
  const row = {
    di_id: 'DI-1',
    detail_ref: 'REF-1',
    di_no: 'DI-001',
    customer_name: 'Acme Co',
    customer_po_no: 'PO-1',
    shipment_status: 'DOCS_SENT',
    di_status: 'IN_PROGRESS',
    shipping_month: '2026-11',
    shipping_period: 'FIRST_HALF',
    planned_qty_mt: 20,
    customer_docs_count: 2,
    stuffing_report_count: 1,
    all_ship_doc_count: 1
  };

  for (const [role, expectBadge] of [['ADMIN', true], ['EXTERNAL_SALES', true], ['PRODUCTION_WAREHOUSE', false]]) {
    const h = createHarness({
      role,
      lang: 'EN',
      extractFunctions: [
        'isRestrictedPhase6Role',
        'canEditPhase6Shipping',
        'canSearchPhase6Workspace',
        'canFilterPhase6Schedule',
        'canFilterPhase6Payment',
        'escapePhase6Text',
        'getStatusBadgeClass',
        'phase6StatusBadge',
        'renderPhase6DeliveryInstructionList'
      ],
      state: { deliveryInstructions: [row] }
    });
    const listHtml = h.api.renderPhase6DeliveryInstructionList();
    if (expectBadge) {
      assert.match(listHtml, /Docs Ready \(2\)/, `${role} should see Docs Ready badge`);
    } else {
      assert.doesNotMatch(listHtml, /Docs Ready/, `${role} must not see Docs Ready badge`);
    }
  }
});

test('PO attachments and Payment Slip + 30-Day countdown sections render cleanly in TH and EN', () => {
  const h = createHarness({
    role: 'SALES_SUPPORT',
    lang: 'EN',
    state: {
      documentAttachmentsCache: {
        'PO:PO1': {
          loaded: true,
          loading: false,
          error: null,
          documents: [{ id: 'D-PO1', doc_category: 'PO', file_name: 'customer_po.pdf', content_type: 'application/pdf', file_size: 4096, uploaded_by_name: 'Sales Rep', uploaded_at: '2026-11-01T00:00:00.000Z', can_delete: true }]
        },
        'PAYMENT:SHP-1': {
          loaded: true,
          loading: false,
          error: null,
          allShipDocUploadedAt: '2026-11-01T00:00:00.000Z',
          documents: [{ id: 'D-SLIP', doc_category: 'PAYMENT_SLIP', file_name: 'bank_slip.jpg', content_type: 'image/jpeg', file_size: 8192, uploaded_by_name: 'Support', uploaded_at: '2026-11-14T00:00:00.000Z', can_delete: true }]
        }
      }
    }
  });

  const poHtml = h.api.renderPoAttachmentsSection('PO1');
  assert.match(poHtml, /customer_po\.pdf/);
  assert.match(poHtml, /Upload File/);

  const payHtml = h.api.renderPaymentSlipSection('SHP-1', {
    payment_status: 'UNPAID',
    all_ship_doc_uploaded_at: '2026-11-01T00:00:00.000Z',
    payment_slip_count: 1
  });
  assert.match(payHtml, /30-Day Payment Window/);
  assert.match(payHtml, /bank_slip\.jpg/);
  assert.match(payHtml, /Cleared/);

  h.api.setUiLanguage('TH');
  const payHtmlTh = h.api.renderPaymentSlipSection('SHP-1', {
    payment_status: 'UNPAID',
    all_ship_doc_uploaded_at: '2026-11-01T00:00:00.000Z',
    payment_slip_count: 1
  });
  assert.match(payHtmlTh, /30 วัน/);
  assert.match(payHtmlTh, /ชำระแล้ว \/ แนบสลิปเรียบร้อย/);
});

test('loadDocumentsForEntity and deleteDocumentAttachment call backend document endpoints', async () => {
  const calls = [];
  const h = createHarness({
    role: 'ADMIN',
    lang: 'EN',
    fetch: async (url, init = {}) => {
      calls.push({ url, method: init.method || 'GET' });
      if ((init.method || 'GET') === 'GET') {
        return {
          ok: true,
          json: async () => ({
            status: 'SUCCESS',
            data: { documents: [{ id: 'DOC-9', doc_category: 'PO', file_name: 'po.pdf', file_size: 123, can_delete: true }] }
          })
        };
      }
      return { ok: true, json: async () => ({ status: 'SUCCESS', data: { id: 'DOC-9', deleted: true } }) };
    }
  });

  const entry = await h.api.loadDocumentsForEntity('PO', 'PO1');
  assert.equal(entry.documents.length, 1);
  assert.equal(calls[0].url, '/api/documents?entityType=PO&entityId=PO1');
  assert.equal(h.state.documentAttachmentsCache['PO:PO1'].documents.length, 1);

  await h.api.deleteDocumentAttachment('DOC-9', 'PO', 'PO1', 'po.pdf');
  assert.equal(calls[1].url, '/api/documents/DOC-9');
  assert.equal(calls[1].method, 'DELETE');
});

function createCreatePoModalHarness(options = {}) {
  const storage = new Map(Object.entries({ wcat_ui_lang: options.lang || 'TH' }));
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k)
  };
  const makeEl = (id, init = {}) => {
    const classes = new Set((init.className || '').split(/\s+/).filter(Boolean));
    return {
      id,
      value: init.value ?? '',
      innerHTML: init.innerHTML ?? '',
      textContent: init.textContent ?? '',
      disabled: false,
      files: init.files || [],
      classList: {
        add: (...c) => c.forEach((x) => classes.add(x)),
        remove: (...c) => c.forEach((x) => classes.delete(x)),
        contains: (x) => classes.has(x)
      }
    };
  };
  const elements = new Map([
    ['modalBackdrop', makeEl('modalBackdrop')],
    ['newPoCustomerId', makeEl('newPoCustomerId', { value: 'C1' })],
    ['newPoProductId', makeEl('newPoProductId', { value: 'P1' })],
    ['newPoNo', makeEl('newPoNo', { value: 'CUST-PO-9001' })],
    ['newPoDate', makeEl('newPoDate', { value: '2026-11-20' })],
    ['newPoDeliveryStart', makeEl('newPoDeliveryStart', { value: '2026-12-01' })],
    ['newPoDeliveryEnd', makeEl('newPoDeliveryEnd', { value: '2026-12-31' })],
    ['newPoQty', makeEl('newPoQty', { value: '100' })],
    ['newPoTolerancePct', makeEl('newPoTolerancePct', { value: '5' })],
    ['newPoPrice', makeEl('newPoPrice', { value: '350' })],
    ['newPoIncoterm', makeEl('newPoIncoterm', { value: 'FOB' })],
    ['newPoPort', makeEl('newPoPort', { value: 'Rotterdam' })],
    ['newPoShipmentType', makeEl('newPoShipmentType', { value: 'Container' })],
    ['newPoContainerType', makeEl('newPoContainerType', { value: "20'" })],
    ['newPoPackagingSelect', makeEl('newPoPackagingSelect', { value: 'Jumbo Bag 850 kg' })],
    ['newPoPackageWeightKg', makeEl('newPoPackageWeightKg', { value: '850' })],
    ['newPoUnitsPerCont', makeEl('newPoUnitsPerCont', { value: '32' })],
    ['newPoTotalWeightMt', makeEl('newPoTotalWeightMt', { value: '27.2' })],
    ['newPoDeliveryMsg', makeEl('newPoDeliveryMsg', { className: 'hidden' })],
    ['newPoReviewBox', makeEl('newPoReviewBox')],
    ['newPoAttachmentsInput', makeEl('newPoAttachmentsInput')],
    ['newPoAttachError', makeEl('newPoAttachError', { className: 'hidden' })],
    ['newPoAttachSelectedList', makeEl('newPoAttachSelectedList')],
    ['newPoSubmitError', makeEl('newPoSubmitError', { className: 'hidden' })],
    ['newPoSubmitBtn', makeEl('newPoSubmitBtn')],
    ['newPoSubmitLabel', makeEl('newPoSubmitLabel', { textContent: 'Create PO' })]
  ]);
  const document = {
    documentElement: { lang: options.lang === 'EN' ? 'en' : 'th' },
    getElementById: (id) => elements.get(id) || null,
    querySelectorAll: () => []
  };
  const state = {
    currentUser: { user_id: 'U_ADMIN', role: 'ADMIN' },
    customers: [{ id: 'C1', code: 'CUST1', name: 'Acme Agro', dischargePort: 'Rotterdam' }],
    products: [{ id: 'P1', code: 'THP-65', name: 'Tapioca Pellet 65%', shortName: 'THP65' }],
    customerOwners: [],
    pos: [],
    documentAttachmentsCache: {},
    newPoPendingFiles: options.initialPendingFiles || []
  };

  let lastModalHtml = '';
  let closeModalCount = 0;
  let loadPOsCount = 0;
  const alerts = [];

  const constantsStart = html.indexOf('const NEW_PO_ALLOWED_MIME_TYPES =');
  const constantsEnd = html.indexOf('function resetNewPOPendingFiles(');
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'NEW_PO_ALLOWED_MIME_TYPES constants must exist');
  const constantsBlock = html.slice(constantsStart, constantsEnd);

  const fnNames = [
    'getNextPOCode',
    'escapePricingHtml',
    'poProductOptionLabel',
    'getScopedCustomers',
    'updateNewPOSpecOptions',
    'openNewPOModal',
    'validateNewPODeliveryPeriod',
    'formatDeliveryPeriod',
    'renderNewPOReview',
    'updateNewPOReview',
    'resetNewPOPendingFiles',
    'validateNewPOAttachmentFile',
    'renderNewPOSelectedFilesList',
    'handleNewPOFilesSelected',
    'removeNewPOPendingFile',
    'clearNewPOPendingFiles',
    'handleNewPOSubmit',
    'closeModal'
  ];

  const source = `
    ${extractI18nCore()}
    function tr(key, fallback, params) {
      const val = t(key, params);
      return val === key ? (fallback || key) : val;
    }
    ${extractDocumentsModule()}
    ${constantsBlock}
    ${fnNames.map(extractFunction).join('\n\n')}
    return {
      t, tr, getUiLanguage, setUiLanguage,
      ${fnNames.join(', ')}
    };
  `;

  const factory = new Function(
    'window', 'document', 'localStorage', 'state', 'fetch', 'openModal', 'lucide', 'getScopedCustomers',
    'autoFillCustomerDefaults', 'updateNewPOPriceSuggestion', 'getSuggestedSellingPrice', 'getTodayIso',
    'loadPOsFromApi', 'alert', 'renderView',
    source
  );

  const api = factory(
    {},
    document,
    localStorage,
    state,
    options.fetch || (async () => ({ ok: true, json: async () => ({ status: 'SUCCESS', data: {} }) })),
    (markup) => { lastModalHtml = markup; },
    { createIcons: () => {} },
    () => state.customers,
    () => {},
    () => {},
    () => ({ price: 350, source: 'STANDARD', reference: 'STD-1' }),
    () => '2026-11-20',
    async () => { loadPOsCount++; },
    (msg) => alerts.push(msg),
    () => {}
  );

  const origClose = api.closeModal;
  return {
    api: {
      ...api,
      closeModal: () => { closeModalCount++; return origClose(); }
    },
    state,
    elements,
    alerts,
    getLastModalHtml: () => lastModalHtml,
    getLoadPOsCount: () => loadPOsCount,
    getCloseModalCount: () => closeModalCount
  };
}

test('Create New PO modal renders file picker, validates type/size, shows selected files in Review PO, and resets on open/close (TH & EN)', () => {
  for (const [lang, expectedTitle, expectedNone] of [
    ['TH', /แนบไฟล์ใบ PO \(Attach Customer PO\)/, /ไม่มีไฟล์แนบ/],
    ['EN', /Attach Customer PO File\(s\)/, /None/]
  ]) {
    const h = createCreatePoModalHarness({
      lang,
      initialPendingFiles: [new File(['stale'], 'stale.pdf', { type: 'application/pdf' })]
    });

    // Opening modal resets stale files and renders bilingual picker
    h.api.openNewPOModal();
    assert.equal(h.state.newPoPendingFiles.length, 0, `${lang}: openNewPOModal must reset pending files`);
    const modalHtml = h.getLastModalHtml();
    assert.match(modalHtml, expectedTitle);
    assert.match(modalHtml, /id="newPoAttachmentsInput"/);
    assert.match(modalHtml, /accept="\.pdf,application\/pdf,image\/jpeg,image\/png,image\/webp"/);
    assert.match(h.elements.get('newPoReviewBox').innerHTML, expectedNone);

    // Select a mix of valid PDF + invalid .txt + >10MB PDF
    const validPdf = new File(['%PDF-1.4 customer po'], 'MEEL_PO_2026.pdf', { type: 'application/pdf' });
    const badTxt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const hugePdf = new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'oversize.pdf', { type: 'application/pdf' });

    const inputEl = h.elements.get('newPoAttachmentsInput');
    inputEl.files = [validPdf, badTxt, hugePdf];
    h.api.handleNewPOFilesSelected(inputEl);

    // Only valid file kept; validation error shown for rejected files
    assert.equal(h.state.newPoPendingFiles.length, 1);
    assert.equal(h.state.newPoPendingFiles[0].name, 'MEEL_PO_2026.pdf');
    assert.equal(h.elements.get('newPoAttachError').classList.contains('hidden'), false);
    assert.match(h.elements.get('newPoAttachError').textContent, /notes\.txt/);
    assert.match(h.elements.get('newPoAttachError').textContent, /oversize\.pdf/);

    // Selected badge + Review PO both show the attached filename
    assert.match(h.elements.get('newPoAttachSelectedList').innerHTML, /MEEL_PO_2026\.pdf/);
    assert.match(h.elements.get('newPoReviewBox').innerHTML, /MEEL_PO_2026\.pdf/);

    // Removing file updates list & Review PO
    h.api.removeNewPOPendingFile(0);
    assert.equal(h.state.newPoPendingFiles.length, 0);
    assert.match(h.elements.get('newPoReviewBox').innerHTML, expectedNone);

    // Closing modal resets pending files
    inputEl.files = [validPdf];
    h.api.handleNewPOFilesSelected(inputEl);
    assert.equal(h.state.newPoPendingFiles.length, 1);
    h.api.closeModal();
    assert.equal(h.state.newPoPendingFiles.length, 0);
  }
});

test('handleNewPOSubmit chains POST /api/pos -> POST /api/documents/upload with entityType=PO, entityId=createdPo.id, docCategory=PO (TH & EN)', async () => {
  for (const [lang, expectedNotice] of [
    ['TH', /สร้างสัญญา PO PO-2026-009 และอัปโหลดไฟล์แนบ 2 ไฟล์เรียบร้อยแล้ว/],
    ['EN', /PO PO-2026-009 created and 2 attachment\(s\) uploaded successfully\./]
  ]) {
    const calls = [];
    const h = createCreatePoModalHarness({
      lang,
      fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET', body: init.body });
        if (url === '/api/pos') {
          return {
            ok: true,
            json: async () => ({
              status: 'SUCCESS',
              data: { po: { id: 'PO-2026-009', header: { po_id: 'PO-2026-009' } } }
            })
          };
        }
        if (url === '/api/documents/upload') {
          return {
            ok: true,
            json: async () => ({
              status: 'SUCCESS',
              data: {
                documents: [
                  { id: 'DOC-1', doc_category: 'PO', file_name: 'po_main.pdf', file_size: 20 },
                  { id: 'DOC-2', doc_category: 'PO', file_name: 'po_stamp.png', file_size: 16 }
                ]
              }
            })
          };
        }
        throw new Error(`Unexpected URL: ${url}`);
      }
    });

    h.api.openNewPOModal();
    const inputEl = h.elements.get('newPoAttachmentsInput');
    inputEl.files = [
      new File(['%PDF-1.4 main'], 'po_main.pdf', { type: 'application/pdf' }),
      new File([new Uint8Array([137, 80, 78, 71])], 'po_stamp.png', { type: 'image/png' })
    ];
    h.api.handleNewPOFilesSelected(inputEl);

    const result = await h.api.handleNewPOSubmit({ preventDefault: () => {} }, 'PO-2026-009');
    assert.equal(result.ok, true);
    assert.equal(result.poId, 'PO-2026-009');
    assert.equal(result.uploaded, true);

    assert.equal(calls.length, 2);
    assert.equal(calls[0].url, '/api/pos');
    assert.equal(calls[0].method, 'POST');
    const createPayload = JSON.parse(calls[0].body);
    assert.equal(createPayload.customerId, 'C1');
    assert.equal(createPayload.customerPoNo, 'CUST-PO-9001');

    assert.equal(calls[1].url, '/api/documents/upload');
    assert.equal(calls[1].method, 'POST');
    assert.ok(calls[1].body instanceof FormData);
    assert.equal(calls[1].body.get('entityType'), 'PO');
    assert.equal(calls[1].body.get('entityId'), 'PO-2026-009');
    assert.equal(calls[1].body.get('docCategory'), 'PO');
    const uploadedFiles = calls[1].body.getAll('files');
    assert.equal(uploadedFiles.length, 2);
    assert.equal(uploadedFiles[0].name, 'po_main.pdf');
    assert.equal(uploadedFiles[1].name, 'po_stamp.png');

    assert.equal(h.state.newPoPendingFiles.length, 0);
    assert.equal(h.getLoadPOsCount(), 1);
    assert.equal(h.state.poNotice.tone, 'success');
    assert.match(h.state.poNotice.message, expectedNotice);
  }
});

test('handleNewPOSubmit refreshes PO list and surfaces bilingual retry message when PO succeeds but R2 upload fails (TH & EN)', async () => {
  for (const [lang, expectedWarn] of [
    ['TH', /บันทึก PO PO-2026-010 เรียบร้อยแล้ว แต่อัปโหลดไฟล์แนบไม่สำเร็จ.*PO Detail/],
    ['EN', /PO PO-2026-010 was saved, but uploading the attachment\(s\) failed.*PO Detail/]
  ]) {
    const h = createCreatePoModalHarness({
      lang,
      fetch: async (url) => {
        if (url === '/api/pos') {
          return {
            ok: true,
            json: async () => ({
              status: 'SUCCESS',
              data: { po: { header: { po_id: 'PO-2026-010' } } }
            })
          };
        }
        return {
          ok: false,
          json: async () => ({ status: 'ERROR', message: 'R2 temporary error' })
        };
      }
    });

    h.api.openNewPOModal();
    const inputEl = h.elements.get('newPoAttachmentsInput');
    inputEl.files = [new File(['%PDF-1.4 retry'], 'retry_po.pdf', { type: 'application/pdf' })];
    h.api.handleNewPOFilesSelected(inputEl);

    const result = await h.api.handleNewPOSubmit({ preventDefault: () => {} }, 'PO-2026-010');
    assert.equal(result.ok, true);
    assert.equal(result.poId, 'PO-2026-010');
    assert.equal(result.uploaded, false);
    assert.equal(h.getLoadPOsCount(), 1);
    assert.equal(h.state.newPoPendingFiles.length, 0);
    assert.equal(h.state.poNotice.tone, 'warning');
    assert.match(h.state.poNotice.message, expectedWarn);
    assert.match(h.alerts[0], expectedWarn);
  }
});

test('Create PO sends selected currency and complete initial line with full product display', async () => {
  for (const currency of ['USD', 'EUR']) {
    let sent;
    const h = createCreatePoModalHarness({ lang: 'EN', fetch: async (url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ status: 'SUCCESS', data: { po: { header: { po_id: 'NEW' } } } }) }; } });
    h.elements.set('newPoCurrency', { value: currency });
    h.state.selectedPoId = 'OLD';
    h.api.openNewPOModal();
    assert.match(h.getLastModalHtml(), /Tapioca Pellet 65% — THP65 \[THP-65\]/);
    assert.match(h.api.renderNewPOReview(), new RegExp(currency + ' 350.00 / MT'));
    await h.api.handleNewPOSubmit({ preventDefault() {} }, 'NEW');
    assert.equal(sent.currency, currency);
    assert.equal(h.state.selectedPoId, null);
    assert.equal(sent.lines[0].productId, 'P1');
    assert.equal(sent.lines[0].contractQtyMt, 100);
    assert.equal(sent.lines[0].tolerancePct, 5);
    assert.equal(sent.lines[0].unitWeightKg, 850);
    assert.equal(sent.lines[0].unitsPerContainer, 32);
    assert.equal(sent.lines[0].unitPrice, 350);
    assert.equal(h.getLoadPOsCount(), 1);
  }
});

test('external Create PO customer dropdown contains only assigned customers', () => {
  const h = createCreatePoModalHarness({ lang: 'EN' });
  h.state.currentUser = { id: 'SIRA', role: 'EXTERNAL_SALES' };
  h.state.customers = [{ id: 'OWN', name: 'Assigned Buyer', code: 'OWN', ownerId: 'SIRA' }, { id: 'OTHER', name: 'Other Buyer', code: 'OTHER', ownerId: 'OTHER' }, { id: 'HOUSE', name: 'House Buyer', code: 'HOUSE', ownerId: '' }];
  h.api.openNewPOModal();
  assert.match(h.getLastModalHtml(), /Assigned Buyer/);
  assert.doesNotMatch(h.getLastModalHtml(), /Other Buyer|House Buyer/);
});
