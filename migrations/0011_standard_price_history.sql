PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS standard_prices (
  standard_price_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(product_id),
  revision_no INTEGER NOT NULL DEFAULT 1 CHECK (revision_no >= 1),
  price_per_mt REAL NOT NULL CHECK (price_per_mt > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency IN ('USD', 'THB', 'EUR')),
  effective_from TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'EXPIRED')),
  previous_price_per_mt REAL,
  change_reason TEXT NOT NULL DEFAULT '',
  changed_by TEXT NOT NULL REFERENCES users(user_id),
  changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (product_id, revision_no)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_standard_prices_one_active_per_product
  ON standard_prices (product_id)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_standard_prices_product_history
  ON standard_prices (product_id, changed_at DESC, revision_no DESC);

CREATE TABLE IF NOT EXISTS special_prices (
  special_price_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  std_fob_at_request REAL NOT NULL DEFAULT 0 CHECK (std_fob_at_request >= 0),
  approved_price_usd REAL NOT NULL CHECK (approved_price_usd > 0),
  expected_qty_mt REAL NOT NULL DEFAULT 0 CHECK (expected_qty_mt >= 0),
  valid_until TEXT,
  approval_status TEXT NOT NULL DEFAULT 'PENDING' CHECK (approval_status IN ('PENDING', 'APPROVED', 'REJECTED')),
  reason TEXT NOT NULL DEFAULT '',
  requested_by TEXT NOT NULL REFERENCES users(user_id),
  reviewed_by TEXT REFERENCES users(user_id),
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_special_prices_product_status
  ON special_prices (product_id, approval_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_special_prices_customer
  ON special_prices (customer_id, product_id, approval_status);
