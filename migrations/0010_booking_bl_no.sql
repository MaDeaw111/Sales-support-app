PRAGMA foreign_keys = ON;

ALTER TABLE phase6_shipments ADD COLUMN bl_no TEXT;

CREATE INDEX IF NOT EXISTS idx_phase6_shipments_bl_no ON phase6_shipments(bl_no);
