-- A video set can now be made from a product alone (no winner), or follow a winner's style for a different product.
ALTER TABLE winner_video_batches ALTER COLUMN creative_reference_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS winner_video_batches_product_idx ON winner_video_batches (product_id, created_at DESC);
