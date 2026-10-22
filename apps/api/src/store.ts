import type { NormalizedSample } from '@burn-rate/api-schema';
import type { Sql } from './db';

const CHUNK_SIZE = 500;
const COLUMN_COUNT = 12;

/**
 * Upsert normalized samples in batches. The conflict target matches the
 * hypertable's unique key; re-ingested overlaps (exporters re-deliver
 * overlapping windows) win with the newest payload.
 */
export async function storeSamples(sql: Sql, samples: NormalizedSample[]): Promise<number> {
  let stored = 0;

  for (let i = 0; i < samples.length; i += CHUNK_SIZE) {
    const chunk = samples.slice(i, i + CHUNK_SIZE);
    const values: unknown[] = [];

    const tuples = chunk.map((sample, row) => {
      const rowValues = [
        sample.userId,
        sample.metric,
        sample.time,
        sample.endedAt,
        sample.value,
        sample.valueMin,
        sample.valueMax,
        sample.unit,
        sample.sourceName,
        sample.device,
        sample.extId,
        sample.dumpKey
      ];
      values.push(...rowValues);

      const base = row * COLUMN_COUNT;
      return `(${rowValues.map((_, col) => `$${base + col + 1}`).join(', ')})`;
    });

    await sql.query(
      `INSERT INTO health_samples
         (user_id, metric, time, ended_at, value, value_min, value_max,
          unit, source_name, device, ext_id, dump_key)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (user_id, metric, time, ended_at, source_name) DO UPDATE
         SET value = EXCLUDED.value,
             value_min = EXCLUDED.value_min,
             value_max = EXCLUDED.value_max,
             ingested_at = now()`,
      values
    );
    stored += chunk.length;
  }

  return stored;
}
