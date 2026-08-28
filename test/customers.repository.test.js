import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { createCustomerRepository } from '../src/customers/repository.js';

async function setupTestDb() {
  const db = new DatabaseSync(':memory:');
  
  // First load 0001_auth.sql since customers table references users
  const authSql = await readFile(new URL('../migrations/0001_auth.sql', import.meta.url), 'utf8');
  db.exec(authSql);
  
  // Then load 0002_customers.sql
  const customersSql = await readFile(new URL('../migrations/0002_customers.sql', import.meta.url), 'utf8');
  db.exec(customersSql);

  // Load 0006_customer_ownership_type.sql
  const ownershipSql = await readFile(new URL('../migrations/0006_customer_ownership_type.sql', import.meta.url), 'utf8');
  db.exec(ownershipSql);
  
  // Insert referenced users (PRAGMA foreign_keys = ON is enabled)
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('USR-0001', 'Test Admin', 'admin@example.com', 'ADMIN', 'hash', 'salt');
  
  db.prepare(`
    INSERT INTO users (user_id, full_name, email, role, password_hash, password_salt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run('USR-0006', 'Sales Support', 'sales@example.com', 'SALES_SUPPORT', 'hash', 'salt');
  
  return db;
}

test('customer schema migration creates tables and indexes correctly', async () => {
  const db = await setupTestDb();
  
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

test('repository maps primary contact to compatibility fields', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);
  
  // Seed customer CUST-0001
  await repo.createCustomer({
    id: 'CUST-0001',
    code: 'C-C-001',
    name: 'Milan Customer',
    ownerId: 'USR-0001',
    contacts: [
      { name: 'Milan Wolff', email: 'm.wolff@meelunie.com', phone: '+31 20 530 6500', isPrimary: true }
    ]
  });
  
  const customer = await repo.findCustomerById('CUST-0001', {});
  assert.equal(customer.contactPerson, 'Milan Wolff');
  assert.equal(customer.contactEmail, 'm.wolff@meelunie.com');
  assert.equal(customer.contactPhone, '+31 20 530 6500');
  assert.equal(customer.contacts[0].isPrimary, true);
});

test('repository can filter list by owner user id', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);
  
  // Seed customers
  await repo.createCustomer({
    id: 'CUST-0001',
    code: 'C-C-001',
    name: 'Milan Customer',
    ownerId: 'USR-0001',
    contacts: []
  });
  
  await repo.createCustomer({
    id: 'CUST-0002',
    code: 'C-C-002',
    name: 'Other Customer',
    ownerId: 'USR-0006',
    contacts: []
  });
  
  const rows = await repo.listCustomers({ ownerUserId: 'USR-0006' });
  assert.ok(rows.every(c => c.ownerId === 'USR-0006'));
  assert.equal(rows.length, 1);
});

test('repository creates customer and contacts', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);
  
  const created = await repo.createCustomer({
    name: 'Example B.V.',
    code: 'C-C-010',
    ownerId: 'USR-0001',
    contacts: [{ name: 'Buyer', isPrimary: true }]
  });
  assert.equal(created.id, 'CUST-0001');
  assert.equal(created.name, 'Example B.V.');
  assert.equal(created.contacts.length, 1);
  
  const second = await repo.createCustomer({
    name: 'Second B.V.',
    code: 'C-C-011',
    ownerId: 'USR-0001',
    contacts: []
  });
  assert.equal(second.id, 'CUST-0002');
});

test('repository update replaces contacts', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);
  
  // Seed customer CUST-0001
  await repo.createCustomer({
    id: 'CUST-0001',
    code: 'C-C-001',
    name: 'Milan Customer',
    ownerId: 'USR-0001',
    contacts: [
      { name: 'Old Contact', isPrimary: false }
    ]
  });
  
  const updated = await repo.updateCustomer('CUST-0001', {
    name: 'MEELUNIE B.V.',
    contacts: [{ name: 'New Primary', isPrimary: true }]
  });
  assert.deepEqual(updated.contacts.map(c => c.name), ['New Primary']);
});

test('repository normalizes contacts correctly', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);
  
  const created = await repo.createCustomer({
    name: 'Normalizer B.V.',
    code: 'C-C-020',
    ownerId: 'USR-0001',
    contacts: [
      { name: '  ', isPrimary: true },
      { name: ' John Doe  ', position: '  Manager ', email: 'john@doe.com', isPrimary: false },
      { name: ' Jane Smith  ', position: 'Director', isPrimary: true }
    ]
  });
  
  assert.equal(created.contacts.length, 2);
  
  const john = created.contacts.find(c => c.name === 'John Doe');
  assert.ok(john);
  assert.equal(john.position, 'Manager');
  assert.equal(john.isPrimary, false);
  
  const jane = created.contacts.find(c => c.name === 'Jane Smith');
  assert.ok(jane);
  assert.equal(jane.isPrimary, true);
  
  const created2 = await repo.createCustomer({
    name: 'Normalizer 2 B.V.',
    code: 'C-C-021',
    ownerId: 'USR-0001',
    contacts: [
      { name: ' First Contact  ', isPrimary: false },
      { name: ' Second Contact  ', isPrimary: false }
    ]
  });
  
  assert.equal(created2.contacts[0].name, 'First Contact');
  assert.equal(created2.contacts[0].isPrimary, true);
  assert.equal(created2.contacts[1].name, 'Second Contact');
  assert.equal(created2.contacts[1].isPrimary, false);
});

test('Customer CRM repository - customer ownership type rules', async () => {
  const db = await setupTestDb();
  const repo = createCustomerRepository(db);

  // 1. Create HOUSE_ACCOUNT without owner
  const cust1 = await repo.createCustomer({
    name: 'House Cust',
    code: 'C-H-001',
    ownershipType: 'HOUSE_ACCOUNT',
    ownerId: null,
    contacts: []
  });
  assert.equal(cust1.ownershipType, 'HOUSE_ACCOUNT');
  assert.equal(cust1.ownerId, ''); // rowToCustomer maps null/undefined to empty string

  // 2. Create ASSIGNED_SALES with owner
  const cust2 = await repo.createCustomer({
    name: 'Assigned Cust',
    code: 'C-A-001',
    ownershipType: 'ASSIGNED_SALES',
    ownerId: 'USR-0001',
    contacts: []
  });
  assert.equal(cust2.ownershipType, 'ASSIGNED_SALES');
  assert.equal(cust2.ownerId, 'USR-0001');

  // 3. Reject ASSIGNED_SALES without owner
  await assert.rejects(async () => {
    await repo.createCustomer({
      name: 'Failed Assigned Cust',
      code: 'C-A-002',
      ownershipType: 'ASSIGNED_SALES',
      ownerId: null,
      contacts: []
    });
  }, /Sales Owner is required/);

  // 4. Switch ASSIGNED_SALES -> HOUSE_ACCOUNT clears owner
  const cust2Updated = await repo.updateCustomer(cust2.id, {
    ownershipType: 'HOUSE_ACCOUNT'
  });
  assert.equal(cust2Updated.ownershipType, 'HOUSE_ACCOUNT');
  assert.equal(cust2Updated.ownerId, '');

  // 5. Switch HOUSE_ACCOUNT -> ASSIGNED_SALES requires owner
  await assert.rejects(async () => {
    await repo.updateCustomer(cust1.id, {
      ownershipType: 'ASSIGNED_SALES'
    });
  }, /Sales Owner is required/);

  const cust1Updated = await repo.updateCustomer(cust1.id, {
    ownershipType: 'ASSIGNED_SALES',
    ownerId: 'USR-0001'
  });
  assert.equal(cust1Updated.ownershipType, 'ASSIGNED_SALES');
  assert.equal(cust1Updated.ownerId, 'USR-0001');
  
  // 6. Find API returns ownershipType
  const found = await repo.findCustomerById(cust1.id);
  assert.equal(found.ownershipType, 'ASSIGNED_SALES');
});
