CREATE TABLE creative_strategy_batches (
  id uuid PRIMARY KEY,
  source_project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  product_id uuid NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  requested_count integer NOT NULL DEFAULT 12 CHECK (requested_count = 12),
  operation_key text NOT NULL UNIQUE,
  input_snapshot jsonb NOT NULL,
  history_snapshot jsonb NOT NULL DEFAULT '[]'::jsonb,
  history_sha256 char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','GENERATING','VALIDATING','REVIEW','REVIEW_WITH_ISSUES','HANDED_OFF','FAILED','SUBMISSION_UNKNOWN')),
  provider_request_count integer NOT NULL DEFAULT 0 CHECK (provider_request_count >= 0),
  automatic_repair_attempted boolean NOT NULL DEFAULT false,
  validation_summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider_metadata jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX creative_strategy_batches_project_idx ON creative_strategy_batches(source_project_id, created_at DESC);
CREATE INDEX creative_strategy_batches_product_idx ON creative_strategy_batches(product_id, created_at DESC);

CREATE TABLE creative_strategy_concepts (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES creative_strategy_batches(id) ON DELETE RESTRICT,
  ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 12),
  current_revision_id uuid,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SELECTED','HANDED_OFF')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE(batch_id, ordinal)
);

CREATE TABLE creative_strategy_concept_revisions (
  id uuid PRIMARY KEY,
  concept_id uuid NOT NULL REFERENCES creative_strategy_concepts(id) ON DELETE RESTRICT,
  batch_id uuid NOT NULL REFERENCES creative_strategy_batches(id) ON DELETE RESTRICT,
  revision integer NOT NULL CHECK (revision > 0),
  concept_name text NOT NULL CHECK (char_length(concept_name) BETWEEN 1 AND 120),
  concept_family text NOT NULL CHECK (char_length(concept_family) BETWEEN 1 AND 80),
  buyer_persona text NOT NULL CHECK (char_length(buyer_persona) BETWEEN 1 AND 160),
  customer_desire_or_problem text NOT NULL CHECK (char_length(customer_desire_or_problem) BETWEEN 1 AND 500),
  awareness_level text NOT NULL CHECK (char_length(awareness_level) BETWEEN 1 AND 80),
  core_angle text NOT NULL CHECK (char_length(core_angle) BETWEEN 1 AND 600),
  emotional_territory text NOT NULL CHECK (char_length(emotional_territory) BETWEEN 1 AND 160),
  primary_promise text NOT NULL CHECK (char_length(primary_promise) BETWEEN 1 AND 500),
  hook text NOT NULL CHECK (char_length(hook) BETWEEN 1 AND 200),
  opening_visual_pattern text NOT NULL CHECK (char_length(opening_visual_pattern) BETWEEN 1 AND 500),
  creative_format text NOT NULL CHECK (char_length(creative_format) BETWEEN 1 AND 120),
  primary_production_method text NOT NULL CHECK (primary_production_method IN ('AI_LIFESTYLE','AI_UGC_STYLE','PRODUCT_IMAGE_MOTION','PERSONALIZATION_DEMO','AI_BEFORE_AFTER','AI_CINEMATIC','MOTION_GRAPHICS','SEASONAL_AI')),
  supporting_production_methods jsonb NOT NULL DEFAULT '[]'::jsonb,
  proof_mechanism text NOT NULL CHECK (char_length(proof_mechanism) BETWEEN 1 AND 500),
  offer_framing text NOT NULL CHECK (char_length(offer_framing) BETWEEN 1 AND 400),
  cta_strategy text NOT NULL CHECK (char_length(cta_strategy) BETWEEN 1 AND 300),
  differentiation_summary text NOT NULL CHECK (char_length(differentiation_summary) BETWEEN 1 AND 700),
  product_truth_constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  visual_fidelity_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  required_real_asset_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  ugc_representation text NOT NULL CHECK (ugc_representation IN ('NOT_APPLICABLE','AI_STYLE_NON_CUSTOMER','REAL_SUPPLIED_TESTIMONIAL')),
  source text NOT NULL CHECK (source IN ('OPENAI','OPERATOR_REPLACEMENT')),
  diversity_state text NOT NULL DEFAULT 'NEEDS_DIFFERENTIATION' CHECK (diversity_state IN ('DISTINCT','NEEDS_DIFFERENTIATION','DUPLICATE_REPLACEMENT_REQUIRED')),
  production_safety_state text NOT NULL DEFAULT 'NEEDS_OPERATOR_REVIEW' CHECK (production_safety_state IN ('PRODUCTION_SAFE','MISSING_REQUIRED_REAL_ASSET','UNSUPPORTED_PRODUCT_CLAIM','UNSAFE_AI_TESTIMONIAL','NEEDS_OPERATOR_REVIEW')),
  validation_findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(concept_id, revision)
);
ALTER TABLE creative_strategy_concepts ADD CONSTRAINT creative_strategy_current_revision_fk FOREIGN KEY (current_revision_id) REFERENCES creative_strategy_concept_revisions(id) ON DELETE RESTRICT;
CREATE INDEX creative_strategy_revisions_batch_idx ON creative_strategy_concept_revisions(batch_id, created_at DESC);

CREATE TABLE creative_strategy_provider_operations (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES creative_strategy_batches(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('INITIAL','AUTO_REPAIR','EXPLICIT_REPLACEMENT')),
  operation_key text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('PENDING','SUBMITTING','SUCCEEDED','FAILED','SUBMISSION_UNKNOWN')),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  result_payload jsonb,
  failure_message text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX creative_strategy_one_automatic_operation_idx ON creative_strategy_provider_operations(batch_id, kind) WHERE kind IN ('INITIAL','AUTO_REPAIR');

CREATE TABLE creative_strategy_handoffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id uuid NOT NULL REFERENCES creative_strategy_batches(id) ON DELETE RESTRICT,
  concept_revision_id uuid NOT NULL REFERENCES creative_strategy_concept_revisions(id) ON DELETE RESTRICT,
  video_project_id uuid NOT NULL REFERENCES creative_projects(id) ON DELETE RESTRICT,
  revision_sha256 char(64) NOT NULL,
  operation_key text NOT NULL,
  selection_order integer NOT NULL CHECK (selection_order BETWEEN 1 AND 3),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL,
  UNIQUE(operation_key, concept_revision_id),
  UNIQUE(operation_key, selection_order),
  UNIQUE(concept_revision_id, video_project_id)
);

ALTER TABLE creative_projects ADD COLUMN strategy_required boolean NOT NULL DEFAULT false;
ALTER TABLE creative_projects ADD COLUMN strategy_batch_id uuid REFERENCES creative_strategy_batches(id) ON DELETE RESTRICT;
ALTER TABLE creative_projects ADD COLUMN strategy_concept_revision_id uuid REFERENCES creative_strategy_concept_revisions(id) ON DELETE RESTRICT;

ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_type_check CHECK (type IN ('GENERATE_SCENE','GENERATE_VOICE','COMPOSE_RENDER','GENERATE_STRATEGY','REPLACE_STRATEGY'));

ALTER TABLE usage_costs DROP CONSTRAINT usage_costs_operation_type_check;
ALTER TABLE usage_costs ADD CONSTRAINT usage_costs_operation_type_check CHECK (operation_type IN ('CONCEPT','VIDEO','VOICE','COMPOSITION','STRATEGY'));
