ALTER TABLE approvals DROP CONSTRAINT approvals_stage_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_stage_check
  CHECK (stage IN ('CONCEPT', 'SCENE', 'VOICE', 'FINAL', 'READY_SAVE'));
