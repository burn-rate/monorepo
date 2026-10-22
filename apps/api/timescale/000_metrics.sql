-- Public metric registry bootstrap for both fresh and existing databases.
-- Historical 001_init.sql is preserved, but is not needed on a fresh encrypted
-- installation: it creates plaintext health storage and the old daily rollup.
-- Keep these definitions aligned with packages/api-schema/src/metrics.ts.
CREATE TABLE IF NOT EXISTS metrics (
  metric TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('activity', 'vitals')),
  unit TEXT NOT NULL
);

INSERT INTO metrics (metric, display_name, category, unit) VALUES
  ('active_energy_burned', 'Active Energy Burned', 'activity', 'kcal'),
  ('active_energy_goal', 'Active Energy Goal', 'activity', 'kcal'),
  ('basal_energy_burned', 'Basal Energy Burned', 'activity', 'kcal'),
  ('stand_time', 'Stand Time', 'activity', 'min'),
  ('stand_hour', 'Stand Hour', 'activity', 'count'),
  ('stand_hours_goal', 'Stand Hours Goal', 'activity', 'count'),
  ('exercise_time', 'Exercise Time', 'activity', 'min'),
  ('exercise_time_goal', 'Exercise Time Goal', 'activity', 'min'),
  ('move_time', 'Move Time', 'activity', 'min'),
  ('move_time_goal', 'Move Time Goal', 'activity', 'min'),
  ('heart_rate', 'Heart Rate', 'vitals', 'bpm'),
  ('resting_heart_rate', 'Resting Heart Rate', 'vitals', 'bpm'),
  ('heart_rate_variability', 'Heart Rate Variability', 'vitals', 'ms')
ON CONFLICT (metric) DO NOTHING;
