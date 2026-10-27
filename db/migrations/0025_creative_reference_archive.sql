-- Reversible removal of winning creatives from Winner Analysis; archived rows stay for audit and restore.
ALTER TABLE creative_references ADD COLUMN archived_at timestamptz;
ALTER TABLE creative_references ADD COLUMN archived_by text;
