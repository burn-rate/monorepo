import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import healthFixture from './fixtures/health-exporter-v1.json';
import { createApp, type Env } from '../src/index';
import type { Sql } from '../src/db';

const mocks = vi.hoisted(() => ({
  session: vi.fn(), handleAuth: vi.fn(), authenticate: vi.fn(), encrypt: vi.fn(), store: vi.fn(), read: vi.fn()
}));
vi.mock('../src/auth', () => ({ getAuthSession: mocks.session, handleAuthRequest: mocks.handleAuth }));
vi.mock('../src/tokens', () => ({ authenticateIngestionToken: mocks.authenticate, createIngestionToken: vi.fn(), listIngestionTokens: vi.fn(), revokeIngestionToken: vi.fn() }));
vi.mock('../src/crypto', async (original) => ({ ...await original<object>(), encryptDump: mocks.encrypt }));
vi.mock('../src/encrypted-store', async (original) => ({ ...await original<object>(), storeEncryptedSamples: mocks.store, listEncryptedSamples: mocks.read }));

const env = {
  AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters', AUTH_BASE_URL: 'https://api.example.com',
  DASHBOARD_ORIGINS: '["https://app.example.com"]', PASSKEY_RP_ID: 'example.com', PASSKEY_RP_NAME: 'Burn Rate',
  ENCRYPTION_ENVIRONMENT: 'test', HEALTH_KEK_ID: 'test-key', HEALTH_KEKS: '{}'
} as Env;

function harness(overrides: Partial<Env> = {}) {
  const order: string[] = [];
  const put = vi.fn(async (_key: string, _value: string, _options?: unknown) => { order.push('dump'); return { key: 'saved' }; });
  const query = vi.fn(async () => ({ rows: [{ hits: 1 }], rowCount: 1 }));
  const end = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ query, end }) as unknown as Sql);
  const app = createApp(connect);
  const bindings = { ...env, ...overrides, HOOK_DUMPS: { put } as unknown as R2Bucket };
  const request = (path: string, init?: RequestInit) => app.request(`https://api.example.com${path}`, init, bindings);
  return { order, put, query, end, connect, request };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.session.mockResolvedValue(null);
  mocks.authenticate.mockResolvedValue('owner-1');
  mocks.encrypt.mockResolvedValue({ version: 1, keyId: 'key', iv: 'nonce', ciphertext: 'protected' });
  mocks.store.mockResolvedValue(2);
});
afterEach(() => vi.restoreAllMocks());

