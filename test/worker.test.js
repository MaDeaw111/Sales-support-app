import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

function makeEnv() {
  return {
    ASSETS: {
      async fetch(request) {
        return new Response(`asset:${new URL(request.url).pathname}`, { status: 200 });
      }
    }
  };
}

test('GET /api/health returns WCAT success JSON', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/health'), makeEnv());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.deepEqual(await response.json(), {
    status: 'SUCCESS',
    data: { service: 'WCAT Sales Support', runtime: 'Cloudflare Workers' }
  });
});

test('POST /api/gateway is explicitly not implemented in phase 1-2', async () => {
  const response = await worker.fetch(new Request('https://example.com/api/gateway', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'GET_MASTER_DATA', payload: {} })
  }), makeEnv());
  assert.equal(response.status, 501);
  assert.deepEqual(await response.json(), {
    status: 'ERROR',
    message: 'Backend action migration is not implemented in Cloudflare Phase 1-2.'
  });
});

test('non-API requests fall back to the static asset binding', async () => {
  const response = await worker.fetch(new Request('https://example.com/'), makeEnv());
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'asset:/');
});
