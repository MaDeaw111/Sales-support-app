import { hashPassword } from '../src/auth/crypto.js';

const allowedRoles = new Set(['ADMIN','MANAGER','SALES_SUPPORT','EXTERNAL_SALES','EXPORT','PRODUCTION_WAREHOUSE']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith('--') || value === undefined) throw new Error(`Invalid argument near ${key || 'end of input'}.`);
    out[key.slice(2)] = value;
  }
  return out;
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

const args = parseArgs(process.argv.slice(2));
const userId = String(args['user-id'] || '').trim();
const fullName = String(args.name || '').trim();
const email = String(args.email || '').trim().toLowerCase();
const role = String(args.role || '').trim().toUpperCase();
const scope = String(args.scope || 'NONE').trim().toUpperCase();
const password = String(args.password || '');

if (!userId || !fullName || !email || !password) {
  throw new Error('Required: --user-id, --name, --email, --role, --password. Optional: --scope.');
}
if (!allowedRoles.has(role)) throw new Error(`Unsupported role: ${role}`);
if (password.length < 8) throw new Error('Password must be at least 8 characters.');

const record = await hashPassword(password);
const sql = `INSERT INTO users (
  user_id, full_name, email, role, customer_scope, status,
  password_hash, password_salt, password_iterations, must_change_password
) VALUES (
  ${sqlString(userId)}, ${sqlString(fullName)}, ${sqlString(email)}, ${sqlString(role)}, ${sqlString(scope)}, 'ACTIVE',
  ${sqlString(record.hash)}, ${sqlString(record.salt)}, ${record.iterations}, 1
);`;

process.stdout.write(`${sql}\n`);
