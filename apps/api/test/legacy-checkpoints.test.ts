import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { Sql } from '../src/db';
import { base64url, type CryptoConfig } from '../src/crypto';
import { backfillLegacySamples, initializeLegacyCheckpointIds, inspectLegacyCoverage, type BackfillBucket } from '../src/legacy-backfill';

let db: PGlite;
let sql: Sql;
const config: CryptoConfig = { ENCRYPTION_ENVIRONMENT: 'test', HEALTH_KEK_ID: 'test', HEALTH_KEKS: JSON.stringify({ test: base64url(new Uint8Array(32).fill(42)) }) };
const bucket: BackfillBucket = { list: async () => ({ objects: [], truncated: false }), get: async () => null, put: async () => undefined };
beforeAll(async () => {
  db = new PGlite();
  const first = await readFile(new NodeURL('../timescale/001_init.sql', import.meta.url), 'utf8');
  const second = await readFile(new NodeURL('../timescale/002_encrypted.sql', import.meta.url), 'utf8');
  expect(second).not.toMatch(/ADD COLUMN[^;]*DEFAULT\s+gen_random_uuid/i);
  await db.exec(first.split('SELECT create_hypertable')[0]);
  await db.exec(second.replace(/SELECT create_hypertable[\s\S]*?;/g, '')
    .replace(/ALTER TABLE encrypted_health_samples SET \([\s\S]*?\);/g, '')
    .replace(/CALL add_columnstore_policy[\s\S]*?;/g, ''));
  sql = { query: async (text: string, values?: unknown[]) => db.query(text, values) } as unknown as Sql;
}, 30_000);
afterAll(async () => { await db?.close(); });

it('bounds and resumes checkpoint initialization without changing ownership, protected data, or lineage', async () => {
  for (const [index, owner] of ['default', 'legacy-owner', 'default'].entries()) {
    await db.query(`INSERT INTO health_samples (time,ended_at,user_id,metric,value,unit,source_name,dump_key,attrs)
      VALUES ($1,$1,$2,'heart_rate',$3,'bpm',$4,$5,$6)`,
    [new Date(Date.UTC(2026, 9, 1, 0, index)), owner, 70 + index, `Private source ${index}`, `hook/private-${index}`, { health: 'sensitive' }]);
  }
  const original = (await db.query('SELECT time,ended_at,user_id,metric,value,unit,source_name,dump_key,attrs FROM health_samples ORDER BY time')).rows;
  const info = (await db.query<{ column_default: string | null }>("SELECT column_default FROM information_schema.columns WHERE table_name='health_samples' AND column_name='legacy_migration_id'")).rows[0];
  expect(info.column_default).toBeNull();
  const uninitialized = await inspectLegacyCoverage(sql, config, bucket, { sampleOwners: {}, dumps: {} });
  expect(uninitialized.samples).toEqual({ total: 3, verified: 0, unowned: 3 });
  const owner = { ownerId: 'verified-account', verifiedBy: 'test-operator', verifiedAt: '2026-10-22T00:00:00Z', evidence: 'test-only-evidence' };
  expect((await inspectLegacyCoverage(sql, config, bucket, { sampleOwners: { default: owner, 'legacy-owner': owner }, dumps: {} })).samples)
    .toEqual({ total: 3, verified: 0, unowned: 0 });
  const log = vi.spyOn(console, 'log');
  const infoLog = vi.spyOn(console, 'info');
  const errorLog = vi.spyOn(console, 'error');
  try {
    expect(await initializeLegacyCheckpointIds(sql, 1)).toBe(1);
    const first = (await db.query<{ legacy_migration_id: string }>('SELECT legacy_migration_id FROM health_samples WHERE legacy_migration_id IS NOT NULL')).rows[0].legacy_migration_id;
    expect((await db.query('SELECT * FROM health_samples WHERE legacy_migration_id IS NULL')).rows).toHaveLength(2);
    // A later invocation automatically finishes initialization even if all
    // owners remain quarantined; it never creates an ownership assignment.
    expect(await backfillLegacySamples(sql, config, { sampleOwners: {}, dumps: {} }, 1)).toBe(0);
    expect(await initializeLegacyCheckpointIds(sql, 1)).toBe(0);
    const identifiers = (await db.query<{ legacy_migration_id: string }>('SELECT legacy_migration_id FROM health_samples')).rows.map(row => row.legacy_migration_id);
    expect(identifiers).toContain(first);
    expect(new Set(identifiers).size).toBe(3);
    expect((await db.query('SELECT time,ended_at,user_id,metric,value,unit,source_name,dump_key,attrs FROM health_samples ORDER BY time')).rows).toEqual(original);
    expect((await db.query('SELECT * FROM health_legacy_sample_migrations')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM encrypted_health_samples')).rows).toHaveLength(0);
    expect(log).not.toHaveBeenCalled();
    expect(infoLog).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
  } finally { log.mockRestore(); infoLog.mockRestore(); errorLog.mockRestore(); }
});
