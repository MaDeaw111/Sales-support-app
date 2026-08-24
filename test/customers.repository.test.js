import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';

test('customer schema migration creates tables and indexes correctly', async () => {
  const db = new DatabaseSync(':memory:');
  
  // First load 0001_auth.sql since customers table references users
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  
  // Then load 0002_customers.sql
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);
  
  // Query table names
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
  const tableNames = tables.map(t => t.name);
  
  // Query index names
  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all();
  const indexNames = indexes.map(i => i.name);
  
  // Assertions required by Step 1
  assert.ok(tableNames.includes('customers'));
  assert.ok(tableNames.includes('customer_contacts'));
  assert.ok(indexNames.includes('idx_customers_owner_user_id'));
  assert.ok(indexNames.includes('idx_customers_status'));
  assert.ok(indexNames.includes('idx_customer_contacts_customer_id'));
  assert.ok(indexNames.includes('idx_customer_contacts_primary'));
});
