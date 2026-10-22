import { describe, expect, it, vi } from 'vitest';
import { OpenAPIHono } from '@hono/zod-openapi';
import { healthSampleSchema, healthSamplesQuerySchema } from '@burn-rate/api-schema';
import { createOfflineContractApp, getOpenApiDocument, registerApiRoutes, type ApiEnvironment, type ApiServices } from '../src/routes';

const validQuery = { metric: 'heart_rate', from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' };

describe('frontend contracts', () => {
  it('requires supported metrics, explicit offsets, positive ranges, and bounded pages', () => {
    expect(healthSamplesQuerySchema.parse(validQuery).limit).toBe(100);
    expect(healthSamplesQuerySchema.parse({ ...validQuery, limit: '500' }).limit).toBe(500);
    expect(healthSamplesQuerySchema.parse({ ...validQuery, from: '2026-10-01T02:00:00+02:00' }).from).toContain('+02:00');
    for (const invalid of [
      { ...validQuery, metric: 'unrecognized' }, { ...validQuery, metric: undefined },
      { ...validQuery, from: '2026-10-01T00:00:00' }, { ...validQuery, to: validQuery.from },
      { ...validQuery, to: '2026-11-01T00:00:00.001Z' },
      { ...validQuery, limit: 501 }, { ...validQuery, limit: 0 }, { ...validQuery, limit: 1.5 }
    ]) expect(healthSamplesQuerySchema.safeParse(invalid).success).toBe(false);
  });

  it('serializes domain samples with ISO timestamps and strips storage details', () => {
    const sample = healthSampleSchema.parse({
      id: 'opaque', metric: 'heart_rate', time: validQuery.from, endedAt: validQuery.from,
      value: 61, valueMin: null, valueMax: null, unit: 'bpm', sourceName: 'watch',
      device: null, extId: null, dumpKey: 'private-location', envelope: { secret: true }
    });
    expect(JSON.parse(JSON.stringify(sample))).toEqual(sample);
    expect(sample).not.toHaveProperty('dumpKey');
    expect(sample).not.toHaveProperty('envelope');
  });

  it('exports offline deterministically with distinct security schemes and stable operation IDs', async () => {
    const app = createOfflineContractApp();
    const document = getOpenApiDocument(app);
    expect(document.openapi).toBe('3.1.0');
    expect(JSON.stringify(document)).toBe(JSON.stringify(getOpenApiDocument(createOfflineContractApp())));
    expect(document.paths?.['/api/health/samples']?.get?.operationId).toBe('listHealthSamples');
    expect(document.paths?.['/api/health/samples']?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths?.['/score']?.get?.operationId).toBe('getScore');
    expect(document.paths?.['/score']?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths?.['/loans']?.get?.operationId).toBe('listLoans');
    expect(document.paths?.['/loans']?.get?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths).not.toHaveProperty('/loan');
    expect(document.paths?.['/loans']?.post?.operationId).toBe('createLoan');
    expect(document.paths?.['/loans']?.post?.security).toEqual([{ sessionCookie: [] }]);
    expect(document.paths?.['/loans']?.post?.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'header', name: 'idempotency-key', required: true })]));
    expect(Object.keys(document.paths?.['/loans']?.post?.responses ?? {})).toEqual(['200', '201', '400', '401', '403', '409', '429', '503']);
    expect(document.paths?.['/hook']?.post?.security).toEqual([{ ingestionBearer: [] }]);
    expect(document.paths).not.toHaveProperty('/api/auth/sign-in');
    expect(await (await app.request('/health')).json()).toEqual({ status: 'ok', service: 'burn-rate-api' });
  });

  it('rejects invalid query inputs before invoking sample services with the documented error envelope', async () => {
    const sampleRead = vi.fn(async () => Response.json({ items: [], nextCursor: null }));
    const unavailable = async () => new Response(null, { status: 503 });
    const services: ApiServices<Record<string, never>> = {
      timeseriesHealth: unavailable, getCurrentUser: unavailable, listMetrics: unavailable,
      listHealthSamples: sampleRead, createIngestionToken: unavailable,
      listIngestionTokens: unavailable, revokeIngestionToken: unavailable, getScore: unavailable, listLoans: unavailable, createLoan: unavailable, ingest: unavailable
    };
    const app = new OpenAPIHono<ApiEnvironment<Record<string, never>>>();
    app.use('*', async (c, next) => { c.set('requestId', 'test-request'); await next(); });
    registerApiRoutes(app, services);
    const invalid = await app.request('/api/health/samples?metric=heart_rate');
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: { code: 'invalid-request', message: 'Invalid request parameters.', requestId: 'test-request' } });
    expect(sampleRead).not.toHaveBeenCalled();
    const valid = await app.request(`/api/health/samples?${new URLSearchParams(validQuery)}`);
    expect(valid.status).toBe(200);
    expect(sampleRead.mock.calls).toHaveLength(1);
  });

  it('does not consume or JSON-validate an upload before its ingestion service authorizes it', async () => {
    let consumed = true;
    const unavailable = async () => new Response(null, { status: 503 });
    const app = new OpenAPIHono<ApiEnvironment<Record<string, never>>>();
    registerApiRoutes(app, {
      timeseriesHealth: unavailable, getCurrentUser: unavailable, listMetrics: unavailable,
      listHealthSamples: unavailable, createIngestionToken: unavailable,
      listIngestionTokens: unavailable, revokeIngestionToken: unavailable, getScore: unavailable, listLoans: unavailable, createLoan: unavailable,
      ingest: async ({ request }) => { consumed = request.bodyUsed; return new Response(null, { status: 401 }); }
    });
    const response = await app.request('/hook', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{invalid' });
    expect(response.status).toBe(401);
    expect(consumed).toBe(false);
  });
});
