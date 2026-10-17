ALTER TABLE creative_projects DROP CONSTRAINT creative_projects_state_check;
ALTER TABLE creative_projects ADD CONSTRAINT creative_projects_state_check
  CHECK (state IN ('DRAFT', 'CONCEPT_GENERATING', 'CONCEPT_REVIEW', 'CONCEPT_APPROVED', 'SCENES_GENERATING', 'SCENES_REVIEW', 'SCENES_APPROVED', 'VOICE_REVIEW', 'VOICE_GENERATING', 'READY_FOR_RENDER', 'COMPOSITION_PENDING', 'RENDERING', 'FINAL_REVIEW', 'OWNER_REVIEW', 'SAVING', 'READY', 'FAILED'));

CREATE TABLE render_workers (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  machine_name text,
  worker_version text NOT NULL,
  protocol_version text NOT NULL,
  encoders jsonb NOT NULL DEFAULT '[]'::jsonb,
  runtime_state text NOT NULL DEFAULT 'OFFLINE' CHECK (runtime_state IN ('OFFLINE','IDLE','BUSY')),
  last_seen_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE render_worker_enrollments (
  id uuid PRIMARY KEY,
  code_hash text NOT NULL UNIQUE,
  display_name text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX render_workers_last_seen_idx ON render_workers (last_seen_at DESC);
CREATE INDEX render_worker_enrollments_expiry_idx ON render_worker_enrollments (expires_at) WHERE used_at IS NULL;