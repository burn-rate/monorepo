import { canonicalApiTimestamp, ceilApiTimestampToMillisecond, compareApiTimestamps, healthSamplesQuerySchema, normalizedSampleSchema, type HealthSampleDto, type HealthSamplesResponse, type NormalizedSample } from '@burn-rate/api-schema';
import type { Sql } from './db';
import { base64url, createUserKeyring, CryptoFailure, unbase64url, type CryptoConfig, type Envelope, type UserKeyring } from './crypto';
import { normalizeSourceName } from './ingest/shared';

interface SensitiveSample {
  value: number;
  valueMin: number | null;
  valueMax: number | null;
  unit: string;
  sourceName: string;
  device: string | null;
  extId: string | null;
  attrs: unknown;
  dumpKey: string | null;
}

interface SampleRow {
  id: string;
  owner_id: string;
  metric: NormalizedSample['metric'];
  time: Date | string;
  ended_at: Date | string;
  source_digest: string;
  envelope: Envelope;
  valid_precision?: boolean;
}

export interface SampleQuery { metric: string; from: string; to: string; limit?: number; cursor?: string }
export type SampleItem = HealthSampleDto;
export type SamplePage = HealthSamplesResponse;
export class InvalidSampleQuery extends Error {
  readonly code = 'invalid-sample-query';
  constructor() { super('Invalid sample range, page size, or cursor'); }
}

function iso(value: Date | string): string { return new Date(value).toISOString(); }
function metadata(row: SampleRow): readonly string[] { return [row.metric, iso(row.time), iso(row.ended_at), row.source_digest]; }

/** The domain-separated HMAC ID is stable even when rows are written concurrently. */
export async function sampleIdentity(keys: UserKeyring, sample: NormalizedSample) {
  const sourceDigest = await keys.digest('source', [normalizeSourceName(sample.sourceName)]);
  const id = await keys.digest('sample', [sample.metric, iso(sample.time), iso(sample.endedAt), sourceDigest]);
  return { id, sourceDigest };
}

export async function storeEncryptedSamples(sql: Sql, config: CryptoConfig, ownerId: string, samples: NormalizedSample[]): Promise<number> {
  if (!samples.length) return 0;
  const keys = await createUserKeyring(sql, config, ownerId);
  // Validate every sample before any writes, and never accept a payload's owner.
  const valid = samples.map(sample => ({ ...normalizedSampleSchema.parse({ ...sample, userId: ownerId }),
    attrs: (sample as NormalizedSample & { attrs?: unknown }).attrs ?? null }));
  let stored = 0;
  for (let offset = 0; offset < valid.length; offset += 100) {
    const batch = valid.slice(offset, offset + 100);
    const values: unknown[] = [];
    for (const sample of batch) {
      const { id, sourceDigest } = await sampleIdentity(keys, sample);
      const row: SampleRow = { id, owner_id: ownerId, metric: sample.metric, time: sample.time,
        ended_at: sample.endedAt, source_digest: sourceDigest, envelope: undefined as never };
      const sensitive: SensitiveSample = { value: sample.value, valueMin: sample.valueMin, valueMax: sample.valueMax,
        unit: sample.unit, sourceName: normalizeSourceName(sample.sourceName), device: sample.device,
        extId: sample.extId, attrs: (sample as NormalizedSample & { attrs?: unknown }).attrs ?? null, dumpKey: sample.dumpKey };
      const envelope = await keys.encrypt({ ownerId, kind: 'sample', id, metadata: metadata(row) }, sensitive);
      values.push(id, ownerId, sample.metric, sample.time, sample.endedAt, sourceDigest, JSON.stringify(envelope));
    }
    // One statement per bounded batch is atomic; retries converge after partial uploads.
    // Fold duplicates within a batch so PostgreSQL never updates a row twice per statement.
    const unique = new Map<string, unknown[]>();
    for (let i = 0; i < values.length; i += 7) unique.set(`${values[i]}:${iso(values[i + 3] as Date)}`, values.slice(i, i + 7));
    const deduped = [...unique.values()].flat();
    const dedupedTuples = [...unique.values()].map((_, row) => `(${Array.from({ length: 7 }, (_, i) => `$${row * 7 + i + 1}${i === 6 ? '::jsonb' : ''}`).join(',')})`);
    await sql.query(`INSERT INTO encrypted_health_samples (id, owner_id, metric, time, ended_at, source_digest, envelope)
      VALUES ${dedupedTuples.join(',')}
      ON CONFLICT (owner_id, metric, time, ended_at, source_digest) DO UPDATE
      SET envelope = EXCLUDED.envelope, ingested_at = now()
      WHERE encrypted_health_samples.id = EXCLUDED.id`, deduped);
    stored += batch.length;
  }
  return stored;
}

