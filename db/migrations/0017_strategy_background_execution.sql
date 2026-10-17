ALTER TABLE creative_strategy_batches DROP CONSTRAINT creative_strategy_batches_status_check;
ALTER TABLE creative_strategy_batches ADD CONSTRAINT creative_strategy_batches_status_check
  CHECK (status IN ('PENDING','GENERATING','VALIDATING','REVIEW','REVIEW_WITH_ISSUES','HANDED_OFF','FAILED','SUBMISSION_UNKNOWN','RESULT_UNAVAILABLE'));

ALTER TABLE creative_strategy_provider_operations DROP CONSTRAINT creative_strategy_provider_operations_status_check;
ALTER TABLE creative_strategy_provider_operations ADD CONSTRAINT creative_strategy_provider_operations_status_check
  CHECK (status IN ('PENDING','SUBMITTING','POLLING','SUCCEEDED','FAILED','SUBMISSION_UNKNOWN','RESULT_UNAVAILABLE'));
ALTER TABLE creative_strategy_provider_operations
  ADD COLUMN response_id text,
  ADD COLUMN model text,
  ADD COLUMN submitted_at timestamptz,
  ADD COLUMN latest_provider_status text,
  ADD COLUMN latest_poll_at timestamptz,
  ADD COLUMN terminal_at timestamptz,
  ADD COLUMN result_sha256 char(64);
ALTER TABLE creative_strategy_provider_operations ADD CONSTRAINT creative_strategy_provider_status_check
  CHECK (latest_provider_status IS NULL OR latest_provider_status IN ('queued','in_progress','completed','failed','cancelled','incomplete'));
CREATE UNIQUE INDEX creative_strategy_provider_response_id_idx
  ON creative_strategy_provider_operations(response_id) WHERE response_id IS NOT NULL;

ALTER TABLE workflow_jobs ADD COLUMN next_attempt_at timestamptz;
