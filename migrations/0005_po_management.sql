-- Enable foreign keys check
PRAGMA foreign_keys = ON;

-- 1. Recreate manager_price_notes to allow NULL for sales_user_id
PRAGMA foreign_keys = OFF;

ALTER TABLE manager_price_notes RENAME TO manager_price_notes_old;

CREATE TABLE manager_price_notes (
    note_id TEXT PRIMARY KEY,
    sales_user_id TEXT REFERENCES users(user_id),
    customer_id TEXT NOT NULL REFERENCES customers(customer_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    incoterm TEXT CHECK(incoterm IN ('FOB', 'CFR', 'CIF')) NOT NULL,
    destination_port TEXT,
    offer_price_usd_per_mt REAL CHECK(offer_price_usd_per_mt > 0) NOT NULL,
    note TEXT,
    created_by_manager_id TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (incoterm = 'FOB' OR (incoterm IN ('CFR', 'CIF') AND destination_port IS NOT NULL AND trim(destination_port) <> ''))
);

INSERT INTO manager_price_notes (
    note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, note, created_by_manager_id, created_at
)
SELECT 
    note_id, sales_user_id, customer_id, product_id, incoterm, destination_port, offer_price_usd_per_mt, note, created_by_manager_id, created_at
FROM manager_price_notes_old;

DROP TABLE manager_price_notes_old;

PRAGMA foreign_keys = ON;

-- 2. PO Headers Table
CREATE TABLE po_headers (
    po_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(customer_id),
    header_status TEXT NOT NULL CHECK(header_status IN ('OPEN', 'PARTIALLY_SHIPPED', 'COMPLETED', 'CANCELLED')) DEFAULT 'OPEN',
    current_active_revision_id TEXT REFERENCES po_revisions(revision_id) ON DELETE SET NULL,
    current_draft_revision_id TEXT REFERENCES po_revisions(revision_id) ON DELETE SET NULL,
    created_by TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    cancelled_by TEXT REFERENCES users(user_id),
    cancelled_at TEXT,
    cancellation_reason TEXT
);

-- 3. PO Revisions Table
CREATE TABLE po_revisions (
    revision_id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL REFERENCES po_headers(po_id) ON DELETE CASCADE,
    revision_no INTEGER NOT NULL CHECK(revision_no >= 0),
    status TEXT NOT NULL CHECK(status IN ('DRAFT', 'ACTIVE', 'SUPERSEDED')),
    customer_po_no TEXT,
    po_date TEXT,
    buyer_reference TEXT,
    ownership_type_snapshot TEXT NOT NULL CHECK(ownership_type_snapshot IN ('ASSIGNED_SALES', 'HOUSE_ACCOUNT')),
    sales_owner_user_id_snapshot TEXT REFERENCES users(user_id),
    customer_contact_id TEXT REFERENCES customer_contacts(contact_id),
    customer_contact_snapshot_json TEXT,
    currency TEXT NOT NULL CHECK(currency IN ('USD', 'THB', 'EUR')),
    incoterm TEXT NOT NULL CHECK(incoterm IN ('FOB', 'CFR', 'CIF')),
    destination TEXT,
    delivery_start TEXT NOT NULL,
    delivery_end TEXT NOT NULL,
    valid_until TEXT NOT NULL,
    payment_term_snapshot TEXT,
    commercial_terms TEXT,
    operational_note TEXT,
    revision_note TEXT,
    approved_by TEXT REFERENCES users(user_id),
    approved_at TEXT,
    approval_note TEXT,
    approval_summary_json TEXT,
    created_by TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (po_id, revision_no),
    CHECK (delivery_start <= delivery_end)
);

-- Constraints: Only one ACTIVE and one DRAFT revision allowed per PO header
CREATE UNIQUE INDEX idx_active_revision ON po_revisions (po_id) WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX idx_draft_revision ON po_revisions (po_id) WHERE status = 'DRAFT';

-- Index for unique customer PO number lookup within same PO/Customer
CREATE INDEX idx_po_customer_po_no ON po_revisions (customer_po_no, po_id);

-- 4. PO Revision Lines Table
CREATE TABLE po_revision_lines (
    line_id TEXT PRIMARY KEY,
    po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id) ON DELETE CASCADE,
    line_no INTEGER NOT NULL CHECK(line_no > 0),
    previous_line_id TEXT REFERENCES po_revision_lines(line_id) ON DELETE SET NULL,
    product_id TEXT NOT NULL REFERENCES products(product_id),
    spec_source TEXT NOT NULL CHECK(spec_source IN ('CUSTOMER', 'STANDARD')),
    spec_revision_id TEXT NOT NULL,
    spec_override_json TEXT,
    contract_qty_mt REAL NOT NULL CHECK(contract_qty_mt >= 0),
    tolerance_pct REAL NOT NULL CHECK(tolerance_pct >= 0 AND tolerance_pct <= 100),
    min_qty_mt REAL NOT NULL CHECK(min_qty_mt >= 0),
    max_qty_mt REAL NOT NULL CHECK(max_qty_mt >= 0),
    unit_price REAL NOT NULL CHECK(unit_price >= 0),
    price_unit TEXT NOT NULL DEFAULT '/MT' CHECK(price_unit = '/MT'),
    source_price_note_id TEXT REFERENCES manager_price_notes(note_id),
    suggested_price REAL CHECK(suggested_price >= 0),
    price_override_reason TEXT,
    packaging TEXT NOT NULL,
    container_type TEXT NOT NULL,
    loading_pattern TEXT NOT NULL,
    commission_recipient_user_id TEXT REFERENCES users(user_id),
    commission_rate_usd_mt REAL NOT NULL DEFAULT 0 CHECK(commission_rate_usd_mt >= 0),
    commercial_line_term TEXT,
    operational_line_note TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (po_revision_id, line_no),
    CHECK (min_qty_mt <= contract_qty_mt AND contract_qty_mt <= max_qty_mt),
    CHECK (suggested_price IS NULL OR unit_price = suggested_price OR (price_override_reason IS NOT NULL AND trim(price_override_reason) <> ''))
);

