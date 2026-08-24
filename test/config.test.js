import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function parseJsonc(text) {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''));
}

test('wrangler config binds the production D1 database as DB', async () => {
  const raw = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const config = parseJsonc(raw);
  const binding = (config.d1_databases || []).find(x => x.binding === 'DB');
  assert.ok(binding, 'DB D1 binding must exist');
  assert.equal(binding.database_name, 'wcat-sales-db');
  assert.equal(binding.database_id, 'f1618ec6-84b5-46bb-a2ad-b0317e561d65');
});

test('auth migration creates users and sessions tables', async () => {
  const sql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS users/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS sessions/i);
  assert.match(sql, /token_hash\s+TEXT\s+NOT NULL\s+UNIQUE/i);
});
