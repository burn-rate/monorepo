import { describe, expect, it } from 'vitest';
import type { HealthSampleDto } from '@burn-rate/api-schema';
import { mockEnergySamples, mockHeartSamples, mockStandSamples } from '../src/lib/mock';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const now = Date.parse('2026-10-22T12:00:00.000Z');

/** Ranges of the demo stand blocks, mirrored from the generator's fixed table. */
const blockRanges = mockStandSamples(now).map((sample) => ({
  from: Date.parse(sample.time),
  to: Date.parse(sample.endedAt)
}));

describe('mockStandSamples', () => {
  it('has a few 1-10 minute blocks throughout the past two hours', () => {
    expect(blockRanges.length).toBeGreaterThanOrEqual(3);
    for (const sample of mockStandSamples(now)) {
      expect(sample.value).toBeGreaterThanOrEqual(1);
      expect(sample.value).toBeLessThanOrEqual(10);
      expect(Date.parse(sample.endedAt)).toBeLessThanOrEqual(now);
      expect(Date.parse(sample.time)).toBeGreaterThanOrEqual(now - 2 * HOUR);
    }
  });

  it('is deterministic for a given `now`', () => {
    expect(mockStandSamples(now)).toEqual(mockStandSamples(now));
  });
});

describe('mockHeartSamples', () => {
  const heart = mockHeartSamples(now);

  it('covers the two-hour window at a resting baseline', () => {
    expect(heart.length).toBeGreaterThan(20);
    const seated = heart.filter(
      (sample) => !blockRanges.some(({ from, to }) => Date.parse(sample.time) >= from && Date.parse(sample.time) < to)
    );
    for (const sample of seated) {
      expect(sample.value).toBeGreaterThanOrEqual(75);
      expect(sample.value).toBeLessThanOrEqual(85);
    }
  });

  it('peaks at 140 bpm during the active session and 100 for the other stands', () => {
    const peaks = blockRanges.map(({ from, to }) => {
      const inBlock = heart
        .filter((sample) => Date.parse(sample.time) >= from && Date.parse(sample.time) < to)
        .map((sample) => sample.value);
      return Math.max(...inBlock);
    });
    expect(peaks.filter((peak) => peak === 140)).toHaveLength(1);
    expect(peaks.filter((peak) => peak === 100)).toHaveLength(peaks.length - 1);
  });

  it('carries a min/max band around each value', () => {
    for (const sample of heart) {
      expect(sample.valueMin).toBeLessThan(sample.value);
      expect(sample.valueMax).toBeGreaterThan(sample.value);
    }
  });
});

describe('mockEnergySamples', () => {
  const energy = mockEnergySamples(now);

  it('burns 1-5 kcal per standing minute, nothing while seated', () => {
    expect(energy.length).toBe(blockRanges.length);
    for (const sample of energy) {
      const minutes = (Date.parse(sample.endedAt) - Date.parse(sample.time)) / MINUTE;
      const perMinute = sample.value / minutes;
      expect(perMinute).toBeGreaterThanOrEqual(1);
      expect(perMinute).toBeLessThanOrEqual(5);
    }
  });

  it('places every sample inside a stand block', () => {
    const inside = (sample: HealthSampleDto) =>
      blockRanges.some(
        ({ from, to }) => Date.parse(sample.time) >= from && Date.parse(sample.endedAt) <= to
      );
    expect(energy.every(inside)).toBe(true);
  });

  it('rewards the active block with the highest burn', () => {
    const busiest = energy.reduce((a, b) => (b.value > a.value ? b : a));
    expect(busiest.value).toBe(50); // 10 minutes at 5 kcal/min
  });
});
