-- Additive only. The legacy table remains quarantined from the new read path.
-- Run through the repository migration runner, after 000_metrics.sql.
CREATE TABLE IF NOT EXISTS health_user_keys (
  owner_id TEXT NOT NULL CHECK (owner_id <> 'default'),
  key_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('data', 'index')),
  state TEXT NOT NULL CHECK (state IN ('active', 'retired')),
  wrapped_key JSONB NOT NULL CHECK (wrapped_key->>'version' = '1'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at TIMESTAMPTZ,
  PRIMARY KEY (owner_id, key_id),
  CHECK (purpose <> 'index' OR state = 'active')
);
CREATE UNIQUE INDEX IF NOT EXISTS health_user_keys_one_active
  ON health_user_keys (owner_id, purpose) WHERE state = 'active';

CREATE TABLE IF NOT EXISTS encrypted_health_samples (
  id TEXT NOT NULL,
  owner_id TEXT NOT NULL CHECK (owner_id <> 'default'),
  metric TEXT NOT NULL REFERENCES metrics(metric),
  time TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ NOT NULL,
  source_digest TEXT NOT NULL,
  envelope JSONB NOT NULL CHECK (envelope->>'version' = '1'),
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- pg/JavaScript observation timestamps have millisecond precision. Preserve
  -- that invariant for exact fractional query bounds and authenticated metadata.
  CONSTRAINT encrypted_samples_time_precision CHECK (time = date_trunc('milliseconds', time)),
  CONSTRAINT encrypted_samples_end_precision CHECK (ended_at = date_trunc('milliseconds', ended_at)),
  PRIMARY KEY (time, id),
  UNIQUE (owner_id, metric, time, ended_at, source_digest)
);
CREATE INDEX IF NOT EXISTS encrypted_health_samples_owner_page
  ON encrypted_health_samples (owner_id, metric, time, id);

SELECT create_hypertable('encrypted_health_samples', by_range('time', INTERVAL '7 days'), if_not_exists => TRUE);
ALTER TABLE encrypted_health_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'owner_id, metric',
  timescaledb.compress_orderby = 'time DESC'
);
CALL add_columnstore_policy('encrypted_health_samples', after => INTERVAL '14 days', if_not_exists => TRUE);

-- An opaque checkpoint ID permits resumable backfill even for duplicate legacy
-- rows. No source identity is copied into the checkpoint ledger.
-- Timescale rejects nonconstant ADD COLUMN defaults while columnstore is enabled.
-- Add only metadata here; operator backfill assigns IDs in bounded updates using
-- the existing full logical unique identity, with legacy writers paused.
-- Fresh encrypted installations have no legacy table. Never create a plaintext
-- table merely to make optional legacy migration tooling available.
DO $$
DECLARE
  target_schema TEXT := current_schema();
BEGIN
  IF to_regclass(format('%I.health_samples', target_schema)) IS NOT NULL THEN
    EXECUTE format('ALTER TABLE %I.health_samples ADD COLUMN IF NOT EXISTS legacy_migration_id UUID', target_schema);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS health_samples_legacy_migration_id ON %I.health_samples (time, legacy_migration_id)', target_schema);
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS health_legacy_sample_migrations (
  legacy_id UUID PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK (owner_id <> 'default'),
  encrypted_sample_id TEXT NOT NULL,
  sample_time TIMESTAMPTZ NOT NULL,
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS health_legacy_dump_migrations (
  legacy_key_hash TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL CHECK (owner_id <> 'default'),
  verified_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS health_migration_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  samples_verified_at TIMESTAMPTZ,
  dumps_verified_at TIMESTAMPTZ,
  backup_inventory_reference TEXT,
  verified_by TEXT,
  legacy_sample_count BIGINT,
  legacy_dump_count BIGINT
);
INSERT INTO health_migration_state (singleton) VALUES (TRUE) ON CONFLICT DO NOTHING;
