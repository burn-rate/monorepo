import type { HealthSampleDto } from '@burn-rate/api-schema';

/**
 * Demo samples rendered on the dashboard while an account has nothing
 * recorded yet, so the graphs show a plausible day instead of empty states.
 * Everything is derived from a fixed table relative to `now` (no randomness),
 * so charts render the same shape on every load.
 */

const MINUTE_MS = 60 * 1000;
/** Baseline heart rate while seated, bpm. */
const RESTING_BPM = 80;

/** One standing block: minutes back from `now` it starts, its length, and the heart rate it drives. */
interface StandBlock {
  startsMinAgo: number;
  minutes: number;
  peakBpm: number;
}

/** A few standing blocks spread across the last two hours; the third is the "active" one. */
const STAND_BLOCKS: StandBlock[] = [
  { startsMinAgo: 112, minutes: 8, peakBpm: 100 },
  { startsMinAgo: 94, minutes: 4, peakBpm: 100 },
  { startsMinAgo: 68, minutes: 10, peakBpm: 140 },
  { startsMinAgo: 41, minutes: 6, peakBpm: 100 },
  { startsMinAgo: 14, minutes: 3, peakBpm: 100 }
];

/** Epoch ms for a block's start/end, `now` anchored. */
function blockRange(block: StandBlock, now: number): { from: number; to: number } {
  return {
    from: now - block.startsMinAgo * MINUTE_MS,
    to: now - (block.startsMinAgo - block.minutes) * MINUTE_MS
  };
}

/** Sample boilerplate shared by every demo record. */
function demoSample(index: string, metric: HealthSampleDto['metric'], unit: string): Pick<HealthSampleDto, 'id' | 'sourceName' | 'device' | 'extId' | 'metric' | 'unit'> {
  return { id: `demo-${index}`, metric, unit, sourceName: 'burn-rate demo', device: null, extId: null };
}

/** Stand-time samples: one [time, endedAt) interval per block, valued in minutes. */
export function mockStandSamples(now: number): HealthSampleDto[] {
  return STAND_BLOCKS.map((block, i) => {
    const { from, to } = blockRange(block, now);
    return {
      ...demoSample(`stand-${i}`, 'stand_time', 'min'),
      time: new Date(from).toISOString(),
      endedAt: new Date(to).toISOString(),
      value: block.minutes,
      valueMin: null,
      valueMax: null
    };
  });
}

/**
 * Heart-rate samples every 5 minutes across the two-hour window: seated at
 * RESTING_BPM with a small deterministic wobble, rising to each block's peak
 * mid-block (140 for the active one), and carrying a ±3 bpm min/max band.
 */
export function mockHeartSamples(now: number): HealthSampleDto[] {
  const WINDOW_MIN = 120;
  const STEP_MIN = 5;
  const samples: HealthSampleDto[] = [];
  // Grid samples plus one exactly at each block's midpoint, where the rise peaks.
  const times: Array<{ minute: number; key: string | number }> = [];
  for (let minute = WINDOW_MIN; minute >= 0; minute -= STEP_MIN) times.push({ minute, key: minute });
  for (const block of STAND_BLOCKS) times.push({ minute: block.startsMinAgo - block.minutes / 2, key: `mid-${block.startsMinAgo}` });
  times.sort((a, b) => b.minute - a.minute);
  for (const { minute, key } of times) {
    const t = now - minute * MINUTE_MS;
    let bpm = RESTING_BPM + Math.round(Math.sin(t / (7 * MINUTE_MS)) * 2);
    let min = bpm - 3;
    let max = bpm + 3;
    for (const block of STAND_BLOCKS) {
      const { from, to } = blockRange(block, now);
      if (t < from || t >= to) continue; // [from, to) intervals, as everywhere else.
      const rise = Math.sin((Math.PI * (t - from)) / (to - from));
      bpm = Math.round(RESTING_BPM + (block.peakBpm - RESTING_BPM) * rise);
      min = bpm - 4;
      max = bpm + 4;
    }
    const iso = new Date(t).toISOString();
    samples.push({
      ...demoSample(`heart-${key}`, 'heart_rate', 'bpm'),
      time: iso,
      endedAt: iso,
      value: bpm,
      valueMin: min,
      valueMax: max
    });
  }
  return samples;
}

/**
 * Active-energy samples, one per stand block: 0 kcal while seated (no sample
 * at all) and 1–5 kcal per standing minute scaled by the block's heart rate.
 */
export function mockEnergySamples(now: number): HealthSampleDto[] {
  return STAND_BLOCKS.map((block, i) => {
    const { from, to } = blockRange(block, now);
    const kcalPerMinute = 1 + (4 * (block.peakBpm - RESTING_BPM)) / 60;
    return {
      ...demoSample(`energy-${i}`, 'active_energy_burned', 'kcal'),
      time: new Date(from).toISOString(),
      endedAt: new Date(to).toISOString(),
      value: Math.round(block.minutes * kcalPerMinute * 10) / 10,
      valueMin: null,
      valueMax: null
    };
  });
}
