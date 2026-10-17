CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE SEQUENCE IF NOT EXISTS project_number_sequence AS bigint START WITH 1;

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  storage_provider text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('VIDEO', 'AUDIO', 'RENDER', 'IMAGE')),
  mime_type text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size >= 0),
  sha256 char(64) NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'AVAILABLE' CHECK (status IN ('UPLOADING', 'AVAILABLE', 'QUARANTINED', 'MISSING', 'DELETED')),
  original_filename text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX media_assets_sha256_size_idx ON media_assets (sha256, byte_size);

CREATE TABLE products (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  description text NOT NULL,
  default_cta text NOT NULL,
  creative_notes text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE product_claims (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('FEATURE', 'SELLING_POINT', 'RESTRICTION')),
  text text NOT NULL,
  position integer NOT NULL CHECK (position >= 0),
  UNIQUE (product_id, kind, position)
);

CREATE INDEX product_claims_product_kind_idx ON product_claims (product_id, kind);

CREATE TABLE product_assets (
  id uuid PRIMARY KEY,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  media_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('IMAGE', 'VIDEO')),
  label text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (product_id, storage_key)
);

CREATE TABLE creative_projects (
  id uuid PRIMARY KEY,
  project_number bigint NOT NULL UNIQUE,
  public_id text NOT NULL UNIQUE,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  state text NOT NULL CHECK (state IN ('DRAFT', 'CONCEPT_GENERATING', 'CONCEPT_REVIEW', 'CONCEPT_APPROVED', 'SCENES_GENERATING', 'SCENES_REVIEW', 'SCENES_APPROVED', 'VOICE_GENERATING', 'COMPOSITION_PENDING', 'RENDERING', 'FINAL_REVIEW', 'SAVING', 'READY', 'FAILED')),
  additional_instructions text NOT NULL DEFAULT '',
  preferred_voice_profile_id text NOT NULL,
  current_concept_id uuid,
  current_voice_generation_id uuid,
  current_render_id uuid,
  ready_path text,
  ready_sha256 char(64),
  ready_byte_size bigint,
  ready_at timestamptz,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX creative_projects_state_updated_idx ON creative_projects (state, updated_at DESC);
CREATE INDEX creative_projects_product_created_idx ON creative_projects (product_id, created_at DESC);

CREATE TABLE creative_project_assets (
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  product_asset_id uuid NOT NULL REFERENCES product_assets(id) ON DELETE RESTRICT,
  role text NOT NULL DEFAULT 'REFERENCE',
  selected_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, product_asset_id)
);

CREATE TABLE creative_project_snapshots (
  project_id uuid PRIMARY KEY REFERENCES creative_projects(id) ON DELETE RESTRICT,
  aggregate jsonb NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE creative_concepts (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  source text NOT NULL CHECK (source IN ('PROVIDER', 'USER_EDIT')),
  status text NOT NULL CHECK (status IN ('REVIEW', 'APPROVED', 'SUPERSEDED')),
  angle text NOT NULL,
  hook text NOT NULL,
  target_duration_ms integer NOT NULL CHECK (target_duration_ms > 0),
  voice_script text NOT NULL,
  cta text NOT NULL,
  editing_style_key text NOT NULL,
  music_category text NOT NULL,
  input_snapshot jsonb NOT NULL,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  concept_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, revision)
);

CREATE TABLE concept_scene_specs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concept_id uuid NOT NULL REFERENCES creative_concepts(id) ON DELETE RESTRICT,
  scene_number integer NOT NULL CHECK (scene_number > 0),
  duration_ms integer NOT NULL CHECK (duration_ms > 0),
  purpose text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('KLING_VIDEO', 'UPLOADED_VIDEO', 'PRODUCT_IMAGE', 'EXISTING_ASSET')),
  generation_prompt text NOT NULL,
  overlay_text text NOT NULL,
  accuracy_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  spec_json jsonb NOT NULL,
  UNIQUE (concept_id, scene_number)
);

CREATE TABLE concept_scene_reference_assets (
  scene_spec_id uuid NOT NULL REFERENCES concept_scene_specs(id) ON DELETE RESTRICT,
  product_asset_id uuid NOT NULL REFERENCES product_assets(id) ON DELETE RESTRICT,
  position integer NOT NULL DEFAULT 0,
  PRIMARY KEY (scene_spec_id, product_asset_id)
);

CREATE TABLE creative_scenes (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  scene_number integer NOT NULL CHECK (scene_number > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'GENERATING', 'REVIEW', 'ACCEPTED', 'FAILED')),
  approved_attempt_id uuid,
  scene_json jsonb NOT NULL,
  UNIQUE (project_id, scene_number)
);

CREATE TABLE provider_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('CONCEPT', 'VIDEO', 'VOICE', 'COMPOSITION')),
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  scene_attempt_id uuid,
  voice_generation_id uuid,
  render_id uuid,
  external_task_id text UNIQUE,
  provider_task_id text UNIQUE,
  provider_request_id text,
  state text NOT NULL CHECK (state IN ('PENDING_SUBMISSION', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'SUBMISSION_UNKNOWN')),
  request_fingerprint char(64) NOT NULL,
  request_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  response_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  submission_attempts integer NOT NULL DEFAULT 0,
  next_poll_at timestamptz,
  lease_expires_at timestamptz,
  last_error_code text,
  last_error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  completed_at timestamptz,
  CHECK (num_nonnulls(scene_attempt_id, voice_generation_id, render_id) <= 1)
);