export function validateSampleQuery(query: SampleQuery): Required<Omit<SampleQuery, 'cursor'>> & { cursor?: string } {
  const parsed = healthSamplesQuerySchema.safeParse(query);
  if (!parsed.success) throw new InvalidSampleQuery();
  return { ...parsed.data, from: canonicalApiTimestamp(parsed.data.from), to: canonicalApiTimestamp(parsed.data.to) };
}

async function cursorPosition(keys: UserKeyring, query: ReturnType<typeof validateSampleQuery>): Promise<[string, string] | null> {
  if (!query.cursor) return null;
  try {
    const [encoded, signature, extra] = query.cursor.split('.');
    if (!encoded || !signature || extra !== undefined) throw new InvalidSampleQuery();
    const values: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(unbase64url(encoded)));
    if (!Array.isArray(values) || values.length !== 3 || values.some(value => typeof value !== 'string')) throw new InvalidSampleQuery();
    const [version, time, id] = values as string[];
    const binding = [version, query.metric, query.from, query.to, time, id];
    if (version !== '1' || !/^[A-Za-z0-9_-]{43}$/.test(id) || iso(time) !== time || compareApiTimestamps(time, query.from) < 0 || compareApiTimestamps(time, query.to) >= 0 || !await keys.verifyDigest('cursor', binding, signature)) throw new InvalidSampleQuery();
    return [time, id];
  } catch { throw new InvalidSampleQuery(); }
}

export async function listEncryptedSamples(sql: Sql, config: CryptoConfig, ownerId: string, input: SampleQuery): Promise<SamplePage> {
  const query = validateSampleQuery(input);
  const keys = await createUserKeyring(sql, config, ownerId);
  const position = await cursorPosition(keys, query);
  const { rows } = await sql.query<SampleRow>(`SELECT id, owner_id, metric, time, ended_at, source_digest, envelope,
    (time = date_trunc('milliseconds', time) AND ended_at = date_trunc('milliseconds', ended_at)) AS valid_precision
    FROM encrypted_health_samples WHERE owner_id = $1 AND metric = $2 AND time >= $3 AND time < $4
    ${position ? 'AND (time, id) > ($6::timestamptz, $7::text)' : ''}
    ORDER BY time ASC, id ASC LIMIT $5`, [ownerId, query.metric, ceilApiTimestampToMillisecond(query.from), ceilApiTimestampToMillisecond(query.to), query.limit + 1, ...(position ?? [])]);
  const items: SampleItem[] = [];
  // No output escapes until all records in the returned page have authenticated.
  for (const row of rows.slice(0, query.limit)) {
    if (row.owner_id !== ownerId || row.valid_precision !== true) throw new CryptoFailure();
    const value = await keys.decrypt<SensitiveSample>({ ownerId, kind: 'sample', id: row.id, metadata: metadata(row) }, row.envelope);
    try {
      normalizedSampleSchema.parse({ ...value, userId: ownerId, metric: row.metric, time: new Date(row.time), endedAt: new Date(row.ended_at) });
    } catch { throw new CryptoFailure(); }
    items.push({ id: row.id, metric: row.metric, time: iso(row.time), endedAt: iso(row.ended_at),
      value: value.value, valueMin: value.valueMin, valueMax: value.valueMax, unit: value.unit,
      sourceName: value.sourceName, device: value.device, extId: value.extId });
  }
  let nextCursor: string | null = null;
  if (rows.length > query.limit && items.length) {
    const last = items[items.length - 1];
    const position = ['1', last.time, last.id];
    const binding = ['1', query.metric, query.from, query.to, last.time, last.id];
    nextCursor = `${base64url(new TextEncoder().encode(JSON.stringify(position)))}.${await keys.digest('cursor', binding)}`;
  }
  return { items, nextCursor };
}
