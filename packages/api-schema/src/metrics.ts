export const METRIC_CATEGORIES = ['activity', 'vitals'] as const;

export type MetricCategory = (typeof METRIC_CATEGORIES)[number];

export interface MetricDefinition {
  displayName: string;
  category: MetricCategory;
  /** Canonical unit. Payload units are normalized to this at ingest. */
  unit: string;
}

/**
 * Metrics the ingestor maps and stores. Anything else is dropped and logged.
 * Keep in sync with the seeded rows in apps/api/timescale/001_init.sql.
 */
export const KNOWN_METRICS = {
  active_energy_burned: { displayName: 'Active Energy Burned', category: 'activity', unit: 'kcal' },
  active_energy_goal: { displayName: 'Active Energy Goal', category: 'activity', unit: 'kcal' },
  basal_energy_burned: { displayName: 'Basal Energy Burned', category: 'activity', unit: 'kcal' },
  stand_time: { displayName: 'Stand Time', category: 'activity', unit: 'min' },
  stand_hour: { displayName: 'Stand Hour', category: 'activity', unit: 'count' },
  stand_hours_goal: { displayName: 'Stand Hours Goal', category: 'activity', unit: 'count' },
  exercise_time: { displayName: 'Exercise Time', category: 'activity', unit: 'min' },
  exercise_time_goal: { displayName: 'Exercise Time Goal', category: 'activity', unit: 'min' },
  move_time: { displayName: 'Move Time', category: 'activity', unit: 'min' },
  move_time_goal: { displayName: 'Move Time Goal', category: 'activity', unit: 'min' },
  heart_rate: { displayName: 'Heart Rate', category: 'vitals', unit: 'bpm' },
  resting_heart_rate: { displayName: 'Resting Heart Rate', category: 'vitals', unit: 'bpm' },
  heart_rate_variability: { displayName: 'Heart Rate Variability', category: 'vitals', unit: 'ms' }
} as const satisfies Record<string, MetricDefinition>;

export type KnownMetricName = keyof typeof KNOWN_METRICS;

export const KNOWN_METRIC_NAMES = Object.keys(KNOWN_METRICS) as KnownMetricName[];
