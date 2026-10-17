ALTER TABLE creative_strategy_batches
  DROP CONSTRAINT creative_strategy_batches_requested_count_check;

ALTER TABLE creative_strategy_batches
  ALTER COLUMN requested_count SET DEFAULT 6;

ALTER TABLE creative_strategy_batches
  ADD CONSTRAINT creative_strategy_batches_requested_count_check
  CHECK (requested_count IN (3, 6, 12));

ALTER TABLE creative_strategy_concept_revisions
  ADD COLUMN creative_visual_execution_notes text NOT NULL DEFAULT '';

ALTER TABLE creative_strategy_concept_revisions
  ADD CONSTRAINT creative_strategy_visual_execution_notes_length_check
  CHECK (char_length(creative_visual_execution_notes) <= 700);
