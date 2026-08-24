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
