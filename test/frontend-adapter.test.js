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
