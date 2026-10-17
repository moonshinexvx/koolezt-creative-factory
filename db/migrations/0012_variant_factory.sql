CREATE TABLE variant_batches (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  batch_sequence integer NOT NULL,
  operation_key text NOT NULL UNIQUE,
  created_by text NOT NULL,
  recipe_version text NOT NULL,
  source_snapshot jsonb NOT NULL,
  source_snapshot_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PLANNED','QUEUED','RENDERING','PARTIAL','READY','FAILED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,batch_sequence)
);
CREATE TABLE creative_variants (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES variant_batches(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 12),
  public_id text NOT NULL UNIQUE,
  recipe jsonb NOT NULL,
  recipe_hash char(64) NOT NULL UNIQUE,
  opening_scene integer NOT NULL CHECK (opening_scene BETWEEN 1 AND 3),
  treatment_family text NOT NULL,
  hook text NOT NULL,
  cta text NOT NULL,
  status text NOT NULL CHECK (status IN ('QUEUED','CLAIMED','RENDERING','READY','FAILED')),
  retry_count integer NOT NULL DEFAULT 0,
  render_job_id uuid,
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  output_sha256 char(64),
  inspection jsonb,
  failure_message text,
  delete_after timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id,ordinal)
);
ALTER TABLE desktop_render_jobs ADD COLUMN variant_id uuid REFERENCES creative_variants(id) ON DELETE RESTRICT;
ALTER TABLE desktop_render_jobs ADD COLUMN required_capability text;
ALTER TABLE render_workers ADD COLUMN capabilities jsonb NOT NULL DEFAULT '["standard-render-v1"]'::jsonb;
CREATE INDEX creative_variants_batch_status_idx ON creative_variants(batch_id,status,ordinal);
CREATE INDEX desktop_render_jobs_variant_idx ON desktop_render_jobs(variant_id);
ALTER TABLE desktop_render_jobs ALTER COLUMN render_id DROP NOT NULL;
