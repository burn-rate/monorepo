import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KNOWN_METRICS, type NormalizedSample } from '@burn-rate/api-schema';
import { getSql, type Sql } from '../src/db';
import { base64url, retainedKeyInventory, rewrapUserKeys, rotateDataKey, type CryptoConfig } from '../src/crypto';
import { listEncryptedSamples, storeEncryptedSamples } from '../src/encrypted-store';

/** Explicit opt-in: the caller supplies trusted TLS configuration and a URL.
 * This test never loads .env or changes existing application schemas/data.
 */
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('representative Timescale migration and encrypted storage', () => {
  it('applies fresh migrations, verifies policies, and reads/corrects compressed encrypted observations', async () => {
    const schema = `api_timescale_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const qualified = `"${schema}".encrypted_health_samples`;
    let sql: Sql | undefined;
    let created = false;
    let stage = 'connect';
    let primaryFailure: Error | undefined;
    try {
      sql = await getSql({ TIMESERIES_DB: { connectionString: process.env.TEST_DATABASE_URL! } });
      await sql.query("SET statement_timeout='60s'");
      const extension = await sql.query<{ version: string; namespace: string }>(`SELECT extversion AS version,
        extnamespace::regnamespace::text AS namespace FROM pg_extension WHERE extname='timescaledb'`);
      expect(extension.rows).toHaveLength(1);
      const extensionNamespace = extension.rows[0].namespace.replaceAll('"', '""');
      stage = 'create-isolated-schema';
      await sql.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await sql.query(`SET search_path TO "${schema}", "${extensionNamespace}", public`);
      stage = 'apply-migrations';
      for (const name of ['000_metrics.sql', '002_encrypted.sql', '004_auth.sql', '005_limits.sql', '006_activity_credit.sql']) {
        stage = `apply-${name}`;
        const migration = await readFile(new NodeURL(`../timescale/${name}`, import.meta.url), 'utf8');
        await sql.query('BEGIN');
        try { await sql.query(migration); await sql.query('COMMIT'); }
        catch (error) { await sql.query('ROLLBACK'); throw error; }
      }
      stage = 'verify-schema-and-policies';
      const metrics = await sql.query<{ count: string }>('SELECT count(*)::text AS count FROM metrics');
      expect(Number(metrics.rows[0].count)).toBe(Object.keys(KNOWN_METRICS).length);
      const legacy = await sql.query<{ absent: boolean }>('SELECT to_regclass($1) IS NULL AS absent', [`${schema}.health_samples`]);
      expect(legacy.rows[0].absent).toBe(true);
      const tables = await sql.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
        WHERE table_schema=$1 AND table_type='BASE TABLE'`, [schema]);
      expect(tables.rows.map(row => row.table_name)).toEqual(expect.arrayContaining([
        'metrics', 'encrypted_health_samples', 'health_user_keys', 'user', 'session',
        'passkey', 'verification', 'auth_onboarding', 'ingestion_tokens', 'api_rate_limits'
      ]));
      const columns = await sql.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns
        WHERE table_schema=$1 AND table_name='encrypted_health_samples'`, [schema]);
      expect(columns.rows.map(row => row.column_name).sort()).toEqual([
        'ended_at', 'envelope', 'id', 'ingested_at', 'metric', 'owner_id', 'source_digest', 'time'
      ]);
      const uniqueIndexes = await sql.query<{ definition: string }>(`SELECT pg_get_indexdef(indexrelid) AS definition
        FROM pg_index WHERE indrelid=$1::regclass AND indisunique`, [qualified]);
      expect(uniqueIndexes.rows.length).toBeGreaterThanOrEqual(2);
      expect(uniqueIndexes.rows.every(row => /\btime\b/.test(row.definition))).toBe(true);
      expect(uniqueIndexes.rows.some(row => row.definition.includes('source_digest'))).toBe(true);
      const compression = await sql.query<{ attname: string; segmentby_column_index: number | null; orderby_column_index: number | null; orderby_asc: boolean | null }>(`
        SELECT attname,segmentby_column_index,orderby_column_index,orderby_asc
        FROM timescaledb_information.compression_settings WHERE hypertable_schema=$1 AND hypertable_name='encrypted_health_samples'`, [schema]);
      expect(compression.rows.filter(row => row.segmentby_column_index !== null).sort((a, b) => a.segmentby_column_index! - b.segmentby_column_index!).map(row => row.attname)).toEqual(['owner_id', 'metric']);
      expect(compression.rows.find(row => row.orderby_column_index === 1)).toMatchObject({ attname: 'time', orderby_asc: false });
      const policy = await sql.query<{ job_id: number; correct_retention: boolean }>(`
        SELECT job_id, (config->>'compress_after')::interval = interval '14 days' AS correct_retention
        FROM timescaledb_information.jobs WHERE hypertable_schema=$1 AND hypertable_name='encrypted_health_samples' AND proc_name='policy_compression'`, [schema]);
      expect(policy.rows).toHaveLength(1);
      expect(policy.rows[0].correct_retention).toBe(true);
      // Prevent the scheduled policy from racing the deliberate compression exercise.
      await sql.query('SELECT alter_job($1, scheduled => false)', [policy.rows[0].job_id]);

      stage = 'encrypted-write-and-owner-isolation';
      const config: CryptoConfig = { ENCRYPTION_ENVIRONMENT: 'isolated-timescale-test', HEALTH_KEK_ID: 'test-kek-1', HEALTH_KEKS: JSON.stringify({ 'test-kek-1': base64url(crypto.getRandomValues(new Uint8Array(32))) }) };
      const day = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000 - 60 * 86_400_000);
      const sample = (minute: number, value = 72): NormalizedSample => ({
        userId: 'ignored-test-payload-owner', metric: 'heart_rate', time: new Date(day.getTime() + minute * 60_000), endedAt: new Date(day.getTime() + minute * 60_000),
        value, valueMin: 60, valueMax: 95, unit: 'bpm', sourceName: 'Isolated Timescale test source', device: 'Test device', extId: 'test-native-id', dumpKey: 'test-only-dump'
      });
      const range = { metric: 'heart_rate', from: day.toISOString(), to: new Date(day.getTime() + 86_400_000).toISOString() };
      await storeEncryptedSamples(sql, config, 'test-alice', [sample(0), sample(1)]);
      await storeEncryptedSamples(sql, config, 'test-bob', [sample(0, 88)]);
      const before = await listEncryptedSamples(sql, config, 'test-alice', range);
      expect(before.items).toHaveLength(2);
      expect((await listEncryptedSamples(sql, config, 'test-bob', range)).items.map(row => row.value)).toEqual([88]);
      const oldId = before.items[0].id;
      const beforeEnvelope = (await sql.query<{ envelope: { keyId: string; iv: string } }>('SELECT envelope FROM encrypted_health_samples WHERE owner_id=$1 AND id=$2', ['test-alice', oldId])).rows[0].envelope;

      stage = 'compress-and-read';
      const compressed = await sql.query<{ chunk: string }>(`SELECT compress_chunk(format('%I.%I',chunk_schema,chunk_name)::regclass, if_not_compressed=>true)::text AS chunk
        FROM timescaledb_information.chunks WHERE hypertable_schema=$1 AND hypertable_name='encrypted_health_samples'`, [schema]);
      expect(compressed.rows.length).toBeGreaterThan(0);
      const chunks = await sql.query<{ is_compressed: boolean }>(`SELECT is_compressed FROM timescaledb_information.chunks
        WHERE hypertable_schema=$1 AND hypertable_name='encrypted_health_samples'`, [schema]);
      expect(chunks.rows.every(row => row.is_compressed)).toBe(true);
      expect((await listEncryptedSamples(sql, config, 'test-alice', range)).items.map(row => row.value)).toEqual([72, 72]);

      stage = 'compressed-correction-replay-and-key-rotation';
      await rotateDataKey(sql, config, 'test-alice');
      await storeEncryptedSamples(sql, config, 'test-alice', [sample(0, 81), sample(0, 81)]);
      await storeEncryptedSamples(sql, config, 'test-alice', [sample(0, 81), sample(1)]);
      const corrected = await listEncryptedSamples(sql, config, 'test-alice', range);
      expect(corrected.items.map(row => row.value)).toEqual([81, 72]);
      expect(corrected.items[0].id).toBe(oldId);
      const afterEnvelope = (await sql.query<{ envelope: { keyId: string; iv: string } }>('SELECT envelope FROM encrypted_health_samples WHERE owner_id=$1 AND id=$2', ['test-alice', oldId])).rows[0].envelope;
      expect(afterEnvelope.keyId).not.toBe(beforeEnvelope.keyId);
      expect(afterEnvelope.iv).not.toBe(beforeEnvelope.iv);
      const rotated: CryptoConfig = { ...config, HEALTH_KEK_ID: 'test-kek-2', HEALTH_KEKS: JSON.stringify({ ...JSON.parse(config.HEALTH_KEKS), 'test-kek-2': base64url(crypto.getRandomValues(new Uint8Array(32))) }) };
      expect(await rewrapUserKeys(sql, rotated, 'test-alice')).toBe(3);
      const retained = await retainedKeyInventory(sql);
      expect(retained.filter(row => row.owner_id === 'test-alice' && row.state === 'retired')).toHaveLength(1);
      expect(retained.filter(row => row.owner_id === 'test-alice').every(row => row.kek_id === 'test-kek-2')).toBe(true);
      const restored = { ...rotated, HEALTH_KEKS: JSON.stringify({ 'test-kek-2': JSON.parse(rotated.HEALTH_KEKS)['test-kek-2'] }) };
      expect((await listEncryptedSamples(sql, restored, 'test-alice', range)).items.map(row => row.value)).toEqual([81, 72]);
      const counts = await sql.query<{ samples: string; alice: string }>(`SELECT count(*)::text AS samples,
        count(*) FILTER (WHERE owner_id='test-alice')::text AS alice FROM encrypted_health_samples`);
      expect(counts.rows[0]).toEqual({ samples: '3', alice: '2' });
      console.info(JSON.stringify({ code: 'timescale-integration-verified', timescaleVersion: extension.rows[0].version, migrations: 5, samples: 3, compressedChunks: compressed.rows.length }));
    } catch (error) {
      // Never let pg error objects expose connection details or SQL parameters.
      const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) ? ` (SQLSTATE ${error.code})` : '';
      primaryFailure = new Error(`Timescale integration failed at ${stage}${code}; inspect private database diagnostics.`);
    } finally {
      if (sql && created) {
        try {
          const jobs = await sql.query<{ job_id: number }>('SELECT job_id FROM timescaledb_information.jobs WHERE hypertable_schema=$1', [schema]).catch(() => ({ rows: [] }));
          for (const job of jobs.rows) await sql.query('SELECT delete_job($1)', [job.job_id]).catch(() => {});
          await sql.query(`DROP SCHEMA "${schema}" CASCADE`);
          const remaining = await sql.query<{ count: string }>('SELECT count(*)::text AS count FROM timescaledb_information.jobs WHERE hypertable_schema=$1', [schema]);
          if (Number(remaining.rows[0].count) !== 0) throw new Error();
        } catch {
          primaryFailure = new Error(`Timescale test cleanup failed; remove only temporary schema ${schema} and its jobs.`);
        }
      }
      await sql?.end().catch(() => {});
    }
    if (primaryFailure) throw primaryFailure;
  }, 120_000);
});
