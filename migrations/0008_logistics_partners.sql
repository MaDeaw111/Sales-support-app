PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS service_partner_rates (
  rate_id TEXT PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES service_partners(partner_id) ON DELETE CASCADE,
  service_type TEXT NOT NULL CHECK(trim(service_type) <> ''),
  route_scope TEXT,
  container_size TEXT NOT NULL DEFAULT '-' CHECK(container_size IN ('20GP','40GP','40HC','BULK','OTHER','-')),
  unit TEXT NOT NULL CHECK(trim(unit) <> ''),
  price REAL NOT NULL CHECK(price > 0),
  currency TEXT NOT NULL CHECK(currency IN ('THB','USD','EUR')),
  effective_date TEXT NOT NULL,
  valid_until TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(valid_until IS NULL OR valid_until >= effective_date)
);

CREATE INDEX IF NOT EXISTS idx_service_partner_rates_partner_status
  ON service_partner_rates(partner_id, status, effective_date DESC);

CREATE INDEX IF NOT EXISTS idx_service_partners_type_status
  ON service_partners(partner_type, status, partner_name);
