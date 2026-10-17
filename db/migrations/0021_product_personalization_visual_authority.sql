ALTER TABLE products
  ADD COLUMN personalization_visual_authority jsonb;

ALTER TABLE products ADD CONSTRAINT products_personalization_visual_authority_object
  CHECK (personalization_visual_authority IS NULL OR jsonb_typeof(personalization_visual_authority) = 'object');
