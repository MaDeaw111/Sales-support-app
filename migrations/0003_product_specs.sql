PRAGMA foreign_keys = ON;

-- 1. Product Categories Table
CREATE TABLE IF NOT EXISTS product_categories (
  category_id TEXT PRIMARY KEY,
  category_code TEXT NOT NULL UNIQUE,
  category_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 2. Product Forms Table
CREATE TABLE IF NOT EXISTS product_forms (
  form_id TEXT PRIMARY KEY,
  form_code TEXT NOT NULL UNIQUE,
  form_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 3. Product Master Table (Identity Only)
CREATE TABLE IF NOT EXISTS products (
  product_id TEXT PRIMARY KEY,
  product_code TEXT NOT NULL UNIQUE,
  product_name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  category_id TEXT NOT NULL,
  form_id TEXT NOT NULL,
  hs_code TEXT NOT NULL DEFAULT '',
  default_unit TEXT NOT NULL DEFAULT 'MT',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES product_categories(category_id),
  FOREIGN KEY (form_id) REFERENCES product_forms(form_id)
);

-- 4. Product Applications Table (Associative)
CREATE TABLE IF NOT EXISTS product_applications (
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (product_id, application),
  FOREIGN KEY (product_id) REFERENCES products(product_id) ON DELETE CASCADE
);

-- 5. Spec Parameter Master Table
CREATE TABLE IF NOT EXISTS spec_parameters (
  parameter_id TEXT PRIMARY KEY,
  parameter_code TEXT NOT NULL UNIQUE,
  parameter_name TEXT NOT NULL,
  data_type TEXT NOT NULL CHECK (data_type IN ('NUMBER', 'TEXT')),
  default_unit TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'INACTIVE', 'ARCHIVED')) DEFAULT 'ACTIVE',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. Versioned Standard Specs Table
CREATE TABLE IF NOT EXISTS standard_specs (
  standard_spec_id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')) DEFAULT 'DRAFT',
  effective_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(product_id),
  FOREIGN KEY (product_id, application) REFERENCES product_applications(product_id, application),
  UNIQUE (product_id, application, revision_no)
);

-- Index to enforce ONLY ONE ACTIVE Standard Spec per Product/Application combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_standard_spec
  ON standard_specs (product_id, application)
  WHERE status = 'ACTIVE';

-- 7. Standard Spec Items Table (Specifications Parameters configuration)
CREATE TABLE IF NOT EXISTS standard_spec_items (
  standard_spec_item_id TEXT PRIMARY KEY,
  standard_spec_id TEXT NOT NULL,
  parameter_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('MIN', 'MAX', 'RANGE', 'EXACT', 'TEXT')),
  numeric_value REAL,
  numeric_value_to REAL,
  text_value TEXT,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (standard_spec_id) REFERENCES standard_specs(standard_spec_id) ON DELETE CASCADE,
  FOREIGN KEY (parameter_id) REFERENCES spec_parameters(parameter_id),
  UNIQUE (standard_spec_id, parameter_id)
);

-- 8. Versioned Customer / Contract Specs Table
CREATE TABLE IF NOT EXISTS customer_specs (
  customer_spec_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  product_id TEXT NOT NULL,
  application TEXT NOT NULL CHECK (application IN ('PET_GRADE', 'FEED_GRADE')),
  base_standard_spec_id TEXT NOT NULL,
  revision_no INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'ACTIVE', 'ARCHIVED')) DEFAULT 'DRAFT',
  effective_date TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
  FOREIGN KEY (product_id) REFERENCES products(product_id),
  FOREIGN KEY (base_standard_spec_id) REFERENCES standard_specs(standard_spec_id),
  UNIQUE (customer_id, product_id, application, revision_no)
);

-- Index to enforce ONLY ONE ACTIVE Customer Spec per Customer/Product/Application combo
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_customer_spec
  ON customer_specs (customer_id, product_id, application)
  WHERE status = 'ACTIVE';

-- 9. Customer Spec Overrides Table
CREATE TABLE IF NOT EXISTS customer_spec_overrides (
  customer_spec_override_id TEXT PRIMARY KEY,
  customer_spec_id TEXT NOT NULL,
  parameter_id TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('MIN', 'MAX', 'RANGE', 'EXACT', 'TEXT')),
  numeric_value REAL,
  numeric_value_to REAL,
  text_value TEXT,
  unit TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (customer_spec_id) REFERENCES customer_specs(customer_spec_id) ON DELETE CASCADE,
  FOREIGN KEY (parameter_id) REFERENCES spec_parameters(parameter_id),
  UNIQUE (customer_spec_id, parameter_id)
);
