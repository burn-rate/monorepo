-- MANUAL, DESTRUCTIVE CUTOVER. Never included in the default additive runner.
-- Pause legacy writers, run/verify backfill, and record the R2/backup attestations
-- through verifyLegacyCutover before running this migration in a transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM health_migration_state WHERE singleton
      AND samples_verified_at IS NOT NULL AND dumps_verified_at IS NOT NULL
      AND backup_inventory_reference IS NOT NULL AND verified_by IS NOT NULL
      AND legacy_sample_count = (SELECT count(*) FROM health_samples)
  ) THEN
    RAISE EXCEPTION 'Encrypted cutover requires verified sample, R2, and backup inventory';
  END IF;
  IF EXISTS (
    SELECT 1 FROM health_samples s
    LEFT JOIN health_legacy_sample_migrations m ON m.legacy_id = s.legacy_migration_id
    LEFT JOIN encrypted_health_samples e ON e.id = m.encrypted_sample_id AND e.time = m.sample_time AND e.owner_id = m.owner_id
    WHERE m.legacy_id IS NULL OR e.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Unowned or unverified legacy observations remain';
  END IF;
END $$;

-- Dropping the continuous aggregate also removes its background refresh policy.
DROP MATERIALIZED VIEW IF EXISTS health_daily;
-- Its chunk/compression policies are removed with the hypertable. Do not retain
-- a renamed plaintext shadow table or add plaintext value columns to the new one.
DROP TABLE health_samples;
