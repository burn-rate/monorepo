import {
  healthSamplesResponseSchema,
  type HealthSampleDto,
  type KnownMetricName
} from '@burn-rate/api-schema';

/**
 * Client-side access to GET /api/health/samples. Values arrive decrypted but
 * unaggregated (storage encrypts values, so the server cannot bucket them),
 * which makes the helpers here the aggregation point for graphs.
 */

const PAGE_LIMIT = 500;
/** Safety valve for the cursor loop: 40 pages ≈ 20k samples per metric. */
const MAX_PAGES = 40;

/**
 * Fetch every sample for metric over [from, to), following cursor pages.
 * Stops early at MAX_PAGES (graphs tolerate a truncated tail) and sorts
 * oldest → newest regardless of server page order.
 */
export async function fetchMetricSamples(
  baseUrl: string,
  metric: KnownMetricName,
  from: Date,
  to: Date
): Promise<HealthSampleDto[]> {
  const items: HealthSampleDto[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL('/api/health/samples', baseUrl);
    url.searchParams.set('metric', metric);
    url.searchParams.set('from', from.toISOString());
    url.searchParams.set('to', to.toISOString());
    url.searchParams.set('limit', String(PAGE_LIMIT));
    if (cursor) url.searchParams.set('cursor', cursor);

    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`Health samples failed (${response.status})`);
    const body = healthSamplesResponseSchema.parse(await response.json());

    items.push(...body.items);
    if (!body.nextCursor) return items.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    cursor = body.nextCursor;
  }
  return items.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

/** Plot point: epoch ms plus the value and, when present, its min/max band. */
export interface SamplePoint {
  t: number;
  value: number;
  min: number | null;
  max: number | null;
}

/** Flatten samples (e.g. heart_rate) into time-sorted plot points. */
export function toPoints(samples: HealthSampleDto[]): SamplePoint[] {
  return samples
    .map((sample) => ({
      t: Date.parse(sample.time),
      value: sample.value,
      min: sample.valueMin,
      max: sample.valueMax
    }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Total a sum-type metric (kcal, stand minutes) into fixed buckets. Samples
 * are [time, endedAt) intervals that may span buckets, so each bucket gets
 * the prorated share of the value (overlap / sample span). Buckets are
 * indexed from `start`, each `bucketMs` wide, `count` total.
 */
export function bucketSums(
  samples: HealthSampleDto[],
  options: { start: number; bucketMs: number; count: number }
): number[] {
  const sums = new Array<number>(options.count).fill(0);
  const end = options.start + options.bucketMs * options.count;
  for (const sample of samples) {
    const from = Date.parse(sample.time);
    const to = Date.parse(sample.endedAt);
    if (from >= end || to <= options.start) continue;

    // Instantaneous samples (endedAt === time) land whole in their bucket.
    if (to <= from) {
      const bucket = Math.floor((from - options.start) / options.bucketMs);
      if (bucket >= 0 && bucket < options.count) sums[bucket] += sample.value;
      continue;
    }

    const span = to - from;
    const first = Math.max(0, Math.floor((from - options.start) / options.bucketMs));
    const last = Math.min(options.count - 1, Math.floor((to - options.start - 1) / options.bucketMs));
    for (let bucket = first; bucket <= last; bucket++) {
      const bucketStart = options.start + bucket * options.bucketMs;
      const overlap = Math.min(to, bucketStart + options.bucketMs) - Math.max(from, bucketStart);
      if (overlap > 0) sums[bucket] += (sample.value * overlap) / span;
    }
  }
  return sums;
}

/** Start of the local hour containing `at`, as epoch ms. */
export function startOfHour(at: Date): number {
  const hour = new Date(at);
  hour.setMinutes(0, 0, 0);
  return hour.getTime();
}
