ALTER TABLE creative_projects DROP CONSTRAINT creative_projects_state_check;
ALTER TABLE creative_projects ADD CONSTRAINT creative_projects_state_check
  CHECK (state IN ('DRAFT', 'CONCEPT_GENERATING', 'CONCEPT_REVIEW', 'CONCEPT_APPROVED', 'SCENES_GENERATING', 'SCENES_REVIEW', 'SCENES_APPROVED', 'VOICE_REVIEW', 'VOICE_GENERATING', 'COMPOSITION_PENDING', 'RENDERING', 'FINAL_REVIEW', 'SAVING', 'READY', 'FAILED'));

ALTER TABLE voice_generations DROP CONSTRAINT voice_generations_status_check;
ALTER TABLE voice_generations ADD CONSTRAINT voice_generations_status_check
  CHECK (status IN ('PENDING', 'SUBMITTED', 'PROCESSING', 'SUCCEEDED', 'REVIEW', 'ACCEPTED', 'REJECTED', 'FAILED'));

ALTER TABLE approvals DROP CONSTRAINT approvals_stage_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_stage_check
  CHECK (stage IN ('CONCEPT', 'SCENE', 'VOICE', 'FINAL', 'READY_SAVE'));
