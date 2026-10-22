import { describe, expect, it } from 'vitest';
import {
  createClient, createConfig, createIngestionToken, getCurrentUser,
  listHealthSamples, listIngestionTokens, revokeIngestionToken, getScore, createLoan, listLoans
} from '@burn-rate/sdk';

describe('generated SDK consumer', () => {
  it('supports separately configured concurrent SSR sessions without sharing cookies', async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      await Promise.resolve();
      return Response.json({ id: request.headers.get('Cookie'), name: 'Reader' });
    };
    const alice = createClient(createConfig({ baseUrl: 'https://trusted-api.example', fetch, credentials: 'include', headers: { Cookie: 'session=alice' } }));
    const bob = createClient(createConfig({ baseUrl: 'https://trusted-api.example', fetch, credentials: 'include', headers: { Cookie: 'session=bob' } }));
    const [first, second] = await Promise.all([getCurrentUser({ client: alice }), getCurrentUser({ client: bob })]);
    expect(first.data?.id).toBe('session=alice');
    expect(second.data?.id).toBe('session=bob');
    expect(requests.map((request) => request.headers.get('Cookie'))).toEqual(['session=alice', 'session=bob']);
    expect(requests.every((request) => request.credentials === 'include')).toBe(true);
  });

  it('type-checks and sends sample reads and token management from an independent consumer', async () => {
    const requests: Request[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init); requests.push(request);
      if (request.method === 'DELETE') return Response.json({ revoked: true });
      if (request.method === 'POST') return Response.json({ token: { id: 'token', name: 'Watch', createdAt: '2026-10-01T00:00:00Z', revokedAt: null }, secret: 'only-once' }, { status: 201 });
      return Response.json({ items: [], nextCursor: null });
    };
    const client = createClient(createConfig({ baseUrl: 'https://trusted-api.example', fetch, credentials: 'include' }));
    const samples = await listHealthSamples({ client, query: { metric: 'heart_rate', from: '2026-10-01T00:00:00Z', to: '2026-10-02T00:00:00Z', limit: 100 } });
    expect(samples.data?.items).toEqual([]);
    expect(samples.data?.nextCursor).toBeNull();
    const created = await createIngestionToken({ client, body: { name: 'Watch' } });
    expect(created.data?.secret).toBe('only-once');
    await listIngestionTokens({ client });
    expect((await revokeIngestionToken({ client, path: { id: 'token' } })).data?.revoked).toBe(true);
    expect(requests.map((request) => request.method)).toEqual(['GET', 'POST', 'GET', 'DELETE']);
    expect(new URL(requests[0].url).searchParams.get('metric')).toBe('heart_rate');
  });

  it('sends credit query, session cookies, JSON and idempotency keys and narrows denial outcomes', async () => {
    const requests: Request[] = [];
    const credit = {
      score: null, creditLimitKcal: 250, outstandingKcal: 0, availableKcal: 250,
      repaymentMultiplier: 1.5, historyDays: 0, timeZone: 'America/Los_Angeles',
      calculatedAt: '2026-10-22T21:05:00Z', policyVersion: 'ring-consistency-v1' as const
    };
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === 'GET' && new URL(request.url).pathname === '/loans') return Response.json({ loans: [] });
      if (request.method === 'GET') return Response.json(credit);
      return Response.json({ outcome: 'denied', loan: null, reason: 'insufficient-credit',
        message: 'The requested calories exceed available credit.', credit });
    };
    const client = createClient(createConfig({ baseUrl: 'https://trusted-api.example', fetch,
      credentials: 'include', headers: { Cookie: 'session=reader' } }));
    const score = await getScore({ client, query: { timeZone: 'America/Los_Angeles' } });
    expect(score.data?.score).toBeNull();
    const loans = await listLoans({ client });
    expect(loans.data?.loans).toEqual([]);
    const decision = await createLoan({ client,
      headers: { 'idempotency-key': 'retry-stable-application-key' },
      body: { amountKcal: 300.125, durationDays: 7, timeZone: 'America/Los_Angeles' }
    });
    if (decision.data?.outcome !== 'denied') throw new Error('Expected a business denial');
    const noLoan: null = decision.data.loan;
    expect(noLoan).toBeNull();
    expect(decision.data.reason).toBe('insufficient-credit');
    expect(decision.response?.status).toBe(200);
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/score', '/loans', '/loans']);
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'POST']);
    expect(requests[0].url).toContain('timeZone=America%2FLos_Angeles');
    expect(requests.every(request => request.credentials === 'include' && request.headers.get('Cookie') === 'session=reader')).toBe(true);
    expect(requests[2].headers.get('Idempotency-Key')).toBe('retry-stable-application-key');
    expect(requests[2].headers.get('Content-Type')).toContain('application/json');
    expect(await requests[2].json()).toEqual({ amountKcal: 300.125, durationDays: 7, timeZone: 'America/Los_Angeles' });
  });

});
