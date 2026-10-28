-- AI scene images: one background job per video makes the images its scenes asked for.
ALTER TABLE winner_jobs DROP CONSTRAINT IF EXISTS winner_jobs_kind_check;
ALTER TABLE winner_jobs ADD CONSTRAINT winner_jobs_kind_check CHECK (kind IN ('ANALYZE_WINNER','WRITE_VIDEO_PLANS','RENDER_VIDEO','GENERATE_SCENE_IMAGES'));
