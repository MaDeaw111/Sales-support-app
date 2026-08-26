-- Minimal PO anchor table
CREATE TABLE pos (
    po_id TEXT PRIMARY KEY,
    customer_id TEXT NOT NULL REFERENCES customers(customer_id),
    product_id TEXT NOT NULL REFERENCES products(product_id),
    incoterm TEXT CHECK(incoterm IN ('FOB', 'CFR', 'CIF')) NOT NULL,
    destination_port TEXT,
    po_date TEXT,
    status TEXT
);

-- Freight Quotes table
CREATE TABLE freight_quotes (
    quote_id TEXT PRIMARY KEY,
    origin_port TEXT NOT NULL CHECK(trim(origin_port) <> ''),
    destination_port TEXT NOT NULL CHECK(trim(destination_port) <> ''),
    container_size TEXT NOT NULL CHECK(trim(container_size) <> ''),
    shipping_line_or_forwarder TEXT NOT NULL CHECK(trim(shipping_line_or_forwarder) <> ''),
    quoted_freight_usd_per_container REAL CHECK(quoted_freight_usd_per_container > 0) NOT NULL,
    valid_until TEXT,
    remark TEXT,
    created_by TEXT NOT NULL REFERENCES users(user_id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Minimal Shipment anchor table
CREATE TABLE shipments (
    shipment_id TEXT PRIMARY KEY,
    po_id TEXT NOT NULL REFERENCES pos(po_id),
    freight_quote_id TEXT REFERENCES freight_quotes(quote_id),
    is_one_container INTEGER CHECK(is_one_container IN (0, 1)) DEFAULT 1,
    status TEXT
);

-- Expense Categories table
CREATE TABLE expense_categories (
    category_id TEXT PRIMARY KEY,
    category_code TEXT UNIQUE NOT NULL CHECK(trim(category_code) <> ''),
    category_name TEXT NOT NULL CHECK(trim(category_name) <> ''),
    category_group TEXT CHECK(category_group IN ('OCEAN_FREIGHT', 'SHIPPING_LOCAL', 'TRANSPORT', 'DOCUMENT', 'INSURANCE', 'OTHER')) NOT NULL,
    status TEXT CHECK(status IN ('ACTIVE', 'INACTIVE')) DEFAULT 'ACTIVE',
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Manager Price Notes table
CREATE TABLE manager_price_notes (
    note_id TEXT PRIMARY KEY,
    sales_user_id TEXT NOT NULL REFERENCES users(user_id),
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

-- Shipment Document Links table
CREATE TABLE shipment_document_links (
    link_id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(shipment_id) ON DELETE CASCADE,
    document_type TEXT CHECK(document_type IN ('PO', 'DI', 'BOOKING', 'STUFFING_REPORT', 'ALL_SHIP_DOC', 'IR', 'LC')) NOT NULL,
    title TEXT NOT NULL CHECK(trim(title) <> ''),
    drive_url TEXT CHECK(drive_url LIKE 'http://%' OR drive_url LIKE 'https://%') NOT NULL,
    reference_no TEXT,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Shipment Expenses table
CREATE TABLE shipment_expenses (
    expense_id TEXT PRIMARY KEY,
    shipment_id TEXT NOT NULL REFERENCES shipments(shipment_id) ON DELETE CASCADE,
    expense_category_id TEXT NOT NULL REFERENCES expense_categories(category_id),
    amount REAL CHECK(amount > 0) NOT NULL,
    currency TEXT CHECK(currency IN ('THB', 'USD')) NOT NULL,
    fx_used REAL CHECK(fx_used > 0),
    amount_thb REAL CHECK(amount_thb > 0) NOT NULL,
    reference_no TEXT,
    shipment_document_link_id TEXT REFERENCES shipment_document_links(link_id) ON DELETE SET NULL,
    remark TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (
        (currency = 'THB' AND fx_used IS NULL)
        OR
        (currency = 'USD' AND fx_used IS NOT NULL AND fx_used > 0)
    )
);

-- Seed default expense categories
INSERT INTO expense_categories (category_id, category_code, category_name, category_group, status, sort_order) VALUES
('CAT-OCEAN', 'OCEAN_FREIGHT_COST', 'Ocean Freight', 'OCEAN_FREIGHT', 'ACTIVE', 10),
('CAT-BL', 'BL_FEE', 'BL Fee', 'SHIPPING_LOCAL', 'ACTIVE', 20),
('CAT-THC', 'THC_FEE', 'THC', 'SHIPPING_LOCAL', 'ACTIVE', 30),
('CAT-SEAL', 'SEAL_FEE', 'Seal Fee', 'SHIPPING_LOCAL', 'ACTIVE', 40),
('CAT-OTHER-LOCAL', 'OTHER_LOCAL_CHARGE', 'Other Shipping / Local Charge', 'SHIPPING_LOCAL', 'ACTIVE', 50),
('CAT-TRUCK', 'INLAND_TRANSPORT', 'Truck / Inland Transport', 'TRANSPORT', 'ACTIVE', 60),
('CAT-DOC', 'DOCUMENTATION', 'Documentation', 'DOCUMENT', 'ACTIVE', 70),
('CAT-FUM', 'FUMIGATION', 'Fumigation', 'DOCUMENT', 'ACTIVE', 80),
('CAT-INSP', 'INSPECTION', 'Inspection', 'DOCUMENT', 'ACTIVE', 90),
('CAT-INS', 'INSURANCE', 'Insurance', 'INSURANCE', 'ACTIVE', 100),
('CAT-BANK', 'BANK_CHARGE', 'Bank Charge', 'OTHER', 'ACTIVE', 110),
('CAT-OTHER', 'OTHER_COST', 'Other', 'OTHER', 'ACTIVE', 120);
