import { z } from 'zod';
import { KNOWN_METRIC_NAMES } from './metrics';

/**
 * A health sample normalized for storage in the health_samples hypertable.
 * All variants of incoming webhook payloads map into this shape; the DB
 * upsert deduplicates on (userId, metric, time, endedAt, sourceName).
 */
export const normalizedSampleSchema = z.object({
  /** No payload carries user identity yet; the ingestor defaults this. */
  userId: z.string().min(1),
  metric: z.enum(KNOWN_METRIC_NAMES),
  /** Sample start. Hypertable partition column. */
  time: z.date(),
  /** Sample end; equals time for instantaneous samples. */
  endedAt: z.date(),
  value: z.number().finite(),
  /** Only populated when the source reports a range (heart_rate Min/Max). */
  valueMin: z.number().finite().nullable().default(null),
  valueMax: z.number().finite().nullable().default(null),
  unit: z.string().min(1),
  sourceName: z.string().min(1),
  device: z.string().nullable().default(null),
  /** Source-native id (e.g. HealthKit uuid) when the payload provides one. */
  extId: z.string().nullable().default(null),
  /** R2 object key of the raw dump this sample came from. */
  dumpKey: z.string().nullable().default(null)
});

export type NormalizedSample = z.infer<typeof normalizedSampleSchema>;

/** Counts returned by the ingest pipeline for logging and hook responses. */
export interface IngestStats {
  format: 'health-exporter-v1' | 'metrics-v1' | 'unknown';
  received: number;
  mapped: number;
  dropped: number;
  /** Raw metric/type identifiers that were dropped, with occurrence counts. */
  droppedBy: Record<string, number>;
}
