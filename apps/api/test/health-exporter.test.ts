import { describe, expect, it } from 'vitest';
import { normalizedSampleSchema } from '@burn-rate/api-schema';
import { mapPayload } from '../src/ingest';
import { normalizedRingSummarySchema } from '../src/credit/types';
import { calculateCredit } from '../src/credit/policy';
import fixture from './fixtures/health-exporter-v1.json';

const dumpKey = 'hook/2026-10-22T18:09:02.961Z-fixture.json';

describe('mapPayload: health-exporter-v1', () => {
  const result = mapPayload(fixture, dumpKey, 'fixture-owner');

  it('reports stats: 5 received, 11 mapped, 1 dropped', () => {
    // 3 known quantity samples (StepCount dropped) + 1 activitySummary
    // expanded to 8 day-grain rows (values + goals) = 11 mapped.
    expect(result.format).toBe('health-exporter-v1');
    expect(result.received).toBe(5);
    expect(result.mapped).toBe(11);
    expect(result.dropped).toBe(1);
    expect(result.droppedBy).toEqual({ 'HKQuantityTypeIdentifierStepCount': 1 });
  });

  it('maps quantity samples with uuid extId, device, and NBSP-normalized source', () => {
    const active = result.samples.find((s) => s.metric === 'active_energy_burned' && s.extId?.startsWith('5D666A56'));
    expect(active).toMatchObject({
      userId: 'fixture-owner',
      value: 0.187,
      unit: 'kcal',
      sourceName: 'Allan’s Apple Watch', // \u00a0 → space
      device: 'Watch',
      dumpKey
    });
    expect(active?.time.toISOString()).toBe('2026-10-19T04:45:08.000Z');
    expect(active?.endedAt.toISOString()).toBe('2026-10-19T04:45:11.000Z');
  });

  it('expands activitySummary into day-grain rows including goals', () => {
    const standHours = result.samples.filter((s) => s.metric === 'stand_hour');
    expect(standHours).toHaveLength(1);
    expect(standHours[0]).toMatchObject({ value: 11, unit: 'count', sourceName: 'Apple Fitness' });
    expect(standHours[0].time.toISOString()).toBe('2026-10-16T07:00:00.000Z');
    expect(standHours[0].endedAt.toISOString()).toBe('2026-10-17T07:00:00.000Z');

    const goals = result.samples
      .filter((s) => s.metric.endsWith('_goal'))
      .map((s) => [s.metric, s.value] as const)
      .sort((a, b) => a[0].localeCompare(b[0]));
    expect(goals).toEqual([
      ['active_energy_goal', 1100],
      ['exercise_time_goal', 90],
      ['move_time_goal', 0],
      ['stand_hours_goal', 14]
    ]);
  });

  it('falls back to the batch device when a sample has none', () => {
    const summaryRow = result.samples.find((s) => s.metric === 'active_energy_burned' && s.sourceName === 'Apple Fitness');
    expect(summaryRow?.device).toBe('iPhone14,3');
  });

  it('produces schema-valid samples', () => {
    for (const sample of result.samples) {
      expect(() => normalizedSampleSchema.parse(sample)).not.toThrow();
    }
  });

  it('retains one indivisible summary revision alongside metric samples', () => {
    expect(result.ringSummaries).toHaveLength(1);
    expect(normalizedRingSummarySchema.parse(result.ringSummaries[0])).toEqual({
      sourceIdentity: 'com.apple.Fitness', sourceRecordId: 'HKActivitySummaryTypeIdentifier:2026-10-16',
      localDate: '2026-10-16', timeZone: 'America/Los_Angeles',
      startsAt: '2026-10-16T07:00:00Z', endsAt: '2026-10-17T07:00:00Z', revisionAt: '2026-10-22T18:08:50Z',
      moveMode: 'energy', paused: false,
      move: { actual: 1040.1363046016702, goal: 1100, unit: 'kcal' },
      exercise: { actual: 94, goal: 90, unit: 'min' },
      stand: { actual: 11, goal: 14, unit: 'count' }
    });
    expect(calculateCredit({ ringSummaries: result.ringSummaries, loans: [] }, 'America/Los_Angeles', '2026-10-22T21:00:00Z').credit.historyDays).toBe(1);
  });

  it('retains incomplete corrections without inventing goals, metadata, or activity', () => {
    const summarySample = structuredClone(fixture.samples[4]);
    const incomplete = mapPayload({ schemaVersion: 'health-exporter.v1', samples: [{
      ...summarySample, activitySummary: { date: '2026-10-16', activityMoveMode: 1, activeEnergyBurned: 0 }
    }] }, dumpKey, 'fixture-owner').ringSummaries[0];
    expect(incomplete).toMatchObject({
      revisionAt: null, timeZone: null, paused: null, moveMode: 'energy',
      move: { actual: 0, goal: null, unit: null }, exercise: { actual: null, goal: null, unit: null }
    });
    expect(normalizedRingSummarySchema.safeParse(incomplete).success).toBe(true);
  });

  it('preserves missing mode as unknown instead of inferring it from energy samples', () => {
    const payload = structuredClone(fixture);
    delete (payload.samples[4].activitySummary as Record<string, unknown>).activityMoveMode;
    const normalized = mapPayload(payload, dumpKey, 'fixture-owner');
    expect(normalized.ringSummaries[0]).toMatchObject({ moveMode: null, move: { actual: null, goal: null, unit: null } });
    expect(normalized.samples.some((sample) => sample.metric === 'active_energy_burned')).toBe(true);
  });

  it('supports declared Move-time summaries and source-name fallback identities', () => {
    const payload = structuredClone(fixture);
    const sample = payload.samples[4];
    sample.source = { name: 'Apple\u00a0Fitness' } as typeof sample.source;
    Object.assign(sample.activitySummary!, { activityMoveMode: 2, appleMoveTime: 20, appleMoveTimeGoal: 30 });
    expect(mapPayload(payload, dumpKey, 'fixture-owner').ringSummaries[0]).toMatchObject({
      sourceIdentity: 'com.apple.Fitness', moveMode: 'time', move: { actual: 20, goal: 30, unit: 'min' }
    });
  });

  it('quarantines malformed revision timestamps without promoting receipt time', () => {
    const payload = { ...fixture, createdAt: '2026-02-30T18:08:50Z' };
    expect(mapPayload(payload, dumpKey, 'fixture-owner').ringSummaries[0].revisionAt).toBeNull();
  });

  it('does not synthesize score summaries from metrics-v1 or unknown formats', () => {
    expect(mapPayload({ data: { metrics: [] } }, dumpKey, 'fixture-owner').ringSummaries).toEqual([]);
    expect(mapPayload({}, dumpKey, 'fixture-owner').ringSummaries).toEqual([]);
  });
});
