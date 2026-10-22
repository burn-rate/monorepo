import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type Env } from '../src/index';
import { RequestFailure } from '../src/limits';
import type { Sql } from '../src/db';
import { approvedDecision, deniedDecision, unknownCredit } from './fixtures/activity-credit';

const mocks = vi.hoisted(() => ({ session: vi.fn(), score: vi.fn(), loan: vi.fn(), list: vi.fn() }));
vi.mock('../src/auth', () => ({ getAuthSession: mocks.session, handleAuthRequest: vi.fn() }));
vi.mock('../src/credit/service', () => ({ getCreditScore: mocks.score, createCreditLoan: mocks.loan, listCreditLoans: mocks.list }));
const env = {
  BETTER_AUTH_SECRET: 'test-only-auth-secret-with-more-than-32-characters', BETTER_AUTH_URL: 'https://api.example.com',
  DASHBOARD_URL: 'https://app.example.com', PASSKEY_RP_ID: 'example.com', PASSKEY_RP_NAME: 'Burn Rate',
  ENCRYPTION_ENVIRONMENT: 'test', HEALTH_KEK_ID: 'test-key', HEALTH_KEKS: '{}'
} as Env;
const origin = 'https://app.example.com';
const valid = { amountKcal: 200, durationDays: 7, timeZone: 'America/Los_Angeles' };
const headers = { Origin: origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'application-1' };
function harness() {
  const query = vi.fn(async () => ({ rows: [], rowCount: 0 }));
  const end = vi.fn(async () => {});
  const sql = { query, end } as unknown as Sql;
  const connect = vi.fn(async () => sql);
  const app = createApp(connect);
  const request = (path: string, init?: RequestInit) => app.request(`https://api.example.com${path}`, init, env);
  return { request, connect, query, end, sql };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.session.mockResolvedValue({ user: { id: 'session-owner', name: 'Reader' }, session: {} });
  mocks.score.mockResolvedValue(unknownCredit);
  mocks.list.mockResolvedValue({ loans: [] });
  mocks.loan.mockResolvedValue({ status: 201, body: approvedDecision });
});
afterEach(() => vi.restoreAllMocks());

