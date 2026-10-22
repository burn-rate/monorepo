import type { KnownMetricName, NormalizedSample } from '@burn-rate/api-schema';
import { DropLog, isFiniteNumber, normalizeSourceName, parseOffsetDate } from './shared';
import type { MapResult } from './health-exporter';

export interface MetricsExportPayload {
  data: {
    metrics: MetricsExportMetric[];
  };
}

export interface MetricsExportMetric {
  name?: string;
  units?: string;
  data?: MetricsExportPoint[];
}

export interface MetricsExportPoint {
  date?: string;
  qty?: unknown;
  source?: unknown;
  Avg?: unknown;
  Min?: unknown;
  Max?: unknown;
}

/** metrics-v1 export names we store; anything else is dropped and logged. */
const METRIC_MAP: Partial<Record<string, KnownMetricName>> = {
  active_energy: 'active_energy_burned',
  basal_energy_burned: 'basal_energy_burned',
  apple_stand_time: 'stand_time',
  apple_stand_hour: 'stand_hour',
  apple_exercise_time: 'exercise_time',
  heart_rate: 'heart_rate',
  resting_heart_rate: 'resting_heart_rate',
  heart_rate_variability: 'heart_rate_variability'
};

function normalizeUnit(units: string | undefined, metric: KnownMetricName): string {
  if (metric === 'heart_rate' || metric === 'resting_heart_rate') return 'bpm';
  return units ?? '';
}

/** Map a metrics-v1 payload ({ data: { metrics } }) to normalized samples. */
export function mapMetricsExport(
  body: MetricsExportPayload,
  dumpKey: string,
  userId = 'default'
): MapResult {
  const drops = new DropLog();
  const samples: NormalizedSample[] = [];

  for (const metricExport of body.data.metrics ?? []) {
    const known = metricExport.name ? METRIC_MAP[metricExport.name] : undefined;
    if (!known) {
      drops.drop(metricExport.name ?? 'unknown-metric');
      continue;
    }

    for (const point of metricExport.data ?? []) {
      if (!point.date) {
        drops.drop(`${metricExport.name}:bad-timestamp`);
        continue;
      }
      let time: Date;
      try {
        time = parseOffsetDate(point.date);
      } catch {
        drops.drop(`${metricExport.name}:bad-timestamp`);
        continue;
      }

      // heart_rate points report Avg/Min/Max instead of qty.
      const value = isFiniteNumber(point.Avg) ? point.Avg : point.qty;
      if (!isFiniteNumber(value)) {
        drops.drop(`${metricExport.name}:bad-value`);
        continue;
      }

      // Points are instantaneous, except stand_time which is a minute bucket.
      const isStandTime = known === 'stand_time';
      const endedAt = isStandTime ? new Date(time.getTime() + 60_000) : time;

      samples.push({
        userId,
        metric: known,
        time,
        endedAt,
        value,
        valueMin: isFiniteNumber(point.Min) ? point.Min : null,
        valueMax: isFiniteNumber(point.Max) ? point.Max : null,
        unit: normalizeUnit(metricExport.units, known),
        sourceName: normalizeSourceName(point.source ?? 'unknown'),
        device: null,
        extId: null,
        dumpKey
      });
    }
  }

  return { samples, drops };
}