describe('Worker runtime security and lifecycle', () => {
  it('exports liveness and contracts without configuration, database, or secrets', async () => {
    const { request, connect } = harness();
    expect(await (await request('/health')).json()).toEqual({ status: 'ok', service: 'burn-rate-api' });
    expect((await request('/openapi.json')).status).toBe(200);
    expect(connect).not.toHaveBeenCalled();
  });
  it('authenticates protected requests before validating query fields and always closes the request connection', async () => {
    const { request, connect, end } = harness();
    const response = await request('/api/health/samples?metric=unknown');
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
    expect(mocks.read).not.toHaveBeenCalled();
  });
  it('restricts credentialed CORS and mutations to exact trusted origins', async () => {
    const { request, connect } = harness();
    const blocked = await request('/api/ingestion-tokens', { method: 'POST', headers: { Origin: 'https://evil.example.net' } });
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('access-control-allow-origin')).toBeNull();
    const allowed = await request('/api/me', { method: 'OPTIONS', headers: { Origin: 'https://app.example.com', 'Access-Control-Request-Method': 'GET' } });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true');
    expect(connect).not.toHaveBeenCalled();
  });
  it('keeps response policies on successful raw service and auth responses', async () => {
    mocks.session.mockResolvedValue({ user: { id: 'owner-1', name: 'Person' }, session: {} });
    mocks.handleAuth.mockResolvedValue(Response.json({ session: 'safe' }));
    const { request } = harness();
    for (const path of ['/api/me', '/api/auth/get-session']) {
      const response = await request(path, { headers: { Origin: 'https://app.example.com' } });
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
  });
  it('rejects non-POST uploads and invalid credentials without reading or retaining bodies', async () => {
    const { request, put } = harness();
    expect((await request('/hook')).status).toBe(405);
    mocks.authenticate.mockResolvedValue(null);
    const response = await request('/hook', { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body: 'sensitive body' });
    expect(response.status).toBe(401);
    expect(put).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });
  it('rejects streamed oversized payloads and distributed rate-limit excess before retention', async () => {
    const { request, put, query } = harness({ MAX_UPLOAD_BYTES: '3' });
    expect((await request('/hook', { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body: '💚' })).status).toBe(413);
    query.mockResolvedValue({ rows: [{ hits: 61 }], rowCount: 1 });
    const response = await request('/hook', { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body: '{}' });
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
    expect(put).not.toHaveBeenCalled();
  });
  it('encrypts the credential-redacted dump before samples and derives ownership only from the token', async () => {
    const { request, put, order, end } = harness();
    mocks.store.mockImplementation(async () => { order.push('samples'); return 2; });
    const response = await request('/hook?token=query-secret&userId=spoofed', {
      method: 'POST', headers: { Authorization: 'Bearer secret', Cookie: 'session-secret', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...healthFixture, userId: 'spoofed' })
    });
    expect(response.status).toBe(200);
    expect(order).toEqual(['dump', 'samples']);
    const encryptedInput = JSON.stringify(mocks.encrypt.mock.calls[0][4]);
    expect(encryptedInput).not.toContain('query-secret');
    expect(encryptedInput).not.toContain('session-secret');
    expect(encryptedInput).not.toContain('Bearer secret');
    expect(mocks.encrypt.mock.calls[0][2]).toBe('owner-1');
    expect(mocks.store.mock.calls[0][2]).toBe('owner-1');
    expect(mocks.store.mock.calls[0][3].every((s: { userId: string }) => s.userId === 'owner-1')).toBe(true);
    expect(put.mock.calls[0][1]).not.toContain('Apple');
    expect(end).toHaveBeenCalledTimes(1);
  });
  it('retains unknown/non-JSON uploads through the same encrypted dump path', async () => {
    const { request, put } = harness();
    const response = await request('/hook', { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body: 'private unrecognized text' });
    expect(response.status).toBe(200);
    expect(mocks.encrypt.mock.calls[0][4].body).toBe('private unrecognized text');
    expect(JSON.stringify(put.mock.calls)).not.toContain('private unrecognized text');
  });
  it('fails safely on crypto, dump and sample failures, never falsely acknowledging success', async () => {
    const { request, put } = harness();
    const upload = () => request('/hook', { method: 'POST', headers: { Authorization: 'Bearer test-credential' }, body: JSON.stringify(healthFixture) });
    mocks.encrypt.mockRejectedValueOnce(new Error('private crypto internals'));
    expect((await upload()).status).toBe(502);
    expect(put).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
    put.mockRejectedValueOnce(new Error('private R2 internals'));
    expect((await upload()).status).toBe(502);
    expect(mocks.store).not.toHaveBeenCalled();
    mocks.store.mockRejectedValueOnce(new Error('SQL parameters: private health data'));
    const failure = await upload();
    expect(failure.status).toBe(502);
    const result = await failure.json() as { dumpKey: string; error: string };
    expect(result.dumpKey).toMatch(/^encrypted\/owner-1\//);
    expect(result.error).toBe('timeseries-storage-failed');
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain('private');
  });
});

describe('Path-based ingestion /ingest/:userId', () => {
  it('rejects unknown users before reading or retaining the body', async () => {
    const { request, query, put } = harness();
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // user lookup -> unknown
    const response = await request('/ingest/nobody', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'sensitive body' });
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'unknown-user' } });
    expect(put).not.toHaveBeenCalled();
    expect(mocks.encrypt).not.toHaveBeenCalled();
    expect(mocks.store).not.toHaveBeenCalled();
  });

  it('derives ownership from the URL, not the payload, and encrypts the dump before samples', async () => {
    const { request, order, put, end } = harness();
    mocks.store.mockImplementation(async () => { order.push('samples'); return 2; });
    const response = await request('/ingest/url-owner?apiKey=query-secret', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...healthFixture, userId: 'spoofed' })
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, stored: 2 });
    expect(order).toEqual(['dump', 'samples']);
    // Ownership comes from the URL: payload userId is ignored everywhere.
    expect(mocks.encrypt.mock.calls[0][2]).toBe('url-owner');
    expect(mocks.store.mock.calls[0][2]).toBe('url-owner');
    expect(mocks.store.mock.calls[0][3].every((s: { userId: string }) => s.userId === 'url-owner')).toBe(true);
    expect(mocks.encrypt.mock.calls[0][4].path).toBe('/ingest/url-owner');
    // Credential redaction: query strings never reach the encrypted dump, and
    // retained R2 bytes are ciphertext (no fixture plaintext).
    expect(JSON.stringify(mocks.encrypt.mock.calls[0][4])).not.toContain('query-secret');
    expect(put.mock.calls[0][1]).not.toContain('Apple');
    expect(end).toHaveBeenCalledTimes(1);
  });
});
