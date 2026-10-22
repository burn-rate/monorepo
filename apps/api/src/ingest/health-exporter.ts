import type { KnownMetricName, NormalizedSample } from '@burn-rate/api-schema';
import { DropLog, isFiniteNumber, normalizeSourceName } from './shared';

export interface HealthExporterPayload {
  schemaVersion: string;
  samples: HealthExporterSample[];
  device?: { model?: string };
}

interface SourceInfo {
  name?: string;
  bundleIdentifier?: string;
}

interface SampleDevice {
  model?: string;
}

export interface HealthExporterSample {
  id: string;
  typeIdentifier: string;
  typeKind?: string;
  startAt?: string;
  endAt?: string;
  value?: unknown;
  unit?: string;
  uuid?: string;
  source?: SourceInfo;
  device?: SampleDevice;
  activitySummary?: Record<string, unknown>;
}

/** HealthKit quantity types we store; anything else is dropped and logged. */
const QUANTITY_MAP: Partial<Record<string, KnownMetricName>> = {
  HKQuantityTypeIdentifierActiveEnergyBurned: 'active_energy_burned',
  HKQuantityTypeIdentifierBasalEnergyBurned: 'basal_energy_burned',
  HKQuantityTypeIdentifierAppleStandTime: 'stand_time',
  HKQuantityTypeIdentifierAppleExerciseTime: 'exercise_time',
  HKQuantityTypeIdentifierHeartRate: 'heart_rate',
  HKQuantityTypeIdentifierRestingHeartRate: 'resting_heart_rate',
  HKQuantityTypeIdentifierHeartRateVariabilitySDNN: 'heart_rate_variability'
};

/** Fields of the daily activitySummary object, expanded to day-grain rows. */
const SUMMARY_FIELDS = [
  { field: 'activeEnergyBurned', metric: 'active_energy_burned', unitField: 'activeEnergyUnit' },
  { field: 'activeEnergyBurnedGoal', metric: 'active_energy_goal', unitField: 'activeEnergyUnit' },
  { field: 'appleExerciseTime', metric: 'exercise_time', unitField: 'exerciseTimeUnit' },
  { field: 'appleExerciseTimeGoal', metric: 'exercise_time_goal', unitField: 'exerciseTimeUnit' },
  { field: 'appleStandHours', metric: 'stand_hour', unitField: 'standHoursUnit' },
  { field: 'appleStandHoursGoal', metric: 'stand_hours_goal', unitField: 'standHoursUnit' },
  { field: 'appleMoveTime', metric: 'move_time', unitField: 'moveTimeUnit' },
  { field: 'appleMoveTimeGoal', metric: 'move_time_goal', unitField: 'moveTimeUnit' }
] as const;

export interface MapResult {
  samples: NormalizedSample[];
  drops: DropLog;
}

function sampleBase(
  sample: HealthExporterSample,
  fallbackDevice: string | undefined,
  dumpKey: string,
  userId: string
): Pick<NormalizedSample, 'userId' | 'sourceName' | 'device' | 'extId' | 'dumpKey'> {
  return {
    userId,
    sourceName: normalizeSourceName(sample.source?.name ?? sample.source?.bundleIdentifier ?? 'unknown'),
    device: sample.device?.model ?? fallbackDevice ?? null,
    extId: sample.uuid ?? sample.id ?? null,
    dumpKey
  };
}

function mapQuantitySample(
  sample: HealthExporterSample,
  metric: KnownMetricName,
  base: ReturnType<typeof sampleBase>,
  drops: DropLog
): NormalizedSample | null {
  const time = sample.startAt ? new Date(sample.startAt) : null;
  const endedAt = sample.endAt ? new Date(sample.endAt) : null;
  if (!time || !endedAt || Number.isNaN(time.getTime()) || Number.isNaN(endedAt.getTime())) {
    drops.drop(`${sample.typeIdentifier}:bad-timestamp`);
    return null;
  }
  if (!isFiniteNumber(sample.value)) {
    drops.drop(`${sample.typeIdentifier}:bad-value`);
    return null;
  }
  return { ...base, metric, time, endedAt, value: sample.value, valueMin: null, valueMax: null, unit: sample.unit ?? '' };
}

function mapActivitySummary(
  sample: HealthExporterSample,
  base: ReturnType<typeof sampleBase>,
  drops: DropLog
): NormalizedSample[] {
  const summary = sample.activitySummary ?? {};
  const time = sample.startAt ? new Date(sample.startAt) : null;
  const endedAt = sample.endAt ? new Date(sample.endAt) : null;
  if (!time || !endedAt || Number.isNaN(time.getTime()) || Number.isNaN(endedAt.getTime())) {
    drops.drop(`${sample.typeIdentifier}:bad-timestamp`);
    return [];
  }

  const samples: NormalizedSample[] = [];
  for (const { field, metric, unitField } of SUMMARY_FIELDS) {
    const value = summary[field];
    if (!isFiniteNumber(value)) {
      drops.drop(`${sample.typeIdentifier}.${field}:missing`);
      continue;
    }
    samples.push({
      ...base,
      metric,
      time,
      endedAt,
      value,
      valueMin: null,
      valueMax: null,
      unit: typeof summary[unitField] === 'string' ? (summary[unitField] as string) : ''
    });
  }
  return samples;
}

/**
 * Map a health-exporter.v1 payload (HealthKit batches) to normalized samples.
 * Unknown quantity types and non-finite values are dropped and logged.
 */
export function mapHealthExporter(
  body: HealthExporterPayload,
  dumpKey: string,
  userId: string
): MapResult {
  const drops = new DropLog();
  const samples: NormalizedSample[] = [];

  for (const sample of body.samples ?? []) {
    const base = sampleBase(sample, body.device?.model, dumpKey, userId);

    if (sample.typeIdentifier === 'HKActivitySummaryTypeIdentifier') {
      samples.push(...mapActivitySummary(sample, base, drops));
      continue;
    }

    const metric = QUANTITY_MAP[sample.typeIdentifier];
    if (!metric) {
      drops.drop(sample.typeIdentifier || 'unknown-typeIdentifier');
      continue;
    }
    const mapped = mapQuantitySample(sample, metric, base, drops);
    if (mapped) samples.push(mapped);
  }

  return { samples, drops };
}
