-- PERMANENT DATA REMOVAL. Take a pg_dump backup before applying.
-- Removes every campaign, concept, strategy, project, scene, voice, render, variant and old workflow record.
-- Kept: products with their facts and photos, winners (creative_references) with their DNA, reports and
-- Meta links, the new winner video tables, media file records, and render-worker credentials.
-- The whole migration runs in one transaction and aborts if any kept table changes size.

CREATE TEMP TABLE kept_counts ON COMMIT DROP AS SELECT
  (SELECT count(*) FROM creative_references) AS winners,
  (SELECT count(*) FROM creative_dna_revisions) AS dna_revisions,
  (SELECT count(*) FROM creative_winner_reports) AS reports,
  (SELECT count(*) FROM creative_meta_ad_links) AS meta_links,
  (SELECT count(*) FROM products) AS products,
  (SELECT count(*) FROM product_assets) AS product_photos,
  (SELECT count(*) FROM product_claims) AS product_facts,
  (SELECT count(*) FROM media_assets) AS media_files;

-- Winners and media files no longer belong to campaign projects; unlink them before projects are removed.
UPDATE creative_references SET source_project_id = NULL WHERE source_project_id IS NOT NULL;
UPDATE media_assets SET project_id = NULL WHERE project_id IS NOT NULL;
DO $$
DECLARE link record;
BEGIN
  FOR link IN
    SELECT c.conrelid::regclass::text AS table_name, c.conname AS constraint_name FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.contype = 'f' AND c.confrelid = 'creative_projects'::regclass
      AND ((c.conrelid = 'creative_references'::regclass AND a.attname = 'source_project_id')
        OR (c.conrelid = 'media_assets'::regclass AND a.attname = 'project_id'))
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', link.table_name, link.constraint_name);
  END LOOP;
END $$;

-- Analyses that were waiting on the old job system are marked failed so they can be started again.
UPDATE creative_references SET analysis_status = 'FAILED', updated_at = now() WHERE analysis_status = 'ANALYZING';
UPDATE creative_winner_reports SET status = 'FAILED', failure_message = 'Interrupted by the upgrade. Click Analyze again or Generate report.', updated_at = now() WHERE status = 'PENDING';

-- Tables are listed explicitly with no cascading: if any table outside this list still referenced one of them, the migration fails instead of deleting more.
TRUNCATE TABLE
  approvals, audit_events, usage_costs, provider_jobs, workflow_outbox, workflow_jobs, external_media_staging,
  desktop_render_jobs, render_scene_inputs, renders, voice_generations, scene_attempts, creative_scenes,
  concept_scene_reference_assets, concept_scene_specs, creative_concepts, creative_project_assets, creative_project_snapshots,
  variant_package_voices, variant_creative_package_revisions, variant_creative_packages, creative_variants, variant_batches,
  creative_strategy_handoffs, creative_strategy_provider_operations, creative_strategy_concept_revisions, creative_strategy_concepts, creative_strategy_batches,
  creative_projects;

DO $$
DECLARE before kept_counts%ROWTYPE;
BEGIN
  SELECT * INTO before FROM kept_counts;
  IF (SELECT count(*) FROM creative_references) <> before.winners
    OR (SELECT count(*) FROM creative_dna_revisions) <> before.dna_revisions
    OR (SELECT count(*) FROM creative_winner_reports) <> before.reports
    OR (SELECT count(*) FROM creative_meta_ad_links) <> before.meta_links
    OR (SELECT count(*) FROM products) <> before.products
    OR (SELECT count(*) FROM product_assets) <> before.product_photos
    OR (SELECT count(*) FROM product_claims) <> before.product_facts
    OR (SELECT count(*) FROM media_assets) <> before.media_files THEN
    RAISE EXCEPTION 'Campaign cleanup would change kept data; nothing was removed.';
  END IF;
END $$;
