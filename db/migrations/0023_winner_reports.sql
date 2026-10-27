-- Human-facing Winner Analysis reports, one per Creative Reference, kept separate from DNA revisions
-- so regenerating a report never changes an approved DNA revision.
CREATE TABLE creative_winner_reports (
  creative_reference_id uuid PRIMARY KEY REFERENCES creative_references(id) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('PENDING','READY','FAILED')),
  report jsonb CHECK (report IS NULL OR jsonb_typeof(report) = 'object'),
  measurements jsonb CHECK (measurements IS NULL OR jsonb_typeof(measurements) = 'object'),
  failure_message text CHECK (failure_message IS NULL OR char_length(failure_message) <= 500),
  provider_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
