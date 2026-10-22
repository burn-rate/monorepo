import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HealthSampleDto } from '@burn-rate/api-schema';
import { bucketSums, fetchMetricSamples, startOfHour, toPoints } from '../src/lib/metrics';

function sample(overrides: Partial<HealthSampleDto> = {}): HealthSampleDto {
  return {
    id: 's1',
    metric: 'active_energy_burned',
    time: '2026-10-22T10:00:00.000Z',
    endedAt: '2026-10-22T10:05:00.000Z',
    value: 5,
    valueMin: null,
    valueMax: null,
    unit: 'kcal',
    sourceName: 'Test',
    device: null,
    extId: null,
    ...overrides
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('fetchMetricSamples', () => {
  it('follows the cursor and returns samples sorted oldest first', async () => {
    const pages = [
      {
        body: {
          items: [sample({ id: 'b', time: '2026-10-22T10:05:00.000Z' }), sample({ id: 'c' })],
          nextCursor: 'cursor-1'
        }
      },
      {
        body: {
          items: [sample({ id: 'a', time: '2026-10-22T09:55:00.000Z' })],
          nextCursor: null
        }
      }
    ];
    const fetchMock = vi.fn(async () => {
      const page = pages[fetchMock.mock.calls.length - 1];
      return Response.json(page.body);
    });
    vi.stubGlobal('fetch', fetchMock);

    const samples = await fetchMetricSamples(
      'https://api.example.com',
      'stand_time',
      new Date('2026-10-22T09:00:00.000Z'),
      new Date('2026-10-22T11:00:00.000Z')
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [firstUrl, firstInit] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(firstInit.credentials).toBe('include');
    expect(firstUrl.searchParams.get('metric')).toBe('stand_time');
    expect(firstUrl.searchParams.get('limit')).toBe('500');
    expect(firstUrl.searchParams.get('cursor')).toBeNull();
    const secondUrl = (fetchMock.mock.calls[1][0] as URL).searchParams;
    expect(secondUrl.get('cursor')).toBe('cursor-1');
    // a: 09:55, c: 10:00 (default), b: 10:05
    expect(samples.map((entry) => entry.id)).toEqual(['a', 'c', 'b']);
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 500 })));
    await expect(
      fetchMetricSamples(
        'https://api.example.com',
        'heart_rate',
        new Date('2026-10-22T09:00:00.000Z'),
        new Date('2026-10-22T11:00:00.000Z')
      )
    ).rejects.toThrow('failed (500)');
  });

  it('throws when the response violates the contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: 'not-a-list' })));
    await expect(
      fetchMetricSamples(
        'https://api.example.com',
        'heart_rate',
        new Date('2026-10-22T09:00:00.000Z'),
        new Date('2026-10-22T11:00:00.000Z')
      )
    ).rejects.toThrow();
  });
});

describe('bucketSums', () => {
  const HOUR = 60 * 60 * 1000;
  const start = Date.parse('2026-10-22T10:00:00.000Z');

  it('prorates a sample across the buckets it spans', () => {
    // 20 minutes of stand time from 10:00 → 10:20 over 10-minute buckets.
    const sums = bucketSums([sample({ metric: 'stand_time', time: '2026-10-22T10:00:00.000Z', endedAt: '2026-10-22T10:20:00.000Z', value: 20 })], {
      start,
      bucketMs: 10 * 60 * 1000,
      count: 3
    });
    expect(sums).toEqual([10, 10, 0]);
  });

  it('splits a sample across a bucket boundary', () => {
    const sums = bucketSums([sample({ time: '2026-10-22T10:05:00.000Z', endedAt: '2026-10-22T10:15:00.000Z', value: 10 })], {
      start,
      bucketMs: 10 * 60 * 1000,
      count: 2
    });
    expect(sums).toEqual([5, 5]);
  });

  it('clamps a sample that starts before the window', () => {
    const sums = bucketSums([sample({ time: '2026-10-22T09:55:00.000Z', endedAt: '2026-10-22T10:05:00.000Z', value: 10 })], {
      start,
      bucketMs: 10 * 60 * 1000,
      count: 2
    });
    expect(sums).toEqual([5, 0]);
  });

  it('lands an instantaneous sample whole in its bucket', () => {
    const sums = bucketSums([sample({ time: '2026-10-22T10:12:00.000Z', endedAt: '2026-10-22T10:12:00.000Z', value: 3 })], {
      start,
      bucketMs: 10 * 60 * 1000,
      count: 3
    });
    expect(sums).toEqual([0, 3, 0]);
  });

  it('ignores samples outside [start, end)', () => {
    const sums = bucketSums(
      [
        sample({ time: '2026-10-22T09:00:00.000Z', endedAt: '2026-10-22T09:30:00.000Z', value: 30 }),
        sample({ time: '2026-10-22T11:00:00.000Z', endedAt: '2026-10-22T11:30:00.000Z', value: 30 }),
        sample({ time: '2026-10-22T10:00:00.000Z', endedAt: '2026-10-22T10:30:00.000Z', value: 30 })
      ],
      { start, bucketMs: HOUR, count: 1 }
    );
    expect(sums).toEqual([30]);
  });
});

describe('toPoints', () => {
  it('maps samples to sorted epoch-ms points', () => {
    const points = toPoints([
      sample({ id: 'late', time: '2026-10-22T10:10:00.000Z', value: 90, valueMin: 80, valueMax: 100 }),
      sample({ id: 'early', time: '2026-10-22T10:00:00.000Z', value: 70, valueMin: null, valueMax: null })
    ]);
    expect(points.map((point) => point.value)).toEqual([70, 90]);
    expect(points[1]).toEqual({
      t: Date.parse('2026-10-22T10:10:00.000Z'),
      value: 90,
      min: 80,
      max: 100
    });
  });
});

describe('startOfHour', () => {
  it('floors to the local hour', () => {
    const at = new Date(2026, 9, 22, 14, 37); // local time, 14:37
    expect(startOfHour(at)).toBe(new Date(2026, 9, 22, 14).getTime());
  });
});
