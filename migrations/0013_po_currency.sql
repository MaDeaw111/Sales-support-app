ALTER TABLE po_revision_lines ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency IN ('USD', 'EUR', 'THB'));
ALTER TABLE po_revision_lines ADD COLUMN unit_weight_kg REAL NOT NULL DEFAULT 0 CHECK(unit_weight_kg >= 0);
ALTER TABLE po_revision_lines ADD COLUMN units_per_container REAL NOT NULL DEFAULT 0 CHECK(units_per_container >= 0);

UPDATE po_revision_lines SET currency = (SELECT currency FROM po_revisions WHERE revision_id = po_revision_id);

CREATE TRIGGER po_line_currency_insert AFTER INSERT ON po_revision_lines
BEGIN
  UPDATE po_revision_lines SET currency = (SELECT currency FROM po_revisions WHERE revision_id = NEW.po_revision_id) WHERE line_id = NEW.line_id;
END;

CREATE TRIGGER po_revision_currency_update AFTER UPDATE OF currency ON po_revisions
WHEN NEW.currency <> OLD.currency
BEGIN
  UPDATE po_revision_lines SET currency = NEW.currency, suggested_price = NULL, source_price_note_id = NULL WHERE po_revision_id = NEW.revision_id;
END;