describe('root credit routes', () => {
  it('authenticates before query/body/header validation and closes every opened connection', async () => {
    mocks.session.mockResolvedValue(null);
    const { request, end, connect } = harness();
    for (const [path, init] of [
      ['/score?timeZone=invalid', undefined],
      ['/loans', undefined],
      ['/loans', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: '{invalid' }]
    ] as const) {
      const response = await request(path, init);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
      expect((await response.json() as { error: { requestId: string } }).error.requestId).toBe(response.headers.get('x-request-id'));
    }
    expect(connect).toHaveBeenCalledTimes(3);
    expect(end).toHaveBeenCalledTimes(3);
    expect(mocks.score).not.toHaveBeenCalled();
    expect(mocks.loan).not.toHaveBeenCalled();
  });
  it('rejects untrusted and missing mutation origins before connecting or creating loans', async () => {
    const { request, connect } = harness();
    for (const Origin of ['https://evil.example', 'https://app.example.com.evil.example', undefined]) {
      const response = await request('/loans', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(Origin ? { Origin } : {}) }, body: '{invalid' });
      expect(response.status).toBe(403);
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect(connect).not.toHaveBeenCalled();
    expect(mocks.loan).not.toHaveBeenCalled();
  });
  it('permits credentialed case-insensitive idempotency preflights only on the loan path', async () => {
    const { request, connect } = harness();
    const preflight = (path: string, requestHeaders: string, requestOrigin = origin, method = 'POST') => request(path, {
      method: 'OPTIONS', headers: { Origin: requestOrigin, 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': requestHeaders }
    });
    const response = await preflight('/loans', 'cOnTeNt-TyPe, IDEMPOTENCY-KEY');
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('access-control-allow-headers')).toBe('Content-Type, Idempotency-Key');
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST');
    expect(response.headers.get('cache-control')).toBe('no-store');
    for (const blocked of [
      await preflight('/loans', 'Idempotency-Key', 'https://evil.example'),
      await preflight('/loans', 'Authorization'),
      await preflight('/loans', '', origin, 'DELETE'),
      await preflight('/loans', 'Idempotency-Key', origin, 'GET'),
      await preflight('/score', 'Idempotency-Key', origin, 'GET')
    ]) expect(blocked.status).toBe(403);
    expect((await preflight('/score', '', origin, 'GET')).status).toBe(204);
    const listing = await preflight('/loans', '', origin, 'GET');
    expect(listing.status).toBe(204);
    expect(listing.headers.get('access-control-allow-headers')).toBe('Content-Type');
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects invalid requests without calling credit storage and prevents owner spoofing', async () => {
    const { request, query } = harness();
    for (const path of ['/score', '/score?timeZone=invalid', '/score?timeZone=UTC&userId=attacker']) {
      expect((await request(path)).status).toBe(400);
    }
    for (const body of [{ ...valid, amountKcal: 0 }, { ...valid, durationDays: 31 }, { ...valid, userId: 'attacker' }]) {
      const response = await request('/loans', { method: 'POST', headers, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect((await request('/loans', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(valid) })).status).toBe(400);
    expect((await request('/loans', { method: 'POST', headers, body: '{invalid' })).status).toBe(400);
    expect(mocks.score).not.toHaveBeenCalled();
    expect(mocks.loan).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('uses session ownership and retains browser policies on score, approval and denial', async () => {
    const { request, sql, end } = harness();
    const score = await request('/score?timeZone=America%2FLos_Angeles', { headers: { Origin: origin } });
    expect(await score.json()).toEqual(unknownCredit);
    expect(mocks.score).toHaveBeenCalledWith(sql, env, 'session-owner', 'America/Los_Angeles');
    const approval = await request('/loans', { method: 'POST', headers, body: JSON.stringify(valid) });
    expect(approval.status).toBe(201);
    expect(await approval.json()).toEqual(approvedDecision);
    expect(mocks.loan).toHaveBeenCalledWith(sql, env, 'session-owner', valid, 'application-1');
    mocks.loan.mockResolvedValueOnce({ status: 200, body: deniedDecision });
    const denial = await request('/loans', { method: 'POST', headers, body: JSON.stringify(valid) });
    expect(denial.status).toBe(200);
    expect(await denial.json()).toEqual(deniedDecision);
    for (const response of [score, approval, denial]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toBe('Origin');
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(end).toHaveBeenCalledTimes(3);
  });
  it('validates service outputs against the published response contracts and fails safely', async () => {
    const { request, end } = harness();
    mocks.score.mockResolvedValueOnce({ ...unknownCredit, score: 'invented' });
    const invalid = await request('/score?timeZone=UTC');
    expect(invalid.status).toBe(503);
    expect(await invalid.text()).not.toContain('invented');
    mocks.loan.mockResolvedValueOnce({ status: 201, body: deniedDecision });
    expect((await request('/loans', { method: 'POST', headers, body: JSON.stringify(valid) })).status).toBe(503);
    mocks.loan.mockRejectedValueOnce(new RequestFailure(409, 'idempotency-conflict', 'Idempotency key was already used for a different request.'));
    const conflict = await request('/loans', { method: 'POST', headers, body: JSON.stringify(valid) });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'idempotency-conflict' } });
    mocks.score.mockRejectedValueOnce(new Error('private SQL parameters and ciphertext'));
    const unavailable = await request('/score?timeZone=UTC');
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private');
    mocks.loan.mockRejectedValueOnce(new RequestFailure(429, 'rate-limit', 'Retry later.'));
    const throttled = await request('/loans', { method: 'POST', headers, body: JSON.stringify(valid) });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('retry-after')).toBe('60');
    expect(end).toHaveBeenCalledTimes(5);
  });
  it('lists empty and populated session-owned loans without requiring a timezone', async () => {
    const { request, sql, end } = harness();
    const empty = await request('/loans', { headers: { Origin: origin } });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ loans: [] });
    expect(mocks.list).toHaveBeenLastCalledWith(sql, env, 'session-owner');
    mocks.list.mockResolvedValueOnce({ loans: [approvedDecision.loan] });
    const populated = await request('/loans?userId=attacker', { headers: { Origin: origin } });
    expect(await populated.json()).toEqual({ loans: [approvedDecision.loan] });
    expect(mocks.list).toHaveBeenLastCalledWith(sql, env, 'session-owner');
    mocks.session.mockResolvedValueOnce({ user: { id: 'other-session-owner', name: 'Other reader' }, session: {} });
    expect((await request('/loans')).status).toBe(200);
    expect(mocks.list).toHaveBeenLastCalledWith(sql, env, 'other-session-owner');
    for (const response of [empty, populated]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
      expect(response.headers.get('access-control-allow-credentials')).toBe('true');
      expect(response.headers.get('x-request-id')).toMatch(/^[a-f0-9-]{36}$/);
    }
    expect(end).toHaveBeenCalledTimes(3);
  });
  it('fails closed on loan-list storage or response validation failures and removes the old path', async () => {
    const { request, end, connect } = harness();
    expect((await request('/loan', { method: 'POST', headers, body: JSON.stringify(valid) })).status).toBe(404);
    expect(connect).not.toHaveBeenCalled();
    mocks.list.mockRejectedValueOnce(new Error('private SQL parameters and ciphertext'));
    const unavailable = await request('/loans', { headers: { Origin: origin } });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('private');
    expect(unavailable.headers.get('access-control-allow-origin')).toBe(origin);
    expect(unavailable.headers.get('cache-control')).toBe('no-store');
    mocks.list.mockResolvedValueOnce({ loans: [{ ...approvedDecision.loan, principalKcal: 'invalid' }] });
    expect((await request('/loans')).status).toBe(503);
    expect(end).toHaveBeenCalledTimes(2);
  });

});
