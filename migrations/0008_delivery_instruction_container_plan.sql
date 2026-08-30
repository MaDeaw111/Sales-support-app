ALTER TABLE delivery_instructions
  ADD COLUMN container_plan TEXT NOT NULL DEFAULT '[]';
