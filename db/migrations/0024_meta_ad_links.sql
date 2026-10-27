-- Links a Creative Reference to the Meta ad it was imported from, with the latest lifetime results.
-- Data is read-only from the Meta Marketing API; one ad can be imported once.
CREATE TABLE creative_meta_ad_links (
  creative_reference_id uuid PRIMARY KEY REFERENCES creative_references(id) ON DELETE RESTRICT,
  account_id text NOT NULL CHECK (account_id ~ '^act_[0-9]+$'),
  ad_id text NOT NULL UNIQUE CHECK (ad_id ~ '^[0-9]+$'),
  ad_name text NOT NULL CHECK (char_length(ad_name) <= 400),
  creative_id text,
  video_id text,
  thumbnail_url text,
  currency text CHECK (currency IS NULL OR char_length(currency) <= 8),
  metrics jsonb CHECK (metrics IS NULL OR jsonb_typeof(metrics) = 'object'),
  date_start date,
  date_end date,
  synced_at timestamptz,
  sync_error text CHECK (sync_error IS NULL OR char_length(sync_error) <= 500),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
