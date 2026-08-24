import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('function callBackend(action, payload, onSuccess, onFailure)');
const end = html.indexOf('\n        function initApp()', start);
const adapter = html.slice(start, end);

test('callBackend uses Cloudflare gateway fetch transport', () => {
  assert.ok(start >= 0, 'callBackend function must exist');
  assert.match(adapter, /fetch\(['"]\/api\/gateway['"]/);
});

test('callBackend no longer invokes Apps Script apiGateway', () => {
  assert.doesNotMatch(adapter, /google\.script\.run[\s\S]*?\.apiGateway/);
});
