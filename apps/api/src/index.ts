import { OpenAPIHono } from '@hono/zod-openapi';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HTTPException } from 'hono/http-exception';
import { KNOWN_METRICS } from '@burn-rate/api-schema';
import { getSql, type Sql } from './db';
import { AuthError, assertTrustedMutation, readAuthConfig, type AuthEnvironment } from './auth-config';
import { getAuthSession, handleAuthRequest, type AuthSession } from './auth';
import { authenticateIngestionToken, createIngestionToken, listIngestionTokens, revokeIngestionToken } from './tokens';
import { CryptoFailure, encryptDump, type CryptoConfig } from './crypto';
import { InvalidSampleQuery, listEncryptedSamples, storeEncryptedSamples } from './encrypted-store';
import { mapPayload } from './ingest';
import { enforceRateLimit, positiveLimit, readBoundedBody, RequestFailure } from './limits';
import { registerApiRoutes, type ApiEnvironment, type ApiRequest } from './routes';

export interface Env extends AuthEnvironment, CryptoConfig {
  HOOK_DUMPS: R2Bucket;
  TIMESERIES_DB: Hyperdrive;
  MAX_UPLOAD_BYTES?: string;
  UPLOADS_PER_MINUTE?: string;
  AUTH_ATTEMPTS_PER_MINUTE?: string;
  TOKENS_PER_MINUTE?: string;
}

interface RequestState { sql?: Promise<Sql>; session?: AuthSession; allowedOrigin?: string }