CREATE INDEX provider_jobs_due_idx ON provider_jobs (state, next_poll_at);

CREATE TABLE scene_attempts (
  id uuid PRIMARY KEY,
  scene_id uuid NOT NULL REFERENCES creative_scenes(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  source_type text NOT NULL CHECK (source_type IN ('KLING_VIDEO', 'UPLOADED_VIDEO', 'PRODUCT_IMAGE', 'EXISTING_ASSET')),
  concept_scene_number integer NOT NULL CHECK (concept_scene_number > 0),
  prompt text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'REVIEW', 'ACCEPTED', 'REJECTED', 'FAILED', 'CANCELLED')),
  operation_key text NOT NULL UNIQUE,
  input_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  provider_job_id uuid REFERENCES provider_jobs(id) ON DELETE RESTRICT,
  provider_task_id text,
  replaces_attempt_id uuid REFERENCES scene_attempts(id) ON DELETE RESTRICT,
  failure_message text,
  attempt_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (scene_id, attempt_number)
);

CREATE INDEX scene_attempts_scene_status_idx ON scene_attempts (scene_id, status);

CREATE TABLE voice_profiles (
  id text PRIMARY KEY,
  provider text NOT NULL,
  provider_voice_id text NOT NULL,
  display_name text NOT NULL,
  category text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  UNIQUE (provider, provider_voice_id)
);

CREATE TABLE voice_generations (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  voice_profile_id text NOT NULL,
  source_script text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  operation_key text NOT NULL UNIQUE,
  provider_task_id text,
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  voice_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, attempt_number)
);

CREATE TABLE composition_styles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  style_key text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  name text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  configuration jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (style_key, version)
);

CREATE TABLE music_assets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  media_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  name text NOT NULL,
  category text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  licensing_metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE renders (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  attempt_number integer NOT NULL CHECK (attempt_number > 0),
  status text NOT NULL CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'QA_FAILED', 'FAILED')),
  operation_key text NOT NULL UNIQUE,
  voice_generation_id uuid NOT NULL REFERENCES voice_generations(id) ON DELETE RESTRICT,
  composition_style_key text NOT NULL,
  cta text NOT NULL,
  provider_task_id text,
  output_asset_id uuid REFERENCES media_assets(id) ON DELETE RESTRICT,
  output_sha256 char(64),
  render_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, attempt_number)
);

CREATE TABLE render_scene_inputs (
  render_id uuid NOT NULL REFERENCES renders(id) ON DELETE RESTRICT,
  scene_id uuid NOT NULL REFERENCES creative_scenes(id) ON DELETE RESTRICT,
  scene_attempt_id uuid NOT NULL REFERENCES scene_attempts(id) ON DELETE RESTRICT,
  position integer NOT NULL CHECK (position >= 0),
  PRIMARY KEY (render_id, position),
  UNIQUE (render_id, scene_id)
);

CREATE TABLE media_inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  inspector_version text NOT NULL,
  passed boolean NOT NULL,
  width integer NOT NULL,
  height integer NOT NULL,
  duration_ms integer NOT NULL,
  video_codec text NOT NULL,
  audio_codec text,
  has_video boolean NOT NULL,
  has_audio boolean NOT NULL,
  byte_size bigint NOT NULL,
  rules jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_costs (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  model text NOT NULL,
  operation_type text NOT NULL CHECK (operation_type IN ('CONCEPT', 'VIDEO', 'VOICE', 'COMPOSITION')),
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  scene_id uuid REFERENCES creative_scenes(id) ON DELETE RESTRICT,
  provider_request_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ESTIMATED', 'REPORTED', 'FINAL', 'UNAVAILABLE')),
  estimated_cost numeric(14, 6),
  actual_cost numeric(14, 6),
  currency char(3) NOT NULL,
  cost_json jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE (provider, provider_request_id, operation_type)
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  stage text NOT NULL CHECK (stage IN ('CONCEPT', 'SCENE', 'FINAL', 'READY_SAVE')),
  target_id uuid NOT NULL,
  target_sha256 char(64),
  decision text NOT NULL CHECK (decision IN ('APPROVED', 'REJECTED')),
  actor text NOT NULL,
  note text,
  created_at timestamptz NOT NULL
);

CREATE INDEX approvals_project_stage_idx ON approvals (project_id, stage, created_at DESC);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  actor text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL
);

CREATE INDEX audit_events_project_created_idx ON audit_events (project_id, created_at DESC);

CREATE TABLE workflow_jobs (
  id uuid PRIMARY KEY,
  dedupe_key text NOT NULL UNIQUE,
  type text NOT NULL CHECK (type IN ('GENERATE_SCENE', 'GENERATE_VOICE', 'COMPOSE_RENDER')),
  project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  target_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX workflow_jobs_project_status_idx ON workflow_jobs (project_id, status, created_at);

CREATE TABLE workflow_outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  workflow_job_id uuid NOT NULL REFERENCES workflow_jobs(id) ON DELETE RESTRICT,
  topic text NOT NULL,
  payload jsonb NOT NULL,
  available_at timestamptz NOT NULL DEFAULT now(),
  dispatch_attempts integer NOT NULL DEFAULT 0,
  dispatch_lease_until timestamptz,
  dispatched_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX workflow_outbox_ready_idx ON workflow_outbox (available_at, dispatch_lease_until, created_at) WHERE dispatched_at IS NULL;
