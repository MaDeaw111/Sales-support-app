import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hashPassword,
  verifyPassword,
  createSessionToken,
  hashSessionToken
} from '../src/auth/crypto.js';

test('PBKDF2 password verifier accepts correct password and rejects wrong password', async () => {
  const record = await hashPassword('CorrectHorseBatteryStaple!');
  assert.equal(record.iterations, 100000);
  assert.equal(await verifyPassword('CorrectHorseBatteryStaple!', record), true);
  assert.equal(await verifyPassword('wrong-password', record), false);
});

test('createSessionToken returns independent high-entropy tokens', () => {
  const first = createSessionToken();
  const second = createSessionToken();
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.match(second, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first, second);
});

test('hashSessionToken is deterministic SHA-256 output', async () => {
  const first = await hashSessionToken('abc123');
  const second = await hashSessionToken('abc123');
  const other = await hashSessionToken('xyz789');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(first, second);
  assert.notEqual(first, other);
});
