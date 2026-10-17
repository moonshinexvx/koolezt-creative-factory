-- Preserve legacy KLING_VIDEO history while allowing new provider-neutral AI_VIDEO scenes.
ALTER TABLE concept_scene_specs DROP CONSTRAINT concept_scene_specs_source_type_check;
ALTER TABLE concept_scene_specs ADD CONSTRAINT concept_scene_specs_source_type_check
  CHECK (source_type IN ('AI_VIDEO', 'KLING_VIDEO', 'UPLOADED_VIDEO', 'PRODUCT_IMAGE', 'EXISTING_ASSET'));

ALTER TABLE scene_attempts DROP CONSTRAINT scene_attempts_source_type_check;
ALTER TABLE scene_attempts ADD CONSTRAINT scene_attempts_source_type_check
  CHECK (source_type IN ('AI_VIDEO', 'KLING_VIDEO', 'UPLOADED_VIDEO', 'PRODUCT_IMAGE', 'EXISTING_ASSET'));
