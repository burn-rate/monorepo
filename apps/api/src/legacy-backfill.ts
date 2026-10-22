/** Operator tooling only: never mount these functions on a public HTTP route. */
import type { NormalizedSample } from '@burn-rate/api-schema';
import type { Sql } from './db';
import { base64url, createUserKeyring, CryptoFailure, decryptDump, encryptDump, type CryptoConfig, type Envelope } from './crypto';
import { sampleIdentity, storeEncryptedSamples } from './encrypted-store';
import { normalizeSourceName } from './ingest/shared';

export interface VerifiedOwner {
  ownerId: string;
  verifiedBy: string;
  verifiedAt: string;
  evidence: string;
}
export interface LegacyOwnerMappings {
  /** Explicit mappings, including 'default' only after out-of-band verification. */
  sampleOwners: Record<string, VerifiedOwner>;
  /** Every original object key is explicitly assigned; no first-user/prefix inference. */
  dumps: Record<string, VerifiedOwner>;
}
export interface BackfillBucket {
  list(options?: { cursor?: string }): Promise<{ objects: { key: string }[]; truncated: boolean; cursor?: string }>;
  get(key: string): Promise<{ text(): Promise<string>; size: number; customMetadata?: Record<string, string> } | null>;
  put(key: string, value: string, options?: { customMetadata?: Record<string, string>; httpMetadata?: { contentType: string } }): Promise<unknown>;
}
interface LegacyRow {
  legacy_migration_id: string; time: Date; ended_at: Date; user_id: string; metric: NormalizedSample['metric'];
  value: number; value_min: number | null; value_max: number | null; unit: string; source_name: string;
  device: string | null; ext_id: string | null; dump_key: string | null; attrs: unknown;
}
interface MigratedLegacyRow extends LegacyRow {
  owner_id: string; encrypted_sample_id: string; envelope: Envelope; source_digest: string;
}
export interface LegacyCoverage {
  samples: { total: number; verified: number; unowned: number };
  dumps: { total: number; verified: number; plaintext: number; unowned: number };
}

function mapping(value: VerifiedOwner | undefined): VerifiedOwner | null {
  if (!value || !value.ownerId || value.ownerId === 'default' || !value.verifiedBy || !value.evidence || !Number.isFinite(Date.parse(value.verifiedAt))) return null;
  return value;
}
async function objectFingerprint(key: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))));
}
function sample(row: LegacyRow, ownerId: string): NormalizedSample & { attrs: unknown } {
  return { userId: ownerId, metric: row.metric, time: new Date(row.time), endedAt: new Date(row.ended_at),
    value: row.value, valueMin: row.value_min, valueMax: row.value_max, unit: row.unit,
    sourceName: row.source_name, device: row.device, extId: row.ext_id, dumpKey: row.dump_key, attrs: row.attrs };
}
function matchesLegacy(value: Record<string, unknown>, row: LegacyRow): boolean {
  return value.value === row.value && value.valueMin === row.value_min && value.valueMax === row.value_max &&
    value.unit === row.unit && value.sourceName === normalizeSourceName(row.source_name) && value.device === row.device &&
    value.extId === row.ext_id && value.dumpKey === row.dump_key && JSON.stringify(value.attrs) === JSON.stringify(row.attrs);
}

/**
 * Assign at most one bounded batch of opaque checkpoint IDs. Call only with
 * legacy writers paused. This changes no owner or protected sample fields, and
 * uses the original unique key rather than physical tuple IDs (compressed
 * hypertables do not provide a stable row ctid). Safe to repeat after interruption.
 */
export async function initializeLegacyCheckpointIds(sql: Sql, batchSize = 100): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Invalid checkpoint batch size');
  const result = await sql.query<{ legacy_migration_id: string }>(`WITH pending AS (
      SELECT user_id, metric, time, ended_at, source_name FROM health_samples
      WHERE legacy_migration_id IS NULL
      ORDER BY time, user_id, metric, ended_at, source_name LIMIT $1
    )
    UPDATE health_samples s SET legacy_migration_id = gen_random_uuid()
    FROM pending p
    WHERE s.user_id = p.user_id AND s.metric = p.metric AND s.time = p.time
      AND s.ended_at = p.ended_at AND s.source_name = p.source_name
      AND s.legacy_migration_id IS NULL
    RETURNING s.legacy_migration_id`, [batchSize]);
  return result.rows.length;
}

