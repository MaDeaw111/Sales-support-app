import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('generate-user-sql outputs a safe D1 insert without plaintext password', async () => {
  const password = 'TempPassword123!';
  const { stdout } = await execFileAsync(process.execPath, [
    'scripts/generate-user-sql.mjs',
    '--user-id', 'USR-0001',
    '--name', 'Test Admin',
    '--email', 'admin@example.com',
    '--role', 'ADMIN',
    '--scope', 'ALL',
    '--password', password
  ], { cwd: new URL('..', import.meta.url) });

  assert.match(stdout, /INSERT INTO users/i);
  assert.match(stdout, /USR-0001/);
  assert.match(stdout, /admin@example\.com/);
  assert.match(stdout, /100000/);
  assert.match(stdout, /must_change_password/i);
  assert.doesNotMatch(stdout, new RegExp(password.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
