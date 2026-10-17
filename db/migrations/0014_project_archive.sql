ALTER TABLE creative_projects ADD COLUMN archived_at timestamptz;
ALTER TABLE creative_projects ADD COLUMN archived_by text;
CREATE INDEX creative_projects_active_updated_idx ON creative_projects(updated_at DESC) WHERE archived_at IS NULL;