import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createAuth, getAuthSession, handleAuthRequest, removePasskey, type AuthEnvironment, type AuthSession } from '../src/auth';
import { readAuthConfig, assertTrustedMutation } from '../src/auth-config';
import { authenticateIngestionToken, createIngestionToken, listIngestionTokens, requireFreshPasskey, revokeIngestionToken } from '../src/tokens';
import type { Sql } from '../src/db';

const env = {
  BETTER_AUTH_SECRET: 'test-only-secret-with-over-thirty-two-characters',
  BETTER_AUTH_URL: 'https://api.example.com',
  DASHBOARD_URL: 'https://app.example.com',
  PASSKEY_RP_ID: 'example.com', PASSKEY_RP_NAME: 'Burn Rate tests'
} satisfies AuthEnvironment;
const origin = 'https://app.example.com';
const encoder = new TextEncoder();
const bytes = (...arrays: Uint8Array[]) => new Uint8Array(arrays.reduce((result, array) => [...result, ...array], [] as number[]));
const b64 = (input: Uint8Array) => Buffer.from(input).toString('base64url');
const digest = async (input: Uint8Array) => new Uint8Array(await crypto.subtle.digest('SHA-256', input));

// Only the small deterministic subset needed for a WebAuthn 'none' attestation.
function cbor(value: unknown): Uint8Array {
  const head = (major: number, n: number) => n < 24 ? new Uint8Array([major * 32 + n]) : new Uint8Array([major * 32 + 24, n]);
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string') { const data = encoder.encode(value); return bytes(head(3, data.length), data); }
  if (value instanceof Uint8Array) return bytes(head(2, value.length), value);
  if (value instanceof Map) return bytes(head(5, value.size), ...[...value].flatMap(([key, entry]) => [cbor(key), cbor(entry)]));
  throw new Error('Unsupported test CBOR value');
}

async function credential() {
  const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', keys.publicKey) as JsonWebKey;
  const id = crypto.getRandomValues(new Uint8Array(32));
  const cose = cbor(new Map<unknown, unknown>([[1, 2], [3, -7], [-1, 1], [-2, new Uint8Array(Buffer.from(jwk.x!, 'base64url'))], [-3, new Uint8Array(Buffer.from(jwk.y!, 'base64url'))]]));
  return {
    id: b64(id),
    async registration(challenge: string, expectedOrigin = origin, verified = true, relyingParty = 'example.com') {
      const clientDataJSON = b64(encoder.encode(JSON.stringify({ type: 'webauthn.create', challenge, origin: expectedOrigin, crossOrigin: false })));
      const authData = bytes(await digest(encoder.encode(relyingParty)), new Uint8Array([verified ? 69 : 65, 0, 0, 0, 0]), new Uint8Array(16), new Uint8Array([0, id.length]), id, cose);
      return { id: b64(id), rawId: b64(id), type: 'public-key', response: { clientDataJSON, attestationObject: b64(cbor(new Map<unknown, unknown>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))), transports: ['internal'] }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    },
    async authentication(challenge: string, expectedOrigin = origin, verified = true) {
      const clientData = encoder.encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: expectedOrigin, crossOrigin: false }));
      const authData = bytes(await digest(encoder.encode('example.com')), new Uint8Array([verified ? 5 : 1, 0, 0, 0, 1]));
      const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, keys.privateKey, bytes(authData, await digest(clientData))));
      const integer = (value: Uint8Array) => {
        let start = 0;
        while (start < value.length - 1 && value[start] === 0) start++;
        const content = value.slice(start);
        const positive = content[0] & 128 ? bytes(new Uint8Array([0]), content) : content;
        return bytes(new Uint8Array([2, positive.length]), positive);
      };
      const encoded = bytes(integer(signature.slice(0, 32)), integer(signature.slice(32)));
      return { id: b64(id), rawId: b64(id), type: 'public-key', response: { clientDataJSON: b64(clientData), authenticatorData: b64(authData), signature: b64(bytes(new Uint8Array([48, encoded.length]), encoded)) }, clientExtensionResults: {}, authenticatorAttachment: 'platform' };
    }
  };
}

