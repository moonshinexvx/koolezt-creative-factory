ALTER TABLE media_assets
  ADD COLUMN project_id uuid REFERENCES creative_projects(id) ON DELETE RESTRICT,
  ADD COLUMN storage_bucket text,
  ADD COLUMN purpose text,
  ADD COLUMN lifecycle_status text NOT NULL DEFAULT 'AVAILABLE',
  ADD COLUMN delete_after timestamptz,
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN lifecycle_error text,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_lifecycle_status_check
  CHECK (lifecycle_status IN ('PENDING_UPLOAD', 'AVAILABLE', 'FAILED', 'CLEANUP_PENDING', 'CLEANED'));

CREATE INDEX media_assets_project_created_idx
  ON media_assets (project_id, created_at DESC);

CREATE INDEX media_assets_cleanup_due_idx
  ON media_assets (lifecycle_status, delete_after)
  WHERE storage_provider = 's3';

-- Existing local media remains readable and is deliberately not scheduled.
UPDATE media_assets
SET lifecycle_status = 'AVAILABLE', updated_at = created_at
WHERE storage_provider = 'local';

ALTER TABLE desktop_render_jobs
  ADD COLUMN output_upload_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT;