CREATE TABLE desktop_render_jobs (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  render_id uuid NOT NULL REFERENCES renders(id) ON DELETE RESTRICT,
  operation_key text NOT NULL UNIQUE,
  protocol_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('WAITING', 'CLAIMED', 'RENDERING', 'UPLOADING', 'SUCCEEDED', 'FAILED')),
  input_snapshot jsonb NOT NULL,
  worker_id text,
  lease_token_hash char(64),
  lease_expires_at timestamptz,
  progress_stage text,
  progress_percent integer CHECK (progress_percent IS NULL OR progress_percent BETWEEN 0 AND 100),
  encoder text,
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  output_sha256 char(64),
  failure_code text,
  failure_message text,
  claimed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (render_id)
);

CREATE INDEX desktop_render_jobs_claim_idx
  ON desktop_render_jobs (state, lease_expires_at, created_at);
