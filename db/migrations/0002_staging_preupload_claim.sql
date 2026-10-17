ALTER TABLE external_media_staging DROP CONSTRAINT external_media_staging_state_check;
ALTER TABLE external_media_staging ADD CONSTRAINT external_media_staging_state_check CHECK (state IN ('STAGING','AVAILABLE','CLEANUP_PENDING','CLEANED','FAILED','UPLOAD_FAILED'));
