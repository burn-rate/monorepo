-- TimescaleDB schema for burn-rate health timeseries.
--
-- Apply with psql against your Timescale instance:
--   psql "$TIMESERIES_DB_URL" -f apps/api/timescale/001_init.sql
--
-- The Worker connects through Hyperdrive (see apps/api/wrangler.jsonc); local
-- dev points at this database via WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_*
-- (see apps/api/.dev.vars.example).
--
-- Design notes:
-- - One narrow hypertable for every metric. New metrics need no DDL.
-- - `ended_at` is NOT NULL: instantaneous samples (metrics-v1 format) get
--   ended_at = time. Interval samples (health-exporter-v1, stand_time minute
--   buckets) carry their real end. This keeps the dedup key total (no NULL
--   semantics) and makes interval queries uniform across formats.
-- - The unique key doubles as the upsert conflict target and must include the
--   hypertable partition column (time).
-- - Keep the seeded `metrics` rows in sync with KNOWN_METRICS in
--   packages/api-schema/src/metrics.ts.

-- ---------------------------------------------------------------------------
-- Canonical metric registry
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS metrics (
  metric       TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('activity', 'vitals')),
  unit         TEXT NOT NULL
);

INSERT INTO metrics (metric, display_name, category, unit) VALUES
  ('active_energy_burned', 'Active Energy Burned',   'activity', 'kcal'),
  ('active_energy_goal',   'Active Energy Goal',     'activity', 'kcal'),
  ('basal_energy_burned',  'Basal Energy Burned',    'activity', 'kcal'),
  ('stand_time',           'Stand Time',             'activity', 'min'),
  ('stand_hour',           'Stand Hour',             'activity', 'count'),
  ('stand_hours_goal',     'Stand Hours Goal',       'activity', 'count'),
  ('exercise_time',        'Exercise Time',          'activity', 'min'),
  ('exercise_time_goal',   'Exercise Time Goal',     'activity', 'min'),
  ('move_time',            'Move Time',              'activity', 'min'),
  ('move_time_goal',       'Move Time Goal',         'activity', 'min'),
  ('heart_rate',           'Heart Rate',             'vitals',   'bpm'),
  ('resting_heart_rate',   'Resting Heart Rate',     'vitals',   'bpm'),
  ('heart_rate_variability', 'Heart Rate Variability', 'vitals', 'ms')
ON CONFLICT (metric) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Sample hypertable
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS health_samples (
  time        TIMESTAMPTZ       NOT NULL,             -- sample start (partition column)
  ended_at    TIMESTAMPTZ       NOT NULL,             -- = time for instantaneous samples
  user_id     TEXT              NOT NULL DEFAULT 'default',
  metric      TEXT              NOT NULL REFERENCES metrics (metric),
  value       DOUBLE PRECISION  NOT NULL,             -- Avg for heart_rate
  value_min   DOUBLE PRECISION,                       -- heart_rate Min
  value_max   DOUBLE PRECISION,                       -- heart_rate Max
  unit        TEXT              NOT NULL,
  source_name TEXT              NOT NULL,             -- 'Allan''s Apple Watch', 'Apple Fitness', ...
  device      TEXT,                                   -- 'Watch7,12', 'iPhone14,3'
  ext_id      TEXT,                                   -- source-native id (HealthKit uuid) when present
  dump_key    TEXT,                                   -- R2 object key of the raw payload (lineage)
  attrs       JSONB,                                  -- escape hatch for irregular shapes (e.g. sleep phases)
  ingested_at TIMESTAMPTZ       NOT NULL DEFAULT now(),
  UNIQUE (user_id, metric, time, ended_at, source_name)
);

SELECT create_hypertable('health_samples', by_range('time', INTERVAL '7 days'),
  if_not_exists => TRUE);

-- Columnstore: queries filter by person + metric, then scan time.
-- Older chunks compress after 14 days; recent data stays rowstore for fast
-- inline inserts from the hook.
ALTER TABLE health_samples SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'user_id, metric, source_name',
  timescaledb.compress_orderby   = 'time DESC'
);
-- A procedure on TimescaleDB >= 2.18 (hypercore): invoke with CALL.
CALL add_columnstore_policy('health_samples', after => INTERVAL '14 days',
  if_not_exists => TRUE);
-- Open-source TimescaleDB equivalent:
--   SELECT add_compression_policy('health_samples', compress_after => INTERVAL '14 days', if_not_exists => TRUE);

-- ---------------------------------------------------------------------------
-- Daily rollup (tz-aware day boundaries for the user's home timezone)
-- ---------------------------------------------------------------------------

CREATE MATERIALIZED VIEW IF NOT EXISTS health_daily
WITH (timescaledb.continuous) AS
SELECT time_bucket(INTERVAL '1 day', time, 'America/Los_Angeles') AS day,
       user_id,
       metric,
       sum(value)     AS sum_value,   -- kcal burned, stand minutes, stand hours
       avg(value)     AS avg_value,   -- average heart rate
       min(value_min) AS min_value,   -- lowest heart rate
       max(value_max) AS max_value,   -- peak heart rate
       count(*)       AS points
FROM health_samples
GROUP BY 1, 2, 3
WITH NO DATA;

SELECT add_continuous_aggregate_policy('health_daily',
  start_offset      => INTERVAL '30 days',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);
