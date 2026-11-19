PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS commission_settlements (
  settlement_id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES phase6_shipments(shipment_id),
  di_id TEXT NOT NULL REFERENCES delivery_instructions(di_id),
  po_id TEXT NOT NULL REFERENCES po_headers(po_id),
  po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id),
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  recipient_user_id TEXT NOT NULL REFERENCES users(user_id),
  actual_mt_snapshot REAL NOT NULL CHECK(actual_mt_snapshot > 0),
  rate_snapshot_usd_mt REAL NOT NULL CHECK(rate_snapshot_usd_mt > 0),
  amount_usd_snapshot REAL NOT NULL CHECK(amount_usd_snapshot > 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency = 'USD'),
  line_breakdown_json TEXT NOT NULL CHECK(trim(line_breakdown_json) <> ''),
  status TEXT NOT NULL DEFAULT 'PAID' CHECK(status IN ('PAID')),
  paid_date TEXT NOT NULL,
  payment_reference TEXT,
  note TEXT,
  request_key TEXT NOT NULL UNIQUE CHECK(trim(request_key) <> ''),
  settled_by TEXT NOT NULL REFERENCES users(user_id),
  settled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shipment_id, recipient_user_id)
);

CREATE TABLE IF NOT EXISTS commission_audit_events (
  event_id TEXT PRIMARY KEY,
  settlement_id TEXT NOT NULL REFERENCES commission_settlements(settlement_id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('COMMISSION_SETTLED', 'COMMISSION_NOTE_UPDATED')),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_commission_settlements_recipient_status
  ON commission_settlements(recipient_user_id, status, paid_date DESC);

CREATE INDEX IF NOT EXISTS idx_commission_settlements_shipment
  ON commission_settlements(shipment_id);

CREATE INDEX IF NOT EXISTS idx_commission_audit_events_settlement
  ON commission_audit_events(settlement_id, created_at DESC);
