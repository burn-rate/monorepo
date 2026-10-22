import type { KnownMetricName, NormalizedSample } from '@burn-rate/api-schema';
import { Temporal } from '@js-temporal/polyfill';
import type { NormalizedRingSummary } from '../credit/types';
import { DropLog, isFiniteNumber, normalizeSourceName } from './shared';

export interface HealthExporterPayload {
  schemaVersion: string;
  samples: HealthExporterSample[];
  device?: { model?: string };
  createdAt?: string;
  timezone?: string;
  timeZone?: string;
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
  timezone?: string;
  timeZone?: string;
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
  ringSummaries?: NormalizedRingSummary[];
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function timestampOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  try { return Temporal.Instant.from(value).toString(); } catch { return null; }
}

function normalizedSourceIdentity(source: SourceInfo | undefined): string | null {
  const bundle = textOrNull(source?.bundleIdentifier);
  if (bundle) return bundle.trim();
  const name = textOrNull(source?.name);
  if (!name) return null;
  const normalized = normalizeSourceName(name).trim();
  return normalized.toLowerCase() === 'apple fitness' ? 'com.apple.Fitness' : normalized;
}

/** Preserve a whole revision even when values or provenance are incomplete. */
function mapRingSummary(sample: HealthExporterSample, payload: HealthExporterPayload): NormalizedRingSummary {
  const summary = sample.activitySummary ?? {};
  const mode = summary.activityMoveMode;
  const moveMode = mode === 1 || mode === 'energy' || mode === 'activeEnergy' ? 'energy'
    : mode === 2 || mode === 'time' || mode === 'appleMoveTime' ? 'time' : null;
  const ring = (actual: unknown, goal: unknown, unit: unknown): NormalizedRingSummary['move'] => ({
    actual: isFiniteNumber(actual) ? actual : null,
    goal: isFiniteNumber(goal) ? goal : null,
    unit: textOrNull(unit)
  });
  return {
    sourceIdentity: normalizedSourceIdentity(sample.source),
    sourceRecordId: textOrNull(sample.uuid) ?? textOrNull(sample.id),
    localDate: textOrNull(summary.date),
    timeZone: textOrNull(summary.timezone) ?? textOrNull(summary.timeZone) ?? textOrNull(sample.timezone) ??
      textOrNull(sample.timeZone) ?? textOrNull(payload.timezone) ?? textOrNull(payload.timeZone),
    startsAt: timestampOrNull(sample.startAt),
    endsAt: timestampOrNull(sample.endAt),
    revisionAt: timestampOrNull(payload.createdAt),
    moveMode,
    paused: typeof summary.paused === 'boolean' ? summary.paused : null,
    move: moveMode === 'energy'
      ? ring(summary.activeEnergyBurned, summary.activeEnergyBurnedGoal, summary.activeEnergyUnit)
      : moveMode === 'time'
        ? ring(summary.appleMoveTime, summary.appleMoveTimeGoal, summary.moveTimeUnit)
        : ring(null, null, null),
    exercise: ring(summary.appleExerciseTime, summary.appleExerciseTimeGoal, summary.exerciseTimeUnit),
    stand: ring(summary.appleStandHours, summary.appleStandHoursGoal, summary.standHoursUnit)
  };
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
  const ringSummaries: NormalizedRingSummary[] = [];

  for (const sample of body.samples ?? []) {
    const base = sampleBase(sample, body.device?.model, dumpKey, userId);

    if (sample.typeIdentifier === 'HKActivitySummaryTypeIdentifier') {
      ringSummaries.push(mapRingSummary(sample, body));
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

  return { samples, drops, ringSummaries };
}
