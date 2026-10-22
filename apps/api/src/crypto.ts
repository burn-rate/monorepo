import type { Sql } from './db';

export interface CryptoConfig {
  ENCRYPTION_ENVIRONMENT: string;
  HEALTH_KEK_ID: string;
  /** Secret JSON object mapping retained KEK IDs to base64url 256-bit keys. */
  HEALTH_KEKS: string;
}

export interface Envelope {
  version: 1;
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface RecordContext {
  ownerId: string;
  kind: 'sample' | 'dump';
  id: string;
  /** Canonically ordered query metadata, authenticated but intentionally readable. */
  metadata?: readonly string[];
}

interface KeyRow {
  owner_id: string;
  key_id: string;
  purpose: 'data' | 'index';
  state: 'active' | 'retired';
  wrapped_key: Envelope;
}

export class CryptoFailure extends Error {
  readonly code = 'encryption-unavailable';
  constructor() { super('Encrypted health data is unavailable'); }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
function encoded(value: string): Uint8Array<ArrayBuffer> { return new Uint8Array(encoder.encode(value)); }

export function base64url(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function unbase64url(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new CryptoFailure();
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    if (base64url(bytes) !== value) throw new CryptoFailure();
    return bytes;
  } catch { throw new CryptoFailure(); }
}

function canonical(parts: readonly unknown[]): Uint8Array<ArrayBuffer> {
  return encoded(JSON.stringify(parts));
}

function recordAad(config: CryptoConfig, context: RecordContext, keyId: string): Uint8Array<ArrayBuffer> {
  return canonical(['burn-rate', config.ENCRYPTION_ENVIRONMENT, context.ownerId, context.kind,
    context.id, 1, keyId, ...(context.metadata ?? [])]);
}

function wrappingAad(config: CryptoConfig, ownerId: string, keyId: string, purpose: string, kekId: string) {
  return canonical(['burn-rate', config.ENCRYPTION_ENVIRONMENT, ownerId, 'wrapped-key', keyId, purpose, 1, kekId]);
}

async function aesKey(raw: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  if (raw.byteLength !== 32) throw new CryptoFailure();
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function kek(config: CryptoConfig, id: string): Promise<CryptoKey> {
  try {
    if (!config.ENCRYPTION_ENVIRONMENT || !config.HEALTH_KEK_ID) throw new CryptoFailure();
    const keys: unknown = JSON.parse(config.HEALTH_KEKS);
    if (typeof keys !== 'object' || keys === null || !Object.hasOwn(keys, id)) throw new CryptoFailure();
    const value = (keys as Record<string, unknown>)[id];
    if (typeof value !== 'string') throw new CryptoFailure();
    return await aesKey(unbase64url(value));
  } catch { throw new CryptoFailure(); }
}

function validEnvelope(value: Envelope): void {
  if (!value || value.version !== 1 || typeof value.keyId !== 'string' || !value.keyId ||
    typeof value.iv !== 'string' || typeof value.ciphertext !== 'string') throw new CryptoFailure();
}

async function seal(key: CryptoKey, keyId: string, plaintext: Uint8Array<ArrayBuffer>, aad: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, plaintext);
  return { version: 1, keyId, iv: base64url(iv), ciphertext: base64url(new Uint8Array(ciphertext)) };
}

async function open(key: CryptoKey, envelope: Envelope, aad: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  validEnvelope(envelope);
  const iv = unbase64url(envelope.iv);
  const ciphertext = unbase64url(envelope.ciphertext);
  if (iv.byteLength !== 12 || ciphertext.byteLength < 16) throw new CryptoFailure();
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aad, tagLength: 128 }, key, ciphertext));
}

async function wrap(config: CryptoConfig, ownerId: string, keyId: string, purpose: string, raw: Uint8Array<ArrayBuffer>): Promise<Envelope> {
  return seal(await kek(config, config.HEALTH_KEK_ID), config.HEALTH_KEK_ID, raw,
    wrappingAad(config, ownerId, keyId, purpose, config.HEALTH_KEK_ID));
}

