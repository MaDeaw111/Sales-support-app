PRAGMA foreign_keys = ON;

CREATE TABLE service_partners (
  partner_id TEXT PRIMARY KEY,
  partner_type TEXT NOT NULL CHECK(partner_type IN ('FORWARDER','SHIPPING_LINE','TRUCKING','SURVEYOR')),
  partner_name TEXT NOT NULL CHECK(trim(partner_name) <> ''),
  contact_name TEXT,
  contact_phone TEXT,
  contact_email TEXT,
  address TEXT,
  tax_id TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','INACTIVE')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE delivery_instructions (
  di_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  po_id TEXT NOT NULL REFERENCES po_headers(po_id),
  po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id),
  di_no TEXT NOT NULL CHECK(trim(di_no) <> ''),
  surveyor_partner_id TEXT REFERENCES service_partners(partner_id),
  forwarder_partner_id TEXT REFERENCES service_partners(partner_id),
  di_drive_url TEXT,
  shipping_month TEXT NOT NULL,
  shipping_period TEXT NOT NULL CHECK(shipping_period IN ('FIRST_HALF','SECOND_HALF')),
  status TEXT NOT NULL DEFAULT 'DRAFT' CHECK(status IN ('DRAFT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED')),
  lifecycle_version INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_version >= 0),
  note TEXT,
  cancellation_note TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(customer_id, di_no)
);

CREATE TABLE delivery_instruction_lines (
  di_line_id TEXT PRIMARY KEY,
  di_id TEXT NOT NULL REFERENCES delivery_instructions(di_id) ON DELETE CASCADE,
  po_id TEXT NOT NULL REFERENCES po_headers(po_id),
  po_revision_id TEXT NOT NULL REFERENCES po_revisions(revision_id),
  po_revision_line_id TEXT NOT NULL REFERENCES po_revision_lines(line_id),
  product_id TEXT NOT NULL REFERENCES products(product_id),
  planned_qty_mt REAL NOT NULL CHECK(planned_qty_mt > 0),
  packing_snapshot TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(di_id, po_revision_line_id)
);

CREATE TABLE phase6_shipments (
  shipment_id TEXT PRIMARY KEY,
  di_id TEXT NOT NULL UNIQUE REFERENCES delivery_instructions(di_id),
  status TEXT NOT NULL CHECK(status IN ('PLANNING','BOOKED','LOADED','DOCS_SENT','COMPLETED','CANCELLED')) DEFAULT 'PLANNING',
  booking_no TEXT,
  forwarder_partner_id TEXT REFERENCES service_partners(partner_id),
  shipping_line_partner_id TEXT REFERENCES service_partners(partner_id),
  trucking_partner_id TEXT REFERENCES service_partners(partner_id),
  vessel TEXT,
  etd TEXT,
  eta TEXT,
  planned_loading_date TEXT,
  actual_loading_date TEXT,
  schedule_result TEXT CHECK(schedule_result IN ('ON_PLAN','OUT_OF_PLAN')),
  schedule_note TEXT,
  all_ship_docs_drive_url TEXT,
  digital_docs_sent_date TEXT,
  original_docs_required INTEGER NOT NULL DEFAULT 0 CHECK(original_docs_required IN (0,1)),
  dhl_sent_date TEXT,
  dhl_tracking_no TEXT,
  docs_note TEXT,
  cash_received_amount REAL NOT NULL DEFAULT 0 CHECK(cash_received_amount >= 0),
  payment_status TEXT NOT NULL CHECK(payment_status IN ('UNPAID','PARTIAL','PAID')) DEFAULT 'UNPAID',
  payment_note TEXT,
  cancellation_note TEXT,
  container_version INTEGER NOT NULL DEFAULT 0 CHECK(container_version >= 0),
  container_write_token TEXT,
  final_invoice_version INTEGER NOT NULL DEFAULT 0 CHECK(final_invoice_version >= 0),
  final_invoice_write_token TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shipment_containers (
  container_id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES phase6_shipments(shipment_id) ON DELETE CASCADE,
  container_no TEXT NOT NULL CHECK(trim(container_no) <> ''),
  container_type TEXT CHECK(container_type IN ('20GP','40GP','40HC','OTHER')),
  seal_no TEXT,
  loading_date TEXT,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK(status IN ('PLANNED','LOADED','CANCELLED')),
  note TEXT,
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shipment_id, container_no)
);