describe('passkey-only Better Auth on the shared PostgreSQL client', () => {
  let db: PGlite;
  let sql: Sql;
  let cookies: Map<string, string>;
  beforeAll(async () => {
    db = new PGlite();
    await db.exec(await readFile(new NodeURL('../timescale/004_auth.sql', import.meta.url), 'utf8'));
    sql = { query: async (query: string, params?: unknown[]) => {
      // PGlite has one backend; independent-client advisory locking is checked
      // by the optional real PostgreSQL suite. All other SQL executes normally.
      if (query.startsWith('SELECT pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
      const result = await db.query(query, params);
      return { rows: result.rows, rowCount: result.affectedRows ?? result.rows.length, command: query.trim().split(/\s/)[0].toUpperCase() };
    } } as unknown as Sql;
  }, 30_000);
  beforeEach(async () => {
    await db.exec('TRUNCATE "user", session, account, passkey, verification, auth_onboarding, ingestion_tokens CASCADE');
    cookies = new Map();
  });
  afterAll(async () => { await db?.close(); });

  const cookieHeader = () => [...cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  async function request(path: string, body?: unknown, requestOrigin = origin) {
    const response = await handleAuthRequest(new Request(`${env.BETTER_AUTH_URL}/api/auth${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { Origin: requestOrigin, Cookie: cookieHeader(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body)
    }), sql, env);
    for (const set of response.headers.getSetCookie()) {
      const pair = set.split(';')[0];
      const split = pair.indexOf('=');
      cookies.set(pair.slice(0, split), pair.slice(split + 1));
    }
    return response;
  }
  async function begin(input: { name?: string; email?: string } = { name: 'Test user' }) {
    const context = await (await request('/onboarding/context', input)).json() as { context: string };
    const options = await (await request(`/passkey/generate-register-options?context=${context.context}`)).json() as { challenge: string; authenticatorSelection: { userVerification: string } };
    return { ...context, ...options };
  }
  async function register() {
    const start = await begin();
    const key = await credential();
    const response = await request('/passkey/verify-registration', { response: await key.registration(start.challenge), createSession: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const sessionCookie = response.headers.getSetCookie().find((cookie) => cookie.includes('session_token='));
    expect(sessionCookie).toMatch(/httponly/i);
    expect(sessionCookie).toMatch(/secure/i);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    return key;
  }

  it('creates no account on abandoned onboarding; successful UV registration creates user, key, session atomically', async () => {
    await begin();
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(0);
    await register();
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(1);
    const session = await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }));
    expect(session?.user.name).toBe('Test user');
    expect(session?.session.passkeyVerifiedAt).toBeInstanceOf(Date);
    const passkeys = await (await request('/passkey/list-user-passkeys')).json() as { counter: unknown }[];
    expect(typeof passkeys[0].counter).toBe('number');
    expect(createAuth(sql, env).api).not.toHaveProperty('deletePasskey');
  });

  it('requires UV even though the upstream verifier permits ceremonies without it', async () => {
    const start = await begin({ name: 'No verification', email: 'unverified@example.com' });
    const key = await credential();
    const response = await request('/passkey/verify-registration', { response: await key.registration(start.challenge, origin, false), createSession: true });
    expect(response.status).toBe(403);
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(0);
  });

  it('preserves a requested email only after a valid ceremony without treating it as a verified recovery address', async () => {
    const start = await begin({ name: 'Email owner', email: '  Owner@Example.com  ' });
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(0);
    const key = await credential();
    const response = await request('/passkey/verify-registration', { response: await key.registration(start.challenge), createSession: true });
    expect(response.status, await response.clone().text()).toBe(200);
    const users = (await db.query<{ email: string; name: string; email_verified: boolean }>('SELECT email,name,email_verified FROM "user"')).rows;
    expect(users).toEqual([{ email: 'owner@example.com', name: 'Email owner', email_verified: false }]);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(1);
    expect(await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }))).not.toBeNull();
    await expect(request('/onboarding/context', { email: 'invalid-address' })).rejects.toMatchObject({ code: 'INVALID_EMAIL' });
  });

  it('rejects existing-email claims, including contexts issued before the first account completed signup', async () => {
    const first = await begin({ name: 'First owner', email: 'claim@example.com' });
    const firstCookies = new Map(cookies);
    const competing = await begin({ name: 'Other claimant', email: 'CLAIM@example.com' });
    const competingCookies = new Map(cookies);
    const firstKey = await credential(), competingKey = await credential();
    cookies = firstCookies;
    expect((await request('/passkey/verify-registration', { response: await firstKey.registration(first.challenge), createSession: true })).status).toBe(200);
    cookies = competingCookies;
    const rejected = await request('/passkey/verify-registration', { response: await competingKey.registration(competing.challenge), createSession: true });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'ACCOUNT_ALREADY_EXISTS' });
    expect((await db.query('SELECT name,email FROM "user"')).rows).toEqual([{ name: 'First owner', email: 'claim@example.com' }]);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM session')).rows).toHaveLength(1);
    expect(await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }))).toBeNull();
    const unsigned = JSON.stringify({ name: 'Impersonator', email: 'claim@example.com' });
    expect((await request(`/passkey/generate-register-options?context=${encodeURIComponent(unsigned)}`)).ok).toBe(false);
  });

  it('rejects replayed, expired, and foreign-origin registration challenges without creating users', async () => {
    const start = await begin();
    const key = await credential();
    const payload = { response: await key.registration(start.challenge, 'https://evil.example'), createSession: true };
    expect((await request('/passkey/verify-registration', payload)).ok).toBe(false);
    expect((await request('/passkey/verify-registration', { response: await key.registration(start.challenge), createSession: true })).ok).toBe(false);
    const fresh = await begin();
    await db.exec("UPDATE verification SET expires_at = now() - interval '1 minute'");
    expect((await request('/passkey/verify-registration', { response: await key.registration(fresh.challenge), createSession: true })).ok).toBe(false);
    const wrongRP = await begin();
    expect((await request('/passkey/verify-registration', { response: await key.registration(wrongRP.challenge, origin, true, 'evil.example'), createSession: true })).ok).toBe(false);
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(0);
  });

  it('context cannot nominate an existing account or create a user without createSession:true', async () => {
    await register();
    const user = (await db.query<{ id: string }>('SELECT id FROM "user"')).rows[0];
    cookies.clear();
    expect((await request(`/passkey/generate-register-options?context=${user.id}`)).ok).toBe(false);
    const start = await begin();
    const key = await credential();
    expect((await request('/passkey/verify-registration', { response: await key.registration(start.challenge) })).status).toBe(400);
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(1);
  });

  it('consumes successful context and rolls back user/context writes if credential persistence fails', async () => {
    const start = await begin();
    const key = await credential();
    expect((await request('/passkey/verify-registration', { response: await key.registration(start.challenge), createSession: true })).status).toBe(200);
    cookies.clear();
    expect((await request(`/passkey/generate-register-options?context=${start.context}`)).ok).toBe(false);
    const another = await begin();
    // A valid registration carrying an already registered credential must fail
    // its unique constraint after the hook attempted to create a second user.
    expect((await request('/passkey/verify-registration', { response: await key.registration(another.challenge), createSession: true })).ok).toBe(false);
    expect((await db.query('SELECT * FROM "user"')).rows).toHaveLength(1);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(1);
    const row = (await db.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM auth_onboarding WHERE context_hash = (SELECT context_hash FROM auth_onboarding WHERE consumed_at IS NULL LIMIT 1)')).rows[0];
    expect(row.consumed_at).toBeNull();
  });

  it('verifies a real signed assertion, enforces UV, and invalidates sessions on sign-out or expiry', async () => {
    const key = await register();
    expect((await request('/sign-out', {})).ok).toBe(true);
    expect(await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }))).toBeNull();
    const options = await (await request('/passkey/generate-authenticate-options')).json() as { challenge: string; userVerification: string };
    expect(options.userVerification).toBe('required');
    expect((await request('/passkey/verify-authentication', { response: await key.authentication(options.challenge, origin, false) })).status).toBe(403);
    const next = await (await request('/passkey/generate-authenticate-options')).json() as { challenge: string };
    expect((await request('/passkey/verify-authentication', { response: await key.authentication(next.challenge) })).status).toBe(200);
    expect(await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }))).not.toBeNull();
    await db.exec("UPDATE session SET expires_at = now() - interval '1 minute'");
    expect(await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() }))).toBeNull();
  });

  it('supports owner-only passkey addition/removal and keeps the final credential', async () => {
    await register();
    const session = (await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() })))!;
    const first = (await db.query<{ id: string }>('SELECT id FROM passkey')).rows[0].id;
    await expect(removePasskey(sql, session, first)).rejects.toMatchObject({ code: 'LAST_PASSKEY' });
    const start = await (await request('/passkey/generate-register-options')).json() as { challenge: string };
    const second = await credential();
    expect((await request('/passkey/verify-registration', { response: await second.registration(start.challenge), createSession: true })).status).toBe(200);
    await expect(removePasskey(sql, session, 'foreign-or-missing')).rejects.toMatchObject({ status: 404 });
    await removePasskey(sql, session, first);
    expect((await db.query('SELECT * FROM passkey')).rows).toHaveLength(1);
    await expect(removePasskey(sql, { ...session, session: { ...session.session, passkeyVerifiedAt: new Date(Date.now() - 301_000) } }, first)).rejects.toMatchObject({ code: 'PASSKEY_VERIFICATION_REQUIRED' });
  });

  it('stores only token hashes, keeps ownership private, and supports idempotent revocation', async () => {
    await register();
    const session = (await getAuthSession(sql, env, new Headers({ Cookie: cookieHeader() })))!;
    const issued = await createIngestionToken(sql, session, 'Exporter');
    expect(issued.token.split('.')[1]).toHaveLength(64);
    expect(await authenticateIngestionToken(sql, `Bearer ${issued.token}`)).toBe(session.user.id);
    expect(JSON.stringify((await db.query('SELECT * FROM ingestion_tokens')).rows)).not.toContain(issued.token);
    expect(JSON.stringify(await listIngestionTokens(sql, session.user.id))).not.toContain(issued.token);
    expect(await revokeIngestionToken(sql, 'foreign-owner', issued.id)).toBe(false);
    expect(await revokeIngestionToken(sql, session.user.id, issued.id)).toBe(true);
    expect(await revokeIngestionToken(sql, session.user.id, issued.id)).toBe(true);
    expect(await authenticateIngestionToken(sql, `Bearer ${issued.token}`)).toBeNull();
  });
});

describe('auth deployment and freshness boundary', () => {
  it('supports canonical deployment names and explicit legacy aliases with canonical precedence', () => {
    const canonical = readAuthConfig(env);
    const legacy = readAuthConfig({ AUTH_SECRET: env.BETTER_AUTH_SECRET, AUTH_BASE_URL: env.BETTER_AUTH_URL,
      DASHBOARD_ORIGINS: JSON.stringify([env.DASHBOARD_URL]), PASSKEY_RP_ID: env.PASSKEY_RP_ID, PASSKEY_RP_NAME: env.PASSKEY_RP_NAME });
    expect(legacy).toEqual(canonical);
    expect(readAuthConfig({ ...env, AUTH_SECRET: 'ignored', AUTH_BASE_URL: 'https://wrong.example', DASHBOARD_ORIGINS: '["https://wrong.example"]' })).toEqual(canonical);
    expect(() => readAuthConfig({ ...env, BETTER_AUTH_SECRET: '', AUTH_SECRET: env.BETTER_AUTH_SECRET })).toThrow();
    expect(() => readAuthConfig({ ...env, PASSKEY_RP_ID: undefined })).toThrow();
    expect(() => readAuthConfig({ ...env, PASSKEY_RP_NAME: undefined })).toThrow();
  });
  it('uses exact origins, production secure cookies, and validates RP and secret config', () => {
    const config = readAuthConfig(env);
    expect(config.secureCookies).toBe(true);
    expect(() => assertTrustedMutation(new Request(env.BETTER_AUTH_URL, { method: 'POST', headers: { Origin: origin } }), config)).not.toThrow();
    expect(() => assertTrustedMutation(new Request(env.BETTER_AUTH_URL, { method: 'POST', headers: { Origin: 'https://evil.example' } }), config)).toThrow();
    expect(() => assertTrustedMutation(new Request(env.BETTER_AUTH_URL, { method: 'POST' }), config)).toThrow();
    expect(() => readAuthConfig({ ...env, PASSKEY_RP_ID: 'other.example' })).toThrow();
    expect(() => readAuthConfig({ ...env, BETTER_AUTH_SECRET: 'short' })).toThrow();
  });
  it('requires proof in the preceding five minutes rather than merely an active session', () => {
    const session = { user: { id: 'owner', name: 'Owner' }, session: { id: 'session', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } } satisfies AuthSession;
    expect(() => requireFreshPasskey(session)).toThrow();
    expect(() => requireFreshPasskey({ ...session, session: { ...session.session, passkeyVerifiedAt: new Date(Date.now() - 299_000) } })).not.toThrow();
    expect(() => requireFreshPasskey({ ...session, session: { ...session.session, passkeyVerifiedAt: new Date(Date.now() + 1_000) } })).toThrow();
  });
});
