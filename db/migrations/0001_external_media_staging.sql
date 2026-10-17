CREATE TABLE external_media_staging (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  operation_id text NOT NULL,
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  backend text NOT NULL,
  bucket text NOT NULL,
  object_key text NOT NULL,
  content_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 char(64) NOT NULL,
  state text NOT NULL CHECK (state IN ('STAGING','AVAILABLE','CLEANUP_PENDING','CLEANED','FAILED')),
  expires_at timestamptz NOT NULL,
  cleanup_attempts integer NOT NULL DEFAULT 0,
  cleanup_next_attempt_at timestamptz,
  cleaned_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (operation_id, asset_id, sha256)
);
CREATE INDEX external_media_staging_cleanup_idx ON external_media_staging (state, cleanup_next_attempt_at, expires_at);
CREATE INDEX external_media_staging_project_operation_idx ON external_media_staging (project_id, operation_id);