/** Safe to interrupt between any two awaits: checkpoints follow authenticated verification. */
export async function backfillLegacySamples(sql: Sql, config: CryptoConfig, owners: LegacyOwnerMappings, batchSize = 100): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500) throw new Error('Invalid backfill batch size');
  while (await initializeLegacyCheckpointIds(sql, batchSize)) { /* Each update is independently bounded and resumable. */ }
  const assigned = Object.entries(owners.sampleOwners).filter(([, owner]) => mapping(owner));
  let migrated = 0;
  for (const [legacyOwner, owner] of assigned) {
    for (;;) {
      const { rows } = await sql.query<LegacyRow>(`SELECT s.* FROM health_samples s
        LEFT JOIN health_legacy_sample_migrations m ON m.legacy_id = s.legacy_migration_id
        WHERE s.user_id = $1 AND m.legacy_id IS NULL ORDER BY s.time, s.legacy_migration_id LIMIT $2`, [legacyOwner, batchSize]);
      if (!rows.length) break;
      for (const row of rows) {
        const observation = sample(row, owner.ownerId);
        await storeEncryptedSamples(sql, config, owner.ownerId, [observation]);
        const keys = await createUserKeyring(sql, config, owner.ownerId);
        const identity = await sampleIdentity(keys, observation);
        const { rows: encrypted } = await sql.query<{ envelope: Envelope; source_digest: string }>(
          'SELECT envelope, source_digest FROM encrypted_health_samples WHERE owner_id = $1 AND time = $2 AND id = $3', [owner.ownerId, observation.time, identity.id]);
        if (encrypted.length !== 1 || encrypted[0].source_digest !== identity.sourceDigest) throw new CryptoFailure();
        const decrypted = await keys.decrypt<Record<string, unknown>>({ ownerId: owner.ownerId, kind: 'sample', id: identity.id,
          metadata: [observation.metric, observation.time.toISOString(), observation.endedAt.toISOString(), identity.sourceDigest] }, encrypted[0].envelope);
        if (!matchesLegacy(decrypted, row)) throw new CryptoFailure();
        await sql.query(`INSERT INTO health_legacy_sample_migrations (legacy_id, owner_id, encrypted_sample_id, sample_time)
          VALUES ($1, $2, $3, $4) ON CONFLICT (legacy_id) DO NOTHING`, [row.legacy_migration_id, owner.ownerId, identity.id, observation.time]);
        migrated++;
      }
    }
  }
  return migrated;
}

/** Replaces each assigned legacy object atomically at the same opaque key. */
export async function backfillLegacyDumps(sql: Sql, config: CryptoConfig, bucket: BackfillBucket, owners: LegacyOwnerMappings): Promise<number> {
  let migrated = 0;
  for (const [key, suppliedOwner] of Object.entries(owners.dumps)) {
    const owner = mapping(suppliedOwner);
    if (!owner) continue;
    const object = await bucket.get(key);
    if (!object) throw new Error('Mapped legacy object is missing');
    // Bound memory and require an explicit separate plan for any unusually large legacy dump.
    if (object.size > 16 * 1024 * 1024) throw new Error('Legacy object exceeds backfill byte bound');
    const text = await object.text();
    if (object.customMetadata?.encrypted === '1') {
      if (object.customMetadata.ownerId !== owner.ownerId) throw new CryptoFailure();
      await decryptDump(sql, config, owner.ownerId, key, JSON.parse(text) as Envelope);
    } else {
      let original: unknown;
      try { original = JSON.parse(text); } catch { original = text; }
      // Older captures included Authorization/cookies/query credentials. Never
      // reproduce those fields even inside the new encrypted representation.
      if (original && typeof original === 'object' && !Array.isArray(original)) {
        const record = original as Record<string, unknown>;
        if ('headers' in record) record.headers = {};
        if ('query' in record) record.query = {};
      }
      const envelope = await encryptDump(sql, config, owner.ownerId, key, original);
      await bucket.put(key, JSON.stringify(envelope), { customMetadata: { encrypted: '1', ownerId: owner.ownerId }, httpMetadata: { contentType: 'application/json' } });
      const persisted = await bucket.get(key);
      if (!persisted || persisted.customMetadata?.encrypted !== '1') throw new CryptoFailure();
      const restored = await decryptDump(sql, config, owner.ownerId, key, JSON.parse(await persisted.text()) as Envelope);
      if (JSON.stringify(restored) !== JSON.stringify(original)) throw new CryptoFailure();
      migrated++;
    }
    await sql.query(`INSERT INTO health_legacy_dump_migrations (legacy_key_hash, owner_id) VALUES ($1, $2)
      ON CONFLICT (legacy_key_hash) DO UPDATE SET owner_id = EXCLUDED.owner_id, verified_at = now()`, [await objectFingerprint(key), owner.ownerId]);
  }
  return migrated;
}

