CREATE TABLE variant_creative_packages (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  package_slot char(1) NOT NULL CHECK (package_slot IN ('A','B','C','D')),
  current_revision_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id, package_slot)
);

CREATE TABLE variant_creative_package_revisions (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL REFERENCES variant_creative_packages(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision >= 1),
  angle_name text NOT NULL,
  hook text NOT NULL CHECK (char_length(hook) BETWEEN 1 AND 160),
  narration_text text NOT NULL CHECK (char_length(narration_text) BETWEEN 1 AND 10000),
  cta text NOT NULL CHECK (char_length(cta) BETWEEN 1 AND 160),
  secondary_overlay text,
  source text NOT NULL CHECK (source IN ('MANUAL','OPENAI')),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(package_id, revision)
);
ALTER TABLE variant_creative_packages
  ADD CONSTRAINT variant_creative_packages_current_revision_fk
  FOREIGN KEY (current_revision_id) REFERENCES variant_creative_package_revisions(id) ON DELETE RESTRICT;

CREATE TABLE variant_package_voices (
  id uuid PRIMARY KEY,
  package_revision_id uuid NOT NULL REFERENCES variant_creative_package_revisions(id) ON DELETE RESTRICT,
  narration_sha256 char(64) NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  voice_preset text NOT NULL,
  audio_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  checksum char(64),
  duration_ms integer,
  status text NOT NULL CHECK (status IN ('PENDING','REVIEW','ACCEPTED','REJECTED','STALE','FAILED')),
  provider_task_id text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  failure_message text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX variant_creative_packages_project_idx ON variant_creative_packages(project_id, package_slot);
CREATE INDEX variant_creative_package_revisions_package_idx ON variant_creative_package_revisions(package_id, revision DESC);
CREATE INDEX variant_package_voices_revision_idx ON variant_package_voices(package_revision_id, status, created_at DESC);