/** Services and connections are constructed lazily, once per request, and always cleaned up. */
export function createApp(connect: (env: Env) => Promise<Sql> = getSql) {
  const app = new OpenAPIHono<ApiEnvironment<Env>>();
  const states = new WeakMap<Request, RequestState>();
  const sqlFor = (request: Request, env: Env) => {
    const state = states.get(request)!;
    return state.sql ??= connect(env);
  };
  const sessionFor = (ctx: ApiRequest<Env>) => {
    const session = states.get(ctx.request)?.session;
    if (!session) throw new AuthError(401, 'unauthorized', 'A valid session is required');
    return session;
  };

  app.use('*', async (c, next) => {
    const state: RequestState = {};
    states.set(c.req.raw, state);
    c.set('requestId', crypto.randomUUID());
    c.header('X-Request-Id', c.get('requestId'));
    try { await next(); }
    finally {
      // Hono does not merge prepared headers into a raw Response. Set response
      // policy after handlers (including Better Auth) have finalized it.
      c.header('X-Request-Id', c.get('requestId'));
      const path = new URL(c.req.url).pathname;
      if (path !== '/health' && path !== '/openapi.json') c.header('Cache-Control', 'no-store');
      if (path.startsWith('/api/') || path === '/timeseries/health') {
        c.header('Vary', 'Origin');
        if (state.allowedOrigin) {
          c.header('Access-Control-Allow-Origin', state.allowedOrigin);
          c.header('Access-Control-Allow-Credentials', 'true');
        }
      }
      if (state.sql) {
        const sql = await state.sql.catch(() => undefined);
        await sql?.end().catch(() => {});
      }
      states.delete(c.req.raw);
    }
  });

  app.use('*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path !== '/health' && path !== '/openapi.json') c.header('Cache-Control', 'no-store');
    const isBrowserApi = path.startsWith('/api/') || path === '/timeseries/health';
    if (isBrowserApi) {
      const config = readAuthConfig(c.env);
      const origin = c.req.header('Origin');
      c.header('Vary', 'Origin');
      if (origin && config.trustedOrigins.includes(origin)) {
        states.get(c.req.raw)!.allowedOrigin = origin;
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Credentials', 'true');
      }
      if (c.req.method === 'OPTIONS') {
        if (!origin || !config.trustedOrigins.includes(origin)) throw new AuthError(403, 'untrusted-origin', 'The request origin is not allowed');
        const requestedMethod = c.req.header('Access-Control-Request-Method');
        const requestedHeaders = (c.req.header('Access-Control-Request-Headers') ?? '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean);
        if (!requestedMethod || !['GET', 'POST', 'DELETE'].includes(requestedMethod) || requestedHeaders.some(h => h !== 'content-type')) {
          throw new AuthError(403, 'untrusted-preflight', 'The requested cross-origin operation is not allowed');
        }
        c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE');
        c.header('Access-Control-Allow-Headers', 'Content-Type');
        return c.body(null, 204);
      }
      assertTrustedMutation(c.req.raw, config);
      if (!path.startsWith('/api/auth/')) {
        const session = await getAuthSession(await sqlFor(c.req.raw, c.env), c.env, c.req.raw.headers);
        if (!session) throw new AuthError(401, 'unauthorized', 'A valid session is required');
        states.get(c.req.raw)!.session = session;
      }
    }
    await next();
  });

  app.all('/api/auth/*', async c => {
    const path = new URL(c.req.url).pathname;
    const sql = await sqlFor(c.req.raw, c.env);
    if (/\/(onboarding\/context|generate-register-options|verify-registration|generate-authenticate-options|verify-authentication)$/.test(path)) {
      const identity = `${c.env.AUTH_SECRET}:${c.req.header('CF-Connecting-IP') ?? 'unknown'}`;
      await enforceRateLimit(sql, 'auth', identity, positiveLimit(c.env.AUTH_ATTEMPTS_PER_MINUTE, 10, 1000));
    }
    let request = c.req.raw;
    if (!['GET', 'HEAD'].includes(request.method)) {
      const body = await readBoundedBody(request, 64 * 1024);
      request = new Request(request, { body });
    }
    return handleAuthRequest(request, sql, c.env);
  });

  registerApiRoutes(app, {
    async timeseriesHealth(ctx) {
      const { rows } = await (await sqlFor(ctx.request, ctx.env)).query('select version() as version');
      return Response.json({ status: 'ok', version: rows[0].version });
    },
    async getCurrentUser(ctx) {
      const { user } = sessionFor(ctx);
      return Response.json({ id: user.id, name: user.name });
    },
    async listMetrics() {
      return Response.json({ items: Object.entries(KNOWN_METRICS).map(([id, metric]) => ({ id, ...metric })) });
    },
    async listHealthSamples(ctx, query) {
      return Response.json(await listEncryptedSamples(await sqlFor(ctx.request, ctx.env), ctx.env, sessionFor(ctx).user.id, query));
    },
    async createIngestionToken(ctx, input) {
      const session = sessionFor(ctx);
      const sql = await sqlFor(ctx.request, ctx.env);
      await enforceRateLimit(sql, 'token-create', session.user.id, positiveLimit(ctx.env.TOKENS_PER_MINUTE, 10, 100));
      const { token: secret, ...token } = await createIngestionToken(sql, session, input.name);
      return Response.json({ token, secret }, { status: 201 });
    },
    async listIngestionTokens(ctx) {
      return Response.json({ items: await listIngestionTokens(await sqlFor(ctx.request, ctx.env), sessionFor(ctx).user.id) });
    },
    async revokeIngestionToken(ctx, id) {
      if (!await revokeIngestionToken(await sqlFor(ctx.request, ctx.env), sessionFor(ctx).user.id, id)) {
        throw new RequestFailure(404, 'not-found', 'Credential not found');
      }
      return Response.json({ revoked: true });
    },
    async ingest(ctx) {
      // Invalid credentials are rejected before reading or retaining the body.
      const authorization = ctx.request.headers.get('Authorization');
      if (!authorization?.startsWith('Bearer ')) throw new AuthError(401, 'unauthorized', 'A valid ingestion bearer token is required');
      const sql = await sqlFor(ctx.request, ctx.env);
      const ownerId = await authenticateIngestionToken(sql, authorization);
      if (!ownerId) throw new AuthError(401, 'unauthorized', 'A valid ingestion bearer token is required');
      await enforceRateLimit(sql, 'upload', ownerId, positiveLimit(ctx.env.UPLOADS_PER_MINUTE, 60, 10000));
      const raw = await readBoundedBody(ctx.request, positiveLimit(ctx.env.MAX_UPLOAD_BYTES, 5 * 1024 * 1024, 25 * 1024 * 1024));
      let body: unknown = raw;
      try { body = JSON.parse(raw); } catch { /* Unknown/non-JSON captures remain encrypted. */ }
      const dumpId = crypto.randomUUID();
      const dumpKey = `encrypted/${ownerId}/${dumpId}.json`;
      const receivedAt = new Date().toISOString();
      const contentType = ctx.request.headers.get('content-type')?.split(';')[0];
      const dump = {
        receivedAt, method: 'POST', path: '/hook',
        headers: contentType && ['application/json', 'text/plain', 'application/octet-stream'].includes(contentType) ? { 'content-type': contentType } : {},
        body
      };
      let ingest: ReturnType<typeof mapPayload> | undefined;
      let retained = false;
      try {
        const envelope = await encryptDump(sql, ctx.env, ownerId, dumpKey, dump);
        const storedDump = await ctx.env.HOOK_DUMPS.put(dumpKey, JSON.stringify(envelope), {
          httpMetadata: { contentType: 'application/json' }, customMetadata: { encrypted: '1', ownerId }
        });
        if (!storedDump) throw new Error('dump-write-failed');
        retained = true;
        ingest = mapPayload(body, dumpKey, ownerId);
        const stored = await storeEncryptedSamples(sql, ctx.env, ownerId, ingest.samples);
        const counters = { format: ingest.format, received: ingest.received, mapped: ingest.mapped, dropped: ingest.dropped,
          droppedBy: ingest.dropped ? { unsupported: ingest.dropped } : {} };
        console.info(JSON.stringify({ requestId: ctx.requestId, code: 'upload-accepted', received: counters.received, stored, dropped: counters.dropped }));
        return Response.json({ ok: true, dumpKey, stored, ingest: counters });
      } catch {
        console.error(JSON.stringify({ requestId: ctx.requestId, code: retained ? 'sample-storage-failed' : 'dump-storage-failed' }));
        return Response.json({ ok: false, ...(retained ? { dumpKey } : {}), error: retained ? 'timeseries-storage-failed' : 'encrypted-dump-storage-failed',
          ...(ingest ? { ingest: { format: ingest.format, received: ingest.received, mapped: ingest.mapped, dropped: ingest.dropped, droppedBy: {} } } : {}) }, { status: 502 });
      }
    }
  });

  app.all('/hook', c => {
    c.header('Allow', 'POST');
    return c.json({ error: { code: 'method-not-allowed', message: 'Only POST is accepted', requestId: c.get('requestId') } }, 405);
  });
  app.notFound(c => c.json({ error: { code: 'not-found', message: 'Not found', requestId: c.get('requestId') } }, 404));
  app.onError((error, c) => {
    let status = 503;
    let code = 'service-unavailable';
    let message = 'Service is temporarily unavailable';
    if (error instanceof AuthError || error instanceof RequestFailure) {
      status = error.status; code = error.code; message = error.message;
    } else if (error instanceof HTTPException && error.status === 400) { status = 400; code = 'invalid-request'; message = 'Invalid request body'; }
    else if (error instanceof InvalidSampleQuery) { status = 400; code = error.code; message = error.message; }
    else if (error instanceof CryptoFailure) { code = error.code; }
    if (status === 429) c.header('Retry-After', '60');
    c.header('Cache-Control', 'no-store');
    return c.json({ error: { code, message, requestId: c.get('requestId') } }, status as ContentfulStatusCode);
  });
  return app;
}

export default createApp();
