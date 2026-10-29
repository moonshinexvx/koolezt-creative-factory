-- Marketing-director pipeline: a creative brief is written first and the owner picks angles before scripts are written.
ALTER TABLE winner_jobs DROP CONSTRAINT IF EXISTS winner_jobs_kind_check;
ALTER TABLE winner_jobs ADD CONSTRAINT winner_jobs_kind_check CHECK (kind IN ('ANALYZE_WINNER','WRITE_CREATIVE_BRIEF','WRITE_VIDEO_PLANS','RENDER_VIDEO','GENERATE_SCENE_IMAGES'));
ALTER TABLE winner_video_batches DROP CONSTRAINT IF EXISTS winner_video_batches_status_check;
ALTER TABLE winner_video_batches ADD CONSTRAINT winner_video_batches_status_check CHECK (status IN ('WRITING_BRIEF','BRIEF_READY','WRITING','READY','FAILED'));
