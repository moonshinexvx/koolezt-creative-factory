-- Winner-to-video app: winners belong to a Product (no campaign), plans and videos are generated from them,
-- and background work runs through one small job table processed one job at a time by the worker.
ALTER TABLE creative_references ALTER COLUMN source_project_id DROP NOT NULL;

CREATE TABLE winner_jobs (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('ANALYZE_WINNER','WRITE_VIDEO_PLANS','RENDER_VIDEO')),
  target_id uuid NOT NULL,
  operation_key text NOT NULL UNIQUE CHECK (char_length(operation_key) <= 200),
  status text NOT NULL CHECK (status IN ('PENDING','RUNNING','COMPLETED','FAILED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  last_error text CHECK (last_error IS NULL OR char_length(last_error) <= 500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX winner_jobs_due_idx ON winner_jobs (status, next_attempt_at, created_at);
CREATE INDEX winner_jobs_target_idx ON winner_jobs (target_id, created_at DESC);

CREATE TABLE winner_video_batches (
  id uuid PRIMARY KEY,
  creative_reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  requested_count integer NOT NULL CHECK (requested_count IN (3, 6, 12)),
  target_duration_ms integer NOT NULL CHECK (target_duration_ms IN (15000, 30000)),
  status text NOT NULL CHECK (status IN ('WRITING','READY','FAILED')),
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) <= 500),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX winner_video_batches_reference_idx ON winner_video_batches (creative_reference_id, created_at DESC);

CREATE TABLE winner_videos (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES winner_video_batches(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 12),
  plan jsonb NOT NULL CHECK (jsonb_typeof(plan) = 'object'),
  status text NOT NULL CHECK (status IN ('PLANNED','QUEUED','RENDERING','READY','FAILED')),
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  duration_ms integer,
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) <= 500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (batch_id, ordinal)
);
CREATE INDEX winner_videos_status_idx ON winner_videos (status, updated_at DESC);
