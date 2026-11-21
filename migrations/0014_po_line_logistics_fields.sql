ALTER TABLE po_revision_lines ADD COLUMN shipment_type TEXT NOT NULL DEFAULT '';
ALTER TABLE po_revision_lines ADD COLUMN target_load_weight_mt REAL NOT NULL DEFAULT 0 CHECK(target_load_weight_mt >= 0);
ALTER TABLE po_revision_lines ADD COLUMN incoterm TEXT CHECK(incoterm IN ('EXW','FCA','FAS','FOB','CFR','CIF','CPT','CIP','DAP','DPU','DDP'));
ALTER TABLE po_revision_lines ADD COLUMN destination_port TEXT;

UPDATE po_revision_lines SET
  shipment_type = CASE WHEN loading_pattern IN ('Container','Bulk Vessel','Bulk','Truck') THEN loading_pattern ELSE '' END,
  target_load_weight_mt = ROUND(unit_weight_kg * units_per_container / 1000.0, 4),
  incoterm = (SELECT incoterm FROM po_revisions WHERE revision_id = po_revision_id),
  destination_port = (SELECT destination FROM po_revisions WHERE revision_id = po_revision_id);

CREATE TABLE po_attachment_cleanup (
  r2_key TEXT PRIMARY KEY,
  po_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_po_attachment_cleanup_po ON po_attachment_cleanup(po_id);

CREATE TRIGGER prevent_used_po_delete BEFORE DELETE ON po_headers
WHEN EXISTS (SELECT 1 FROM po_revisions WHERE po_id = OLD.po_id AND status IN ('ACTIVE','SUPERSEDED'))
  OR EXISTS (SELECT 1 FROM delivery_instructions WHERE po_id = OLD.po_id OR po_revision_id IN (SELECT revision_id FROM po_revisions WHERE po_id = OLD.po_id))
  OR EXISTS (SELECT 1 FROM delivery_instruction_lines WHERE po_id = OLD.po_id OR po_revision_id IN (SELECT revision_id FROM po_revisions WHERE po_id = OLD.po_id) OR po_revision_line_id IN (SELECT l.line_id FROM po_revision_lines l JOIN po_revisions r ON r.revision_id = l.po_revision_id WHERE r.po_id = OLD.po_id))
  OR EXISTS (SELECT 1 FROM shipment_invoice_lines WHERE po_revision_line_id IN (SELECT l.line_id FROM po_revision_lines l JOIN po_revisions r ON r.revision_id = l.po_revision_id WHERE r.po_id = OLD.po_id))
  OR EXISTS (SELECT 1 FROM shipments WHERE po_id = OLD.po_id)
  OR EXISTS (SELECT 1 FROM commission_settlements WHERE po_id = OLD.po_id)
BEGIN
  SELECT RAISE(ABORT, 'PO_IN_USE');
END;

CREATE TRIGGER prevent_orphan_po_attachment BEFORE INSERT ON document_attachments
WHEN NEW.entity_type = 'PO' AND NOT EXISTS (SELECT 1 FROM po_headers WHERE po_id = NEW.entity_id)
BEGIN
  SELECT RAISE(ABORT, 'PO_NOT_FOUND');
END;

-- Retain allocated numbers permanently so stale deletion retries cannot affect a new PO.
CREATE TABLE po_deleted_ids (po_id TEXT PRIMARY KEY);
CREATE TRIGGER remember_deleted_po AFTER DELETE ON po_headers
BEGIN
  INSERT OR IGNORE INTO po_deleted_ids (po_id) VALUES (OLD.po_id);
END;