CREATE TABLE shipment_container_lines (
  container_line_id TEXT PRIMARY KEY,
  container_id TEXT NOT NULL REFERENCES shipment_containers(container_id) ON DELETE CASCADE,
  delivery_instruction_line_id TEXT NOT NULL REFERENCES delivery_instruction_lines(di_line_id),
  number_of_bags INTEGER NOT NULL CHECK(number_of_bags > 0),
  qty_mt REAL NOT NULL CHECK(qty_mt > 0),
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(container_id, delivery_instruction_line_id)
);

CREATE TABLE shipment_invoices (
  invoice_id TEXT PRIMARY KEY,
  shipment_id TEXT NOT NULL REFERENCES phase6_shipments(shipment_id) ON DELETE CASCADE,
  invoice_no TEXT NOT NULL CHECK(trim(invoice_no) <> ''),
  invoice_date TEXT NOT NULL,
  currency TEXT NOT NULL CHECK(currency IN ('USD','THB','EUR')),
  version TEXT NOT NULL CHECK(version IN ('PRELIMINARY','FINAL')),
  invoice_version INTEGER NOT NULL DEFAULT 0 CHECK(invoice_version >= 0),
  invoice_write_token TEXT NOT NULL,
  final_container_version INTEGER CHECK(final_container_version >= 0),
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(shipment_id, invoice_no),
  CHECK((version = 'PRELIMINARY' AND final_container_version IS NULL) OR (version = 'FINAL' AND final_container_version IS NOT NULL))
);

CREATE TABLE shipment_invoice_lines (
  invoice_line_id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES shipment_invoices(invoice_id) ON DELETE CASCADE,
  po_revision_line_id TEXT NOT NULL REFERENCES po_revision_lines(line_id),
  qty_mt REAL NOT NULL CHECK(qty_mt > 0),
  unit_price_snapshot REAL NOT NULL CHECK(unit_price_snapshot >= 0),
  currency TEXT NOT NULL CHECK(currency IN ('USD','THB','EUR')),
  line_amount REAL NOT NULL CHECK(line_amount >= 0),
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT REFERENCES users(user_id),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(invoice_id, po_revision_line_id)
);

CREATE TABLE customer_credits (
  credit_id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(customer_id),
  amount REAL NOT NULL CHECK(amount > 0),
  reason TEXT NOT NULL CHECK(trim(reason) <> ''),
  remaining_amount REAL NOT NULL CHECK(remaining_amount >= 0 AND remaining_amount <= amount),
  created_by TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customer_credit_usages (
  credit_usage_id TEXT PRIMARY KEY,
  credit_id TEXT NOT NULL REFERENCES customer_credits(credit_id),
  shipment_id TEXT NOT NULL REFERENCES phase6_shipments(shipment_id),
  invoice_id TEXT REFERENCES shipment_invoices(invoice_id),
  amount REAL NOT NULL CHECK(amount > 0),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shipment_audit_events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK(entity_type IN ('DI','SHIPMENT','INVOICE','CREDIT','DOCUMENT')),
  entity_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('DI_CREATED','DI_UPDATED','DI_CONFIRMED','DI_CANCELLED','SHIPMENT_CREATED','SHIPMENT_UPDATED','STATUS_CHANGED','BOOKING_RECORDED','PLANNED_LOADING_DATE_UPDATED','ACTUAL_LOADING_DATE_RECORDED','CONTAINER_ADDED','CONTAINER_UPDATED','INVOICE_RECORDED','INVOICE_FINALIZED','CUSTOMER_CREDIT_CREATED','CUSTOMER_CREDIT_USED','PAYMENT_UPDATED','DOCUMENTS_SENT','DOCS_EMAIL_SENT','DOCS_DHL_SENT','SHIPMENT_CANCELLED')),
  actor_id TEXT NOT NULL REFERENCES users(user_id),
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_delivery_instructions_di_no ON delivery_instructions(di_no);
CREATE INDEX idx_delivery_instructions_customer_status ON delivery_instructions(customer_id, status);
CREATE INDEX idx_delivery_instructions_customer_history ON delivery_instructions(customer_id, status, created_at DESC);
CREATE INDEX idx_delivery_instruction_lines_po_line ON delivery_instruction_lines(po_id, po_revision_id, po_revision_line_id);
CREATE INDEX idx_phase6_shipments_status ON phase6_shipments(status);
CREATE INDEX idx_phase6_shipments_booking_no ON phase6_shipments(booking_no);
CREATE INDEX idx_shipment_invoices_invoice_no ON shipment_invoices(invoice_no);
CREATE INDEX idx_shipment_containers_container_no ON shipment_containers(container_no);
CREATE INDEX idx_shipment_audit_events_entity_created_at ON shipment_audit_events(entity_type, entity_id, created_at);
