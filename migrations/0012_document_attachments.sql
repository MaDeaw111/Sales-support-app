PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS document_attachments (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('PO', 'SHIPMENT', 'PAYMENT')),
  entity_id TEXT NOT NULL CHECK(trim(entity_id) <> ''),
  doc_category TEXT NOT NULL CHECK(doc_category IN ('PO', 'DI', 'STUFFING_REPORT', 'ALL_SHIP_DOC', 'PAYMENT_SLIP')),
  file_name TEXT NOT NULL CHECK(trim(file_name) <> ''),
  content_type TEXT NOT NULL CHECK(content_type IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  file_size INTEGER NOT NULL CHECK(file_size > 0 AND file_size <= 10485760),
  r2_key TEXT NOT NULL UNIQUE CHECK(trim(r2_key) <> ''),
  uploaded_by TEXT NOT NULL REFERENCES users(user_id),
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_document_attachments_entity
  ON document_attachments(entity_type, entity_id, doc_category, uploaded_at);

CREATE INDEX IF NOT EXISTS idx_document_attachments_category
  ON document_attachments(doc_category, entity_id);