async function unwrap(config: CryptoConfig, row: KeyRow): Promise<Uint8Array<ArrayBuffer>> {
  validEnvelope(row.wrapped_key);
  return open(await kek(config, row.wrapped_key.keyId), row.wrapped_key,
    wrappingAad(config, row.owner_id, row.key_id, row.purpose, row.wrapped_key.keyId));
}

/** Request-scoped, nonextractable keys. Never cache across accounts or requests. */
export class UserKeyring {
  private constructor(
    readonly ownerId: string,
    readonly activeKeyId: string,
    private readonly config: CryptoConfig,
    private readonly dataKeys: Map<string, CryptoKey>,
    private readonly indexKey: CryptoKey
  ) {}

  static async fromRows(config: CryptoConfig, ownerId: string, rows: KeyRow[]): Promise<UserKeyring> {
    try {
      const dataKeys = new Map<string, CryptoKey>();
      const active = rows.filter(row => row.purpose === 'data' && row.state === 'active');
      const indexes = rows.filter(row => row.purpose === 'index');
      if (active.length !== 1 || indexes.length !== 1 || indexes[0].state !== 'active') throw new CryptoFailure();
      let indexKey: CryptoKey | undefined;
      for (const row of rows) {
        if (row.owner_id !== ownerId) throw new CryptoFailure();
        const raw = await unwrap(config, row);
        try {
          if (raw.byteLength !== 32) throw new CryptoFailure();
          if (row.purpose === 'data') dataKeys.set(row.key_id, await aesKey(raw));
          else indexKey = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
        } finally { raw.fill(0); }
      }
      if (!indexKey) throw new CryptoFailure();
      return new UserKeyring(ownerId, active[0].key_id, config, dataKeys, indexKey);
    } catch { throw new CryptoFailure(); }
  }

  async encrypt(context: RecordContext, value: unknown): Promise<Envelope> {
    try {
      if (context.ownerId !== this.ownerId) throw new CryptoFailure();
      const key = this.dataKeys.get(this.activeKeyId);
      if (!key) throw new CryptoFailure();
      return await seal(key, this.activeKeyId, encoded(JSON.stringify(value)), recordAad(this.config, context, this.activeKeyId));
    } catch { throw new CryptoFailure(); }
  }

  async decrypt<T>(context: RecordContext, envelope: Envelope): Promise<T> {
    try {
      if (context.ownerId !== this.ownerId) throw new CryptoFailure();
      validEnvelope(envelope);
      const key = this.dataKeys.get(envelope.keyId);
      if (!key) throw new CryptoFailure();
      return JSON.parse(decoder.decode(await open(key, envelope, recordAad(this.config, context, envelope.keyId)))) as T;
    } catch { throw new CryptoFailure(); }
  }

  async digest(domain: 'source' | 'sample' | 'cursor', values: readonly string[]): Promise<string> {
    return base64url(new Uint8Array(await crypto.subtle.sign('HMAC', this.indexKey,
      canonical(['burn-rate', this.config.ENCRYPTION_ENVIRONMENT, this.ownerId, domain, ...values]))));
  }

  async verifyDigest(domain: 'cursor', values: readonly string[], signature: string): Promise<boolean> {
    try {
      return await crypto.subtle.verify('HMAC', this.indexKey, unbase64url(signature),
        canonical(['burn-rate', this.config.ENCRYPTION_ENVIRONMENT, this.ownerId, domain, ...values]));
    } catch { return false; }
  }
}

/** Provisioning is serialized per owner, with one stable, independent index key. */
export async function createUserKeyring(sql: Sql, config: CryptoConfig, ownerId: string): Promise<UserKeyring> {
  if (!ownerId || ownerId === 'default') throw new CryptoFailure();
  let rows = (await sql.query<KeyRow>('SELECT * FROM health_user_keys WHERE owner_id = $1', [ownerId])).rows;
  if (rows.length === 0) {
    // Validate the KEK before entering a transaction or attempting any writes.
    await kek(config, config.HEALTH_KEK_ID);
    await sql.query('BEGIN');
    try {
      await sql.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`health-keys:${ownerId}`]);
      rows = (await sql.query<KeyRow>('SELECT * FROM health_user_keys WHERE owner_id = $1', [ownerId])).rows;
      if (rows.length === 0) {
        for (const purpose of ['data', 'index'] as const) {
          const id = crypto.randomUUID();
          const raw = crypto.getRandomValues(new Uint8Array(32));
          try {
            const wrapped = await wrap(config, ownerId, id, purpose, raw);
            await sql.query('INSERT INTO health_user_keys (owner_id, key_id, purpose, state, wrapped_key) VALUES ($1, $2, $3, $4, $5::jsonb)',
              [ownerId, id, purpose, 'active', JSON.stringify(wrapped)]);
          } finally { raw.fill(0); }
        }
        rows = (await sql.query<KeyRow>('SELECT * FROM health_user_keys WHERE owner_id = $1', [ownerId])).rows;
      }
      await sql.query('COMMIT');
    } catch (error) { await sql.query('ROLLBACK').catch(() => {}); throw error; }
  }
  return UserKeyring.fromRows(config, ownerId, rows);
}

