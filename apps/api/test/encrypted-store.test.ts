import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { NormalizedSample } from '@burn-rate/api-schema';
import type { Sql } from '../src/db';
import { base64url, createUserKeyring, CryptoFailure, decryptDump, encryptDump, retainedKeyInventory, rewrapUserKeys, rotateDataKey, type CryptoConfig } from '../src/crypto';
import { InvalidSampleQuery, listEncryptedSamples, storeEncryptedSamples, validateSampleQuery } from '../src/encrypted-store';
import { backfillLegacyDumps, backfillLegacySamples, inspectLegacyCoverage, verifyLegacyCutover, type BackfillBucket, type LegacyOwnerMappings } from '../src/legacy-backfill';

const config: CryptoConfig = { ENCRYPTION_ENVIRONMENT: 'test', HEALTH_KEK_ID: 'kek-1', HEALTH_KEKS: JSON.stringify({ 'kek-1': base64url(new Uint8Array(32).fill(17)) }) };
const query = { metric: 'heart_rate', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z' };
function observation(minute = 0, value = 72): NormalizedSample & { attrs: unknown } {
  return { userId: 'untrusted-payload-owner', metric: 'heart_rate', time: new Date(`2026-10-01T00:${String(minute).padStart(2, '0')}:00Z`),
    endedAt: new Date(`2026-10-01T00:${String(minute).padStart(2, '0')}:00Z`), value, valueMin: 60, valueMax: 90,
    unit: 'bpm', sourceName: "Private person's Watch", device: 'Private device', extId: 'private-native-id',
    dumpKey: 'hook/private-dump.json', attrs: { sensitive: 'private attributes' } };
}

describe('encrypted persistence on PostgreSQL (PGlite)', () => {
  let database: PGlite;
  let sql: Sql;
  beforeAll(async () => {
    database = new PGlite();
    const first = await readFile(new NodeURL('../timescale/001_init.sql', import.meta.url), 'utf8');
    const second = await readFile(new NodeURL('../timescale/002_encrypted.sql', import.meta.url), 'utf8');
    // PGlite runs PostgreSQL DDL/constraints/transactions. Timescale extension
    // installation, compression, and real multi-client advisory locks require
    // the separately documented staging Timescale rehearsal.
    await database.exec(first.split("SELECT create_hypertable")[0]);
    await database.exec(second
      .replace(/SELECT create_hypertable[\s\S]*?;/g, '')
      .replace(/ALTER TABLE encrypted_health_samples SET \([\s\S]*?\);/g, '')
      .replace(/CALL add_columnstore_policy[\s\S]*?;/g, ''));
    for (const name of ['004_auth.sql', '006_activity_credit.sql']) {
      await database.exec(await readFile(new NodeURL(`../timescale/${name}`, import.meta.url), 'utf8'));
    }
    sql = { query: async (text: string, values?: unknown[]) => {
      if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      return database.query(text, values);
    } } as unknown as Sql;
  }, 30_000);
  beforeEach(async () => {
    await database.exec('TRUNCATE health_user_keys, encrypted_health_samples, health_samples, health_legacy_sample_migrations, health_legacy_dump_migrations');
    await database.exec('UPDATE health_migration_state SET samples_verified_at=NULL, dumps_verified_at=NULL, backup_inventory_reference=NULL');
  });
  afterAll(async () => { await database?.close(); });

  it('encrypts every sensitive field, uses fresh nonces, and binds owner/environment/kind/metadata', async () => {
    const keys = await createUserKeyring(sql, config, 'alice');
    const context = { ownerId: 'alice', kind: 'sample' as const, id: 'opaque-id', metadata: ['heart_rate', 'time'] };
    const first = await keys.encrypt(context, observation());
    const second = await keys.encrypt(context, observation());
    expect(first.iv).not.toBe(second.iv);
    expect(JSON.stringify(first)).not.toContain(JSON.stringify(observation().sourceName));
    expect(await keys.decrypt(context, first)).toMatchObject({ value: 72 });
    for (const changed of [{ ...context, ownerId: 'bob' }, { ...context, id: 'other' }, { ...context, kind: 'dump' as const }, { ...context, metadata: ['heart_rate', 'changed'] }]) {
      await expect(keys.decrypt(changed, first)).rejects.toBeInstanceOf(CryptoFailure);
    }
    await expect(keys.decrypt(context, { ...first, ciphertext: `${first.ciphertext.slice(0, -2)}AA` })).rejects.toBeInstanceOf(CryptoFailure);
    await expect(createUserKeyring(sql, { ...config, ENCRYPTION_ENVIRONMENT: 'other' }, 'alice')).rejects.toBeInstanceOf(CryptoFailure);
    await expect(createUserKeyring(sql, { ...config, HEALTH_KEKS: '{}' }, 'alice')).rejects.toBeInstanceOf(CryptoFailure);
    await expect(createUserKeyring(sql, config, 'default')).rejects.toBeInstanceOf(CryptoFailure);
    expect((await sql.query('SELECT wrapped_key FROM health_user_keys')).rows.every(row => !JSON.stringify(row).includes('Private'))).toBe(true);
  });

  it('replays/corrects one stable observation across DEK and KEK rotation and retained-key restore', async () => {
    await storeEncryptedSamples(sql, config, 'alice', [observation(), observation()]);
    const before = (await sql.query('SELECT id, envelope, source_digest FROM encrypted_health_samples')).rows[0];
    await rotateDataKey(sql, config, 'alice');
    expect((await listEncryptedSamples(sql, config, 'alice', query)).items[0].value).toBe(72);
    await storeEncryptedSamples(sql, config, 'alice', [observation(0, 81)]);
    const after = (await sql.query('SELECT id, envelope, source_digest FROM encrypted_health_samples')).rows;
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(before.id);
    expect(after[0].source_digest).toBe(before.source_digest);
    expect(after[0].envelope.keyId).not.toBe(before.envelope.keyId);
    expect(after[0].envelope.iv).not.toBe(before.envelope.iv);
    const dump = await encryptDump(sql, config, 'alice', 'opaque-dump', { body: 'private body' });
    const rotated: CryptoConfig = { ...config, HEALTH_KEK_ID: 'kek-2', HEALTH_KEKS: JSON.stringify({ ...JSON.parse(config.HEALTH_KEKS), 'kek-2': base64url(new Uint8Array(32).fill(29)) }) };
    expect(await rewrapUserKeys(sql, rotated, 'alice')).toBe(3);
    const restoredConfig = { ...rotated, HEALTH_KEKS: JSON.stringify({ 'kek-2': JSON.parse(rotated.HEALTH_KEKS)['kek-2'] }) };
    expect((await listEncryptedSamples(sql, restoredConfig, 'alice', query)).items[0].value).toBe(81);
    const restoredKeys = await createUserKeyring(sql, restoredConfig, 'alice');
    expect(await restoredKeys.decrypt({ ownerId: 'alice', kind: 'sample', id: before.id,
      metadata: ['heart_rate', observation().time.toISOString(), observation().endedAt.toISOString(), before.source_digest] }, before.envelope)).toMatchObject({ value: 72 });
    expect(await decryptDump(sql, restoredConfig, 'alice', 'opaque-dump', dump)).toEqual({ body: 'private body' });
    const retained = await retainedKeyInventory(sql);
    expect(retained.filter(key => key.state === 'retired')).toHaveLength(1);
    expect(retained.every(key => key.kek_id === 'kek-2')).toBe(true);
    await storeEncryptedSamples(sql, restoredConfig, 'alice', [{ ...observation(0, 82), sourceName: observation().sourceName.replace(' ', '\u00a0') }]);
    expect(Number((await sql.query('SELECT count(*) FROM encrypted_health_samples')).rows[0].count)).toBe(1);
  });

  it('authenticates each credit record family and retains old keys across rotation', async () => {
    const keys = await createUserKeyring(sql, config, 'alice');
    const kinds = ['ring-summary', 'loan', 'loan-decision'] as const;
    const records = await Promise.all(kinds.map(async kind => {
      const context = { ownerId: 'alice', kind, id: `opaque-${kind}`, metadata: ['bound-index'] };
      const envelope = await keys.encrypt(context, { sensitive: 'private credit terms', principal: '0.1' });
      expect(JSON.stringify(envelope)).not.toContain('private credit terms');
      for (const changed of [
        { ...context, ownerId: 'bob' }, { ...context, id: 'different' },
        { ...context, kind: 'sample' as const }, { ...context, metadata: ['changed-index'] }
      ]) await expect(keys.decrypt(changed, envelope)).rejects.toBeInstanceOf(CryptoFailure);
      return { context, envelope };
    }));
    const domains = ['ring-summary-identity', 'ring-summary-day', 'ring-summary-content', 'loan-idempotency', 'loan-request'] as const;
    const digests = await Promise.all(domains.map(domain => keys.digest(domain, ['same-input'])));
    expect(new Set(digests).size).toBe(domains.length);
    const bob = await createUserKeyring(sql, config, 'bob');
    expect(await bob.digest('loan-idempotency', ['same-input'])).not.toBe(digests[3]);
    await rotateDataKey(sql, config, 'alice');
    const restored = await createUserKeyring(sql, config, 'alice');
    for (const { context, envelope } of records) {
      expect(await restored.decrypt(context, envelope)).toEqual({ sensitive: 'private credit terms', principal: '0.1' });
      expect((await restored.encrypt(context, { principal: '0.1' })).keyId).not.toBe(envelope.keyId);
    }
    expect(await restored.digest('loan-idempotency', ['same-input'])).toBe(digests[3]);
  });

  it('converges after a failed later batch and isolates two owners', async () => {
    const samples = Array.from({ length: 150 }, (_, index) => ({ ...observation(index % 60), time: new Date(Date.UTC(2026, 9, 1, 0, index)), endedAt: new Date(Date.UTC(2026, 9, 1, 0, index)) }));
    let inserts = 0;
    const interrupted = { query: async (text: string, values?: unknown[]) => {
      if (text.startsWith('INSERT INTO encrypted_health_samples') && ++inserts === 2) throw new Error('injected safe storage failure');
      return sql.query(text, values);
    } } as unknown as Sql;
    await expect(storeEncryptedSamples(interrupted, config, 'alice', samples)).rejects.toThrow('injected');
    expect(Number((await sql.query('SELECT count(*) FROM encrypted_health_samples')).rows[0].count)).toBe(100);
    await storeEncryptedSamples(sql, config, 'alice', samples);
    await storeEncryptedSamples(sql, config, 'bob', [observation()]);
    expect(Number((await sql.query("SELECT count(*) FROM encrypted_health_samples WHERE owner_id='alice'")).rows[0].count)).toBe(150);
    const bob = await listEncryptedSamples(sql, config, 'bob', query);
    expect(bob.items).toHaveLength(1);
    expect(bob.items[0]).not.toHaveProperty('dumpKey');
    expect(bob.items[0]).not.toHaveProperty('envelope');
    expect(bob.items[0].id).not.toBe((await listEncryptedSamples(sql, config, 'alice', query)).items[0].id);
    const exported = JSON.stringify((await sql.query('SELECT * FROM encrypted_health_samples')).rows);
    for (const secret of [observation().sourceName, observation().unit, 'private attributes', observation().extId, observation().dumpKey]) {
      expect(exported).not.toContain(JSON.stringify(secret));
    }
  });

  it('paginates stably in [from,to), rejects rebound cursors, and fails closed on corrupt rows', async () => {
    await storeEncryptedSamples(sql, config, 'alice', [observation(0), observation(1), observation(2), { ...observation(), time: new Date(query.to), endedAt: new Date(query.to) }]);
    const first = await listEncryptedSamples(sql, config, 'alice', { ...query, limit: 2 });
    expect(first.items.map(item => item.time)).toEqual(['2026-10-01T00:00:00.000Z', '2026-10-01T00:01:00.000Z']);
    const last = await listEncryptedSamples(sql, config, 'alice', { ...query, limit: 2, cursor: first.nextCursor! });
    expect(last.items).toHaveLength(1);
    expect(last.nextCursor).toBeNull();
    await expect(listEncryptedSamples(sql, config, 'bob', { ...query, cursor: first.nextCursor! })).rejects.toBeInstanceOf(InvalidSampleQuery);
    await expect(listEncryptedSamples(sql, config, 'alice', { ...query, to: '2026-10-03T00:00:00Z', cursor: first.nextCursor! })).rejects.toBeInstanceOf(InvalidSampleQuery);
    await expect(listEncryptedSamples(sql, config, 'alice', { ...query, cursor: 'bad' })).rejects.toBeInstanceOf(InvalidSampleQuery);
    expect(() => validateSampleQuery({ ...query, limit: 501 })).toThrow(InvalidSampleQuery);
    expect(() => validateSampleQuery({ ...query, to: '2026-11-02T00:00:00Z' })).toThrow(InvalidSampleQuery);
    expect(() => validateSampleQuery({ ...query, from: '2026-10-01' })).toThrow(InvalidSampleQuery);
    expect(() => validateSampleQuery({ ...query, from: '2026-02-30T00:00:00Z' })).toThrow(InvalidSampleQuery);
    expect(validateSampleQuery({ ...query, from: '2026-10-01T00:00:00.000001Z' }).from).toBe('2026-10-01T00:00:00.000001Z');
    expect((await listEncryptedSamples(sql, config, 'new-user', query)).items).toEqual([]);
    await sql.query("UPDATE encrypted_health_samples SET envelope = jsonb_set(envelope, '{ciphertext}', '\"AAAA\"') WHERE time = $1", [observation(1).time]);
    await expect(listEncryptedSamples(sql, config, 'alice', query)).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('preserves exact sub-ms bounds, range limits, and cursor binding', async () => {
    await storeEncryptedSamples(sql, config, 'alice', [0, 1, 2].map(milliseconds => ({ ...observation(),
      time: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, milliseconds)), endedAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, milliseconds)) })));
    const from = '2026-10-01T00:00:00.000001Z';
    const after = await listEncryptedSamples(sql, config, 'alice', { ...query, from, to: '2026-10-01T00:00:00.002Z' });
    expect(after.items.map(item => item.time)).toEqual(['2026-10-01T00:00:00.001Z']);
    const before = await listEncryptedSamples(sql, config, 'alice', { ...query, to: from });
    expect(before.items.map(item => item.time)).toEqual(['2026-10-01T00:00:00.000Z']);
    const within = await listEncryptedSamples(sql, config, 'alice', { ...query, from, to: '2026-10-01T00:00:00.000002Z' });
    expect(within.items).toEqual([]);
    expect(() => validateSampleQuery({ ...query, from, to: '2026-11-01T00:00:00.000002Z' })).toThrow(InvalidSampleQuery);
    expect(validateSampleQuery({ ...query, from, to: '2026-11-01T00:00:00.000001Z' }).from).toBe(from);
    expect(() => validateSampleQuery({ ...query, from, to: '2026-10-01T00:00:00.000000999999999Z' })).toThrow(InvalidSampleQuery);
    const first = await listEncryptedSamples(sql, config, 'alice', { ...query, from, limit: 1 });
    expect(first.items[0].time).toBe('2026-10-01T00:00:00.001Z');
    const next = await listEncryptedSamples(sql, config, 'alice', { ...query, from: '2026-10-01T01:00:00.000001+01:00', limit: 1, cursor: first.nextCursor! });
    expect(next.items[0].time).toBe('2026-10-01T00:00:00.002Z');
    await expect(listEncryptedSamples(sql, config, 'alice', { ...query, from: '2026-10-01T00:00:00.000002Z', limit: 1, cursor: first.nextCursor! })).rejects.toBeInstanceOf(InvalidSampleQuery);
    await expect(sql.query("UPDATE encrypted_health_samples SET time = time + interval '1 microsecond'")).rejects.toThrow('check constraint');
    await sql.query('ALTER TABLE encrypted_health_samples DROP CONSTRAINT encrypted_samples_time_precision');
    try {
      await sql.query("UPDATE encrypted_health_samples SET time = time + interval '1 microsecond' WHERE time = $1", [observation().time]);
      await expect(listEncryptedSamples(sql, config, 'alice', query)).rejects.toBeInstanceOf(CryptoFailure);
    } finally {
      await sql.query("UPDATE encrypted_health_samples SET time = date_trunc('milliseconds', time)");
      await sql.query("ALTER TABLE encrypted_health_samples ADD CONSTRAINT encrypted_samples_time_precision CHECK (time = date_trunc('milliseconds', time))");
    }
  });

  it('resumes verified owner-mapped sample/R2 backfill and blocks incomplete cutover', async () => {
    const value = observation();
    await sql.query(`INSERT INTO health_samples (user_id, metric, time, ended_at, value, value_min, value_max, unit, source_name, device, ext_id, dump_key, attrs)
      VALUES ('default', $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [value.metric, value.time, value.endedAt, value.value, value.valueMin, value.valueMax, value.unit, value.sourceName, value.device, value.extId, value.dumpKey, value.attrs]);
    const objects = new Map<string, { text: string; metadata?: Record<string, string> }>([['hook/legacy.json', { text: JSON.stringify({ headers: { authorization: 'secret' }, query: { token: 'secret' }, body: { private: 72 } }) }]]);
    const bucket: BackfillBucket = {
      list: async () => ({ objects: [...objects.keys()].map(key => ({ key })), truncated: false }),
      get: async key => { const object = objects.get(key); return object ? { text: async () => object.text, size: object.text.length, customMetadata: object.metadata } : null; },
      put: async (key, text, options) => { objects.set(key, { text, metadata: options?.customMetadata }); }
    };
    const mappings: LegacyOwnerMappings = { sampleOwners: {}, dumps: {} };
    expect(await backfillLegacySamples(sql, config, mappings)).toBe(0);
    expect((await inspectLegacyCoverage(sql, config, bucket, mappings)).samples.unowned).toBe(1);
    const cutover = await readFile(new NodeURL('../timescale/003_cutover.sql', import.meta.url), 'utf8');
    await expect(database.exec(cutover)).rejects.toThrow('requires verified');
    await expect(verifyLegacyCutover(sql, config, bucket, mappings, { verifiedBy: 'operator', backupInventoryReference: 'backup-tracker-42' })).rejects.toThrow('incomplete');
    const verified = { ownerId: 'alice', verifiedBy: 'operator', verifiedAt: '2026-10-22T00:00:00Z', evidence: 'verified-exporter-inventory-42' };
    mappings.sampleOwners.default = verified;
    mappings.dumps['hook/legacy.json'] = verified;
    expect(await backfillLegacySamples(sql, config, mappings)).toBe(1);
    expect(await backfillLegacySamples(sql, config, mappings)).toBe(0);
    expect(await backfillLegacyDumps(sql, config, bucket, mappings)).toBe(1);
    expect(await backfillLegacyDumps(sql, config, bucket, mappings)).toBe(0);
    const report = await verifyLegacyCutover(sql, config, bucket, mappings, { verifiedBy: 'operator', backupInventoryReference: 'backup-tracker-42' });
    expect(report).toEqual({ samples: { total: 1, verified: 1, unowned: 0 }, dumps: { total: 1, verified: 1, plaintext: 0, unowned: 0 } });
    expect(JSON.stringify(objects.get('hook/legacy.json'))).not.toContain('"secret"');
    expect(await decryptDump(sql, config, 'alice', 'hook/legacy.json', JSON.parse(objects.get('hook/legacy.json')!.text))).toEqual({ headers: {}, query: {}, body: { private: 72 } });
    await database.exec('CREATE MATERIALIZED VIEW health_daily AS SELECT value FROM health_samples');
    await database.exec(cutover);
    expect((await sql.query("SELECT to_regclass('health_samples') AS samples, to_regclass('health_daily') AS daily")).rows[0]).toEqual({ samples: null, daily: null });
    expect((await listEncryptedSamples(sql, config, 'alice', query)).items[0].value).toBe(72);
  });
});
