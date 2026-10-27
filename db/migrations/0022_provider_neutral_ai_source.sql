-- Generated content is labelled AI_PROVIDER; the concrete provider and model stay in provider metadata.
-- Legacy OPENAI rows remain valid and are not rewritten.
ALTER TABLE variant_creative_package_revisions DROP CONSTRAINT variant_creative_package_revisions_source_check;
ALTER TABLE variant_creative_package_revisions ADD CONSTRAINT variant_creative_package_revisions_source_check
  CHECK (source IN ('MANUAL','AI_PROVIDER','OPENAI'));

ALTER TABLE creative_strategy_concept_revisions DROP CONSTRAINT creative_strategy_concept_revisions_source_check;
ALTER TABLE creative_strategy_concept_revisions ADD CONSTRAINT creative_strategy_concept_revisions_source_check
  CHECK (source IN ('AI_PROVIDER','OPENAI','OPERATOR_REPLACEMENT'));

ALTER TABLE creative_dna_revisions DROP CONSTRAINT creative_dna_revisions_source_check;
ALTER TABLE creative_dna_revisions ADD CONSTRAINT creative_dna_revisions_source_check
  CHECK (source IN ('AI_PROVIDER','OPENAI','OPERATOR_EDIT'));
