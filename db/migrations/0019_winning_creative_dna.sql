CREATE TABLE creative_references (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
  source_project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  product_id uuid REFERENCES products(id) ON DELETE RESTRICT,
  source_asset_id uuid NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
  operator_status text NOT NULL CHECK (operator_status IN ('WINNER','CONTROL','REFERENCE','LOSER')),
  operator_notes text,
  operator_transcript text,
  date_start date,
  date_end date,
  platform text,
  performance_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  analysis_status text NOT NULL DEFAULT 'NOT_ANALYZED' CHECK (analysis_status IN ('NOT_ANALYZED','ANALYZING','DRAFT','APPROVED','ARCHIVED','FAILED','SUBMISSION_UNKNOWN','RESULT_UNAVAILABLE')),
  approved_revision_id uuid,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CHECK (date_start IS NULL OR date_end IS NULL OR date_start <= date_end)
);
CREATE INDEX creative_references_product_status_idx ON creative_references(product_id, operator_status, created_at DESC);

CREATE TABLE creative_dna_revisions (
  id uuid PRIMARY KEY,
  creative_reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  status text NOT NULL CHECK (status IN ('DRAFT','APPROVED','ARCHIVED')),
  source text NOT NULL CHECK (source IN ('OPENAI','OPERATOR_EDIT')),
  dna_profile jsonb NOT NULL,
  media_metadata jsonb NOT NULL,
  source_evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  operator_notes text,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(creative_reference_id, revision)
);
ALTER TABLE creative_references ADD CONSTRAINT creative_references_approved_revision_fk FOREIGN KEY (approved_revision_id) REFERENCES creative_dna_revisions(id) ON DELETE RESTRICT;
CREATE INDEX creative_dna_revisions_reference_idx ON creative_dna_revisions(creative_reference_id, revision DESC);
CREATE UNIQUE INDEX creative_dna_one_approved_idx ON creative_dna_revisions(creative_reference_id) WHERE status='APPROVED';

CREATE TABLE creative_dna_provider_operations (
  id uuid PRIMARY KEY,
  creative_reference_id uuid NOT NULL REFERENCES creative_references(id) ON DELETE RESTRICT,
  operation_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTING','POLLING','SUCCEEDED','FAILED','SUBMISSION_UNKNOWN','RESULT_UNAVAILABLE')),
  response_id text,
  model text,
  submitted_at timestamptz,
  latest_provider_status text CHECK (latest_provider_status IS NULL OR latest_provider_status IN ('queued','in_progress','completed','failed','cancelled','incomplete')),
  latest_poll_at timestamptz,
  terminal_at timestamptz,
  result_sha256 char(64),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb,
  failure_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX creative_dna_operations_reference_idx ON creative_dna_provider_operations(creative_reference_id, created_at DESC);
CREATE INDEX creative_dna_operations_status_idx ON creative_dna_provider_operations(status, updated_at);

ALTER TABLE creative_projects ADD COLUMN winner_creative_reference_id uuid REFERENCES creative_references(id) ON DELETE RESTRICT;
ALTER TABLE creative_projects ADD COLUMN winner_dna_revision_id uuid REFERENCES creative_dna_revisions(id) ON DELETE RESTRICT;
ALTER TABLE creative_strategy_handoffs ADD COLUMN winner_dna_revision_id uuid REFERENCES creative_dna_revisions(id) ON DELETE RESTRICT;

ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_type_check CHECK (type IN ('GENERATE_SCENE','GENERATE_VOICE','COMPOSE_RENDER','GENERATE_STRATEGY','REPLACE_STRATEGY','ANALYZE_CREATIVE_DNA'));

ALTER TABLE usage_costs DROP CONSTRAINT usage_costs_operation_type_check;
ALTER TABLE usage_costs ADD CONSTRAINT usage_costs_operation_type_check CHECK (operation_type IN ('CONCEPT','VIDEO','VOICE','COMPOSITION','STRATEGY','CREATIVE_DNA'));
