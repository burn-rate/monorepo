import { describe, expect, it } from 'vitest';
import {
  createClient, createConfig, createIngestionToken, getCurrentUser,
  listHealthSamples, listIngestionTokens, revokeIngestionToken
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
});
