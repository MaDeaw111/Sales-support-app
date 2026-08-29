ALTER TABLE delivery_instructions ADD COLUMN surveyor_partner_id TEXT REFERENCES service_partners(partner_id);
ALTER TABLE delivery_instructions ADD COLUMN forwarder_partner_id TEXT REFERENCES service_partners(partner_id);
ALTER TABLE delivery_instructions ADD COLUMN di_drive_url TEXT;

CREATE INDEX idx_delivery_instructions_customer_history
  ON delivery_instructions(customer_id, status, created_at DESC);
