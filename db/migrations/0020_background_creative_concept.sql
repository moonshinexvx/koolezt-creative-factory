ALTER TABLE workflow_jobs DROP CONSTRAINT workflow_jobs_type_check;
ALTER TABLE workflow_jobs ADD CONSTRAINT workflow_jobs_type_check
  CHECK (type IN (
    'GENERATE_CONCEPT',
    'GENERATE_SCENE',
    'GENERATE_VOICE',
    'COMPOSE_RENDER',
    'GENERATE_STRATEGY',
    'REPLACE_STRATEGY',
    'ANALYZE_CREATIVE_DNA'
  ));
