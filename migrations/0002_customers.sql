PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS customers (
  customer_id TEXT PRIMARY KEY,
  customer_code TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'DIRECT',
  owner_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE_CUSTOMER',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_user_id) REFERENCES users(user_id) ON DELETE SET NULL,
  CHECK (status IN ('ACTIVE_CUSTOMER','INACTIVE_CUSTOMER'))
);

CREATE TABLE IF NOT EXISTS customer_contacts (
  contact_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id) ON DELETE CASCADE,
  CHECK (is_primary IN (0,1))
);

CREATE INDEX IF NOT EXISTS idx_customers_owner_user_id
  ON customers(owner_user_id);

CREATE INDEX IF NOT EXISTS idx_customers_status
  ON customers(status);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_customer_id
  ON customer_contacts(customer_id);

CREATE INDEX IF NOT EXISTS idx_customer_contacts_primary
  ON customer_contacts(customer_id, is_primary);
