ALTER TABLE scene_attempts DROP CONSTRAINT scene_attempts_status_check;
ALTER TABLE scene_attempts ADD CONSTRAINT scene_attempts_status_check
  CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'SUBMISSION_UNKNOWN', 'REVIEW', 'ACCEPTED', 'REJECTED', 'FAILED', 'CANCELLED'));
