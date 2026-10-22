import { z } from 'zod';
import { KNOWN_METRIC_NAMES, METRIC_CATEGORIES } from './metrics';

/** Every wire timestamp includes an explicit UTC/offset designator. */
export const apiTimestampSchema = z.iso.datetime({ offset: true });
export const knownMetricSchema = z.enum(KNOWN_METRIC_NAMES);
export const MAX_SAMPLE_RANGE_MS = 31 * 24 * 60 * 60 * 1000;

interface ExactTimestamp { seconds: number; fraction: string }

/** Keep decimal fractions exact; Date.parse alone truncates sub-ms bounds. */
function exactTimestamp(value: string): ExactTimestamp {
  const match = /^(.+T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) throw new RangeError('Invalid timestamp');
  const seconds = Date.parse(`${match[1]}${match[3]}`) / 1000;
  if (!Number.isFinite(seconds)) throw new RangeError('Invalid timestamp');
  return { seconds, fraction: (match[2] ?? '').replace(/0+$/, '') };
}

function compareExact(left: ExactTimestamp, right: ExactTimestamp): number {
  if (left.seconds !== right.seconds) return left.seconds < right.seconds ? -1 : 1;
  const precision = Math.max(left.fraction.length, right.fraction.length);
  const a = left.fraction.padEnd(precision, '0'), b = right.fraction.padEnd(precision, '0');
  return a === b ? 0 : a < b ? -1 : 1;
}

export function compareApiTimestamps(left: string, right: string): number {
  return compareExact(exactTimestamp(left), exactTimestamp(right));
}

/** Normalize offsets/equivalent decimal forms without discarding precision. */
export function canonicalApiTimestamp(value: string): string {
  const parsed = exactTimestamp(value);
  const whole = new Date(parsed.seconds * 1000).toISOString().replace(/\.000Z$/, '');
  return `${whole}.${parsed.fraction.padEnd(3, '0')}Z`;
}

/** App observations use millisecond timestamps; ceil both [from,to) bounds. */
export function ceilApiTimestampToMillisecond(value: string): string {
  const parsed = exactTimestamp(value);
  const milliseconds = Number(parsed.fraction.slice(0, 3).padEnd(3, '0'));
  const remainder = /[1-9]/.test(parsed.fraction.slice(3)) ? 1 : 0;
  return new Date(parsed.seconds * 1000 + milliseconds + remainder).toISOString();
}

export const apiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string() })
});

export const currentUserSchema = z.object({ id: z.string(), name: z.string() });
export const metricDefinitionSchema = z.object({
  id: knownMetricSchema,
  displayName: z.string(),
  category: z.enum(METRIC_CATEGORIES),
  unit: z.string()
});
export const metricsResponseSchema = z.object({ items: z.array(metricDefinitionSchema) });

export const healthSamplesQuerySchema = z.object({
  metric: knownMetricSchema,
  from: apiTimestampSchema.describe('Inclusive sample start time, with UTC or an explicit offset.'),
  to: apiTimestampSchema.describe('Exclusive sample start time. Must be after from and at most 31 days later.'),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().min(1).max(4096).optional()
}).superRefine((query, ctx) => {
  let valid = false;
  try {
    const from = exactTimestamp(query.from), to = exactTimestamp(query.to);
    valid = compareExact(to, from) > 0 && compareExact(to, { ...from, seconds: from.seconds + MAX_SAMPLE_RANGE_MS / 1000 }) <= 0;
  } catch { /* The timestamp schemas report malformed input. */ }
  if (!valid) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'Range must be greater than zero and no more than 31 days.' });
  }
});

/** Decrypted domain values only; storage lineage and key material are private. */
export const healthSampleSchema = z.object({
  id: z.string(),
  metric: knownMetricSchema,
  time: apiTimestampSchema,
  endedAt: apiTimestampSchema,
  value: z.number().finite(),
  valueMin: z.number().finite().nullable(),
  valueMax: z.number().finite().nullable(),
  unit: z.string(),
  sourceName: z.string(),
  device: z.string().nullable(),
  extId: z.string().nullable()
});
export const healthSamplesResponseSchema = z.object({
  items: z.array(healthSampleSchema),
  nextCursor: z.string().nullable()
});

export const ingestionTokenSchema = z.object({
  id: z.string(), name: z.string(), createdAt: apiTimestampSchema,
  revokedAt: apiTimestampSchema.nullable()
});
export const createIngestionTokenSchema = z.object({ name: z.string().trim().min(1).max(80) });
export const createIngestionTokenResponseSchema = z.object({
  token: ingestionTokenSchema,
  secret: z.string().describe('Returned once. Store securely; it cannot be retrieved later.')
});
export const ingestionTokensResponseSchema = z.object({ items: z.array(ingestionTokenSchema) });
export const revokeIngestionTokenResponseSchema = z.object({ revoked: z.literal(true) });

export const ingestStatsSchema = z.object({
  format: z.enum(['health-exporter-v1', 'metrics-v1', 'unknown']),
  received: z.number().int().nonnegative(),
  mapped: z.number().int().nonnegative(),
  dropped: z.number().int().nonnegative(),
  droppedBy: z.record(z.string(), z.number().int().nonnegative())
});
export const hookSuccessSchema = z.object({
  ok: z.literal(true), dumpKey: z.string(), stored: z.number().int().nonnegative().optional(),
  ingest: ingestStatsSchema
});
export const hookStorageFailureSchema = z.object({
  ok: z.literal(false), dumpKey: z.string().optional(),
  error: z.string(), ingest: ingestStatsSchema.optional()
});

export type HealthSamplesQuery = z.infer<typeof healthSamplesQuerySchema>;
export type HealthSampleDto = z.infer<typeof healthSampleSchema>;
export type HealthSamplesResponse = z.infer<typeof healthSamplesResponseSchema>;
export type CreateIngestionTokenInput = z.infer<typeof createIngestionTokenSchema>;
export type IngestionTokenDto = z.infer<typeof ingestionTokenSchema>;