-- 5. PO Revision Documents Table
CREATE TABLE po_revision_documents (
    document_id TEXT PRIMARY KEY,
    po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id) ON DELETE CASCADE,
    document_type TEXT NOT NULL CHECK(document_type IN ('CUSTOMER_PO', 'AMENDMENT', 'EMAIL_CONFIRMATION', 'OTHER')),
    label TEXT NOT NULL CHECK(trim(label) <> ''),
    url TEXT NOT NULL CHECK(url LIKE 'http://%' OR url LIKE 'https://%'),
    created_by TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT REFERENCES users(user_id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 6. PO Audit Events Table
CREATE TABLE po_audit_events (
    event_id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL REFERENCES po_headers(po_id) ON DELETE CASCADE,
    po_revision_id TEXT REFERENCES po_revisions(revision_id) ON DELETE SET NULL,
    event_type TEXT NOT NULL CHECK(event_type IN ('PO_CREATED', 'REVISION_CREATED', 'REVISION_ACTIVATED', 'REVISION_SUPERSEDED', 'PO_LINE_ADDED', 'PO_LINE_REMOVED', 'DOCUMENT_ADDED', 'DOCUMENT_UPDATED', 'DOCUMENT_REMOVED', 'OPERATIONAL_NOTE_UPDATED', 'PO_CANCELLED', 'SPEC_OLD_REVISION_CONFIRMED', 'PRICE_OVERRIDE_USED')),
    actor_id TEXT NOT NULL REFERENCES users(user_id),
    metadata_json TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 7. PO Field Diffs Table
CREATE TABLE po_field_diffs (
    diff_id TEXT PRIMARY KEY,
    po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL CHECK(entity_type IN ('HEADER', 'REVISION', 'LINE', 'DOCUMENT')),
    entity_id TEXT NOT NULL,
    field_name TEXT NOT NULL CHECK(trim(field_name) <> ''),
    old_value TEXT,
    new_value TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Helper Indices for optimization
CREATE INDEX IF NOT EXISTS idx_po_revisions_po_id ON po_revisions(po_id);
CREATE INDEX IF NOT EXISTS idx_po_revision_lines_rev ON po_revision_lines(po_revision_id);
CREATE INDEX IF NOT EXISTS idx_po_revision_documents_rev ON po_revision_documents(po_revision_id);
CREATE INDEX IF NOT EXISTS idx_po_audit_events_po ON po_audit_events(po_id);