/** Full inventory: a successful job is not evidence that unassigned objects disappeared. */
export async function inspectLegacyCoverage(sql: Sql, config: CryptoConfig, bucket: BackfillBucket, owners: LegacyOwnerMappings): Promise<LegacyCoverage> {
  const { rows } = await sql.query<{ total: string; verified: string; unowned: string }>(`SELECT count(*)::text AS total,
    count(m.legacy_id) FILTER (WHERE s.legacy_migration_id IS NOT NULL)::text AS verified,
    count(*) FILTER (WHERE NOT (s.user_id = ANY($1::text[])))::text AS unowned
    FROM health_samples s LEFT JOIN health_legacy_sample_migrations m ON m.legacy_id = s.legacy_migration_id`,
    [Object.entries(owners.sampleOwners).filter(([, owner]) => mapping(owner)).map(([id]) => id)]);
  const counts = rows[0];
  const report: LegacyCoverage = { samples: { total: Number(counts.total), verified: Number(counts.verified), unowned: Number(counts.unowned) },
    dumps: { total: 0, verified: 0, plaintext: 0, unowned: 0 } };
  // Re-verify every migrated sample, including rows checkpointed by previous runs.
  let previousId: string | null = null;
  for (;;) {
    const migrated: { rows: MigratedLegacyRow[] } = await sql.query<MigratedLegacyRow>(`
      SELECT s.*, m.owner_id, m.encrypted_sample_id, e.envelope, e.source_digest FROM health_samples s
      JOIN health_legacy_sample_migrations m ON m.legacy_id = s.legacy_migration_id
      LEFT JOIN encrypted_health_samples e ON e.owner_id = m.owner_id AND e.id = m.encrypted_sample_id AND e.time = m.sample_time
      WHERE ($1::uuid IS NULL OR s.legacy_migration_id > $1::uuid) ORDER BY s.legacy_migration_id LIMIT 100`, [previousId]);
    if (!migrated.rows.length) break;
    for (const row of migrated.rows) {
      if (!row.envelope || mapping(owners.sampleOwners[row.user_id])?.ownerId !== row.owner_id) throw new CryptoFailure();
      const observation = sample(row, row.owner_id);
      const keys = await createUserKeyring(sql, config, row.owner_id);
      const value = await keys.decrypt<Record<string, unknown>>({ ownerId: row.owner_id, kind: 'sample', id: row.encrypted_sample_id,
        metadata: [row.metric, observation.time.toISOString(), observation.endedAt.toISOString(), row.source_digest] }, row.envelope);
      if (!matchesLegacy(value, row)) throw new CryptoFailure();
    }
    previousId = migrated.rows[migrated.rows.length - 1].legacy_migration_id;
  }
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { cursor } : undefined);
    for (const { key } of page.objects) {
      const object = await bucket.get(key);
      if (!object) throw new Error('Object disappeared during inventory');
      report.dumps.total++;
      const owner = mapping(owners.dumps[key]);
      if (object.customMetadata?.encrypted !== '1') {
        report.dumps.plaintext++;
        if (!owner) report.dumps.unowned++;
      } else {
        // New runtime dumps carry this same safe metadata. Their authenticated
        // owner need not also be repeated in the legacy operator mapping.
        const ownerId = object.customMetadata.ownerId;
        if (!ownerId || ownerId === 'default' || (owner && owner.ownerId !== ownerId)) throw new CryptoFailure();
        await decryptDump(sql, config, ownerId, key, JSON.parse(await object.text()) as Envelope);
        report.dumps.verified++;
      }
    }
    if (page.truncated && !page.cursor) throw new Error('Missing R2 continuation cursor');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return report;
}

/** Live dump key references complement SQL sample counts; backups are tracked separately. */
export async function retainedDumpKeyInventory(sql: Sql, config: CryptoConfig, bucket: BackfillBucket) {
  const references = new Map<string, { ownerId: string; keyId: string; liveDumps: number }>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list(cursor ? { cursor } : undefined);
    for (const { key } of page.objects) {
      const object = await bucket.get(key);
      if (!object || object.customMetadata?.encrypted !== '1' || !object.customMetadata.ownerId) throw new Error('Plaintext or unowned objects remain');
      const ownerId = object.customMetadata.ownerId;
      const envelope = JSON.parse(await object.text()) as Envelope;
      await decryptDump(sql, config, ownerId, key, envelope);
      const identifier = JSON.stringify([ownerId, envelope.keyId]);
      const entry = references.get(identifier) ?? { ownerId, keyId: envelope.keyId, liveDumps: 0 };
      entry.liveDumps++;
      references.set(identifier, entry);
    }
    if (page.truncated && !page.cursor) throw new Error('Missing R2 continuation cursor');
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return [...references.values()];
}

/** Only call while writers are paused; the SQL cutover independently checks samples. */
export async function verifyLegacyCutover(sql: Sql, config: CryptoConfig, bucket: BackfillBucket, owners: LegacyOwnerMappings,
  approval: { verifiedBy: string; backupInventoryReference: string }): Promise<LegacyCoverage> {
  if (!approval.verifiedBy || !approval.backupInventoryReference) throw new Error('Operator and backup inventory reference required');
  const report = await inspectLegacyCoverage(sql, config, bucket, owners);
  if (report.samples.unowned || report.samples.verified !== report.samples.total || report.dumps.plaintext || report.dumps.unowned || report.dumps.verified !== report.dumps.total) throw new Error('Encrypted cutover coverage is incomplete');
  await sql.query(`UPDATE health_migration_state SET samples_verified_at = now(), dumps_verified_at = now(),
    backup_inventory_reference = $1, verified_by = $2, legacy_sample_count = $3, legacy_dump_count = $4 WHERE singleton`,
    [approval.backupInventoryReference, approval.verifiedBy, report.samples.total, report.dumps.total]);
  return report;
}
