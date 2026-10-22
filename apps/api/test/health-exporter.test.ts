import { describe, expect, it } from 'vitest';
import { normalizedSampleSchema } from '@burn-rate/api-schema';
import { mapPayload } from '../src/ingest';
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
});
