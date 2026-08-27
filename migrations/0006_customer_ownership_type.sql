PRAGMA foreign_keys = ON;

ALTER TABLE customers ADD COLUMN ownership_type TEXT DEFAULT 'HOUSE_ACCOUNT' CHECK (ownership_type IN ('ASSIGNED_SALES', 'HOUSE_ACCOUNT'));

UPDATE customers SET ownership_type = 'ASSIGNED_SALES' WHERE owner_user_id IS NOT NULL AND owner_user_id <> '';

CREATE TRIGGER IF NOT EXISTS trg_customers_ownership_type_insert
AFTER INSERT ON customers
FOR EACH ROW
WHEN (NEW.ownership_type IS NULL OR NEW.ownership_type = 'HOUSE_ACCOUNT') AND NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id <> ''
BEGIN
  UPDATE customers SET ownership_type = 'ASSIGNED_SALES' WHERE customer_id = NEW.customer_id;
END;

CREATE TRIGGER IF NOT EXISTS trg_customers_ownership_type_update
AFTER UPDATE OF owner_user_id ON customers
FOR EACH ROW
WHEN NEW.owner_user_id IS NOT NULL AND NEW.owner_user_id <> ''
BEGIN
  UPDATE customers SET ownership_type = 'ASSIGNED_SALES' WHERE customer_id = NEW.customer_id;
END;
