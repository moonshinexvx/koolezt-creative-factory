ALTER TABLE variant_batches ADD COLUMN archived_at timestamptz;
ALTER TABLE variant_batches ADD COLUMN archived_by text;
CREATE INDEX variant_batches_active_project_idx ON variant_batches(project_id,batch_sequence DESC) WHERE archived_at IS NULL;