/** Retire, never delete, the previous DEK. The stable index key is untouched. */
export async function rotateDataKey(sql: Sql, config: CryptoConfig, ownerId: string): Promise<string> {
  await createUserKeyring(sql, config, ownerId);
  const id = crypto.randomUUID();
  const raw = crypto.getRandomValues(new Uint8Array(32));
  try {
    const wrapped = await wrap(config, ownerId, id, 'data', raw);
    await sql.query('BEGIN');
    try {
      await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`health-keys:${ownerId}`]);
      await sql.query("UPDATE health_user_keys SET state = 'retired', retired_at = now() WHERE owner_id = $1 AND purpose = 'data' AND state = 'active'", [ownerId]);
      await sql.query("INSERT INTO health_user_keys (owner_id, key_id, purpose, state, wrapped_key) VALUES ($1, $2, 'data', 'active', $3::jsonb)", [ownerId, id, JSON.stringify(wrapped)]);
      await sql.query('COMMIT');
      return id;
    } catch (error) { await sql.query('ROLLBACK').catch(() => {}); throw error; }
  } finally { raw.fill(0); }
}

/** Rewraps both active/retired DEKs and the stable index key, without payload writes. */
export async function rewrapUserKeys(sql: Sql, config: CryptoConfig, ownerId: string): Promise<number> {
  await kek(config, config.HEALTH_KEK_ID);
  await sql.query('BEGIN');
  try {
    await sql.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`health-keys:${ownerId}`]);
    const { rows } = await sql.query<KeyRow>('SELECT * FROM health_user_keys WHERE owner_id = $1 FOR UPDATE', [ownerId]);
    for (const row of rows) {
      const raw = await unwrap(config, row);
      try {
        const wrapped = await wrap(config, ownerId, row.key_id, row.purpose, raw);
        await sql.query('UPDATE health_user_keys SET wrapped_key = $1::jsonb WHERE owner_id = $2 AND key_id = $3', [JSON.stringify(wrapped), ownerId, row.key_id]);
      } finally { raw.fill(0); }
    }
    await sql.query('COMMIT');
    return rows.length;
  } catch { await sql.query('ROLLBACK').catch(() => {}); throw new CryptoFailure(); }
}

export async function retainedKeyInventory(sql: Sql) {
  return (await sql.query<{ owner_id: string; key_id: string; purpose: string; state: string; kek_id: string; live_samples: string }>(`
    SELECT k.owner_id, k.key_id, k.purpose, k.state, k.wrapped_key->>'keyId' AS kek_id,
      (SELECT count(*) FROM encrypted_health_samples s WHERE s.owner_id = k.owner_id AND s.envelope->>'keyId' = k.key_id)::text AS live_samples
    FROM health_user_keys k ORDER BY k.owner_id, k.purpose, k.created_at`)).rows;
}

export async function encryptDump(sql: Sql, config: CryptoConfig, ownerId: string, dumpId: string, dump: unknown): Promise<Envelope> {
  return (await createUserKeyring(sql, config, ownerId)).encrypt({ ownerId, kind: 'dump', id: dumpId }, dump);
}

export async function decryptDump(sql: Sql, config: CryptoConfig, ownerId: string, dumpId: string, envelope: Envelope): Promise<unknown> {
  return (await createUserKeyring(sql, config, ownerId)).decrypt({ ownerId, kind: 'dump', id: dumpId }, envelope);
}
