const encoder = new TextEncoder();
const PBKDF2_ITERATIONS = 210000;
const SALT_BYTES = 16;
const HASH_BYTES = 32;
const SESSION_TOKEN_BYTES = 32;

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}

function bytesToHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function derivePasswordHash(password, saltBytes, iterations) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    keyMaterial,
    HASH_BYTES * 8
  );
  return new Uint8Array(bits);
}

export async function hashPassword(password, saltBytes = null) {
  if (typeof password !== 'string' || !password) throw new TypeError('Password is required.');
  const salt = saltBytes ? Uint8Array.from(saltBytes) : crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const hash = await derivePasswordHash(password, salt, PBKDF2_ITERATIONS);
  return {
    hash: bytesToBase64Url(hash),
    salt: bytesToBase64Url(salt),
    iterations: PBKDF2_ITERATIONS
  };
}

export async function verifyPassword(password, record) {
  if (!record?.hash || !record?.salt || !record?.iterations) return false;
  const expected = base64UrlToBytes(record.hash);
  const actual = await derivePasswordHash(password, base64UrlToBytes(record.salt), Number(record.iterations));
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected[i] ^ actual[i];
  return difference === 0;
}

export function createSessionToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(SESSION_TOKEN_BYTES)));
}

export async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(token || '')));
  return bytesToHex(new Uint8Array(digest));
}
