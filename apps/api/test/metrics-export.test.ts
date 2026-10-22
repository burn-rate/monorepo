import { describe, expect, it } from 'vitest';
import { normalizedSampleSchema } from '@burn-rate/api-schema';
import { mapPayload } from '../src/ingest';
import { parseOffsetDate } from '../src/ingest/shared';
import fixture from './fixtures/metrics-v1.json';

const dumpKey = 'hook/2026-10-22T18:09:38.957Z-fixture.json';

describe('parseOffsetDate', () => {
  it('converts offset-local dates to UTC instants', () => {
    expect(parseOffsetDate('2026-10-21 00:09:00 -0700').toISOString()).toBe('2026-10-21T07:09:00.000Z');
    expect(parseOffsetDate('2026-10-21 05:09:00 +0200').toISOString()).toBe('2026-10-21T03:09:00.000Z');
  });

  it('throws on malformed dates', () => {
    expect(() => parseOffsetDate('not-a-date')).toThrow();
    expect(() => parseOffsetDate('2026-10-21T00:09:00Z')).toThrow(); // ISO belongs to format A
  });
});

describe('mapPayload: metrics-v1', () => {
  const result = mapPayload(fixture, dumpKey);

  it('reports stats: 10 received, 7 mapped, 3 dropped', () => {
    // received counts every raw point, including points from unknown metrics;
    // mapped = 2 heart_rate + 2 stand_time + stand_hour + active + basal;
    // dropped = step_count, sleep_analysis, and one bad heart_rate_variability date.
    expect(result.format).toBe('metrics-v1');
    expect(result.received).toBe(10);
    expect(result.mapped).toBe(7);
    expect(result.dropped).toBe(3);
    expect(result.droppedBy).toEqual({
      'heart_rate_variability:bad-timestamp': 1,
      'sleep_analysis': 1,
      'step_count': 1
    });
  });

  it('maps heart_rate Avg/Min/Max into value/valueMin/valueMax with bpm unit', () => {
    const hr = result.samples.filter((s) => s.metric === 'heart_rate');
    expect(hr).toHaveLength(2);
    expect(hr[0]).toMatchObject({
      value: 79,
      valueMin: 79,
      valueMax: 79,
      unit: 'bpm',
      sourceName: 'Chris’s Apple Watch' // \u00a0 → space
    });
    // Instantaneous: endedAt === time.
    expect(hr[0].endedAt.getTime()).toBe(hr[0].time.getTime());
    expect(hr[0].time.toISOString()).toBe('2026-10-21T07:06:03.000Z');
  });

  it('treats stand_time as a one-minute bucket', () => {
    const stand = result.samples.find((s) => s.metric === 'stand_time');
    expect(stand).toMatchObject({ value: 0.2, unit: 'min' });
    expect(stand?.endedAt.getTime()).toBe(stand!.time.getTime() + 60_000);
  });

  it('maps export names to canonical metrics', () => {
    expect(result.samples.find((s) => s.metric === 'active_energy_burned')?.value).toBeCloseTo(0.0407);
    expect(result.samples.find((s) => s.metric === 'basal_energy_burned')?.value).toBeCloseTo(0.8335);
    expect(result.samples.find((s) => s.metric === 'stand_hour')?.value).toBe(1);
  });

  it('carries the dump key for lineage', () => {
    expect(result.samples.every((s) => s.dumpKey === dumpKey)).toBe(true);
  });

  it('produces schema-valid samples', () => {
    for (const sample of result.samples) {
      expect(() => normalizedSampleSchema.parse(sample)).not.toThrow();
    }
  });
});
