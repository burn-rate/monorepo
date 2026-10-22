import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { healthResponseSchema, timeseriesHealthResponseSchema } from '@burn-rate/api-schema';
import { createDb } from '@burn-rate/db';
import { createAuth, type AuthEnv } from './auth';
import { getSql } from './db';
import { mapPayload } from './ingest';
import { storeSamples } from './store';

export interface Env extends AuthEnv {
  HOOK_DUMPS: R2Bucket;
  TIMESERIES_DB: Hyperdrive;
}

function dashboardOrigin(env: Env): string {
  return env.DASHBOARD_URL ?? 'http://localhost:5173';
}

async function handleTimeseriesHealth(env: Env): Promise<Response> {
  const sql = await getSql(env);
  try {
    const { rows } = await sql.query('select version() as version');
    return Response.json(
      timeseriesHealthResponseSchema.parse({ status: 'ok', version: rows[0].version })
    );
  } finally {
    await sql.end().catch(() => {});
  }
}

async function handleHook(request: Request, env: Env, url: URL): Promise<Response> {
  const rawBody = await request.text();
  let body: unknown = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Not JSON — store the raw text as-is.
  }

  const receivedAt = new Date().toISOString();
  const dump = {
    receivedAt,
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers),
    body
  };

  const key = `hook/${receivedAt}-${crypto.randomUUID()}.json`;
  await env.HOOK_DUMPS.put(key, JSON.stringify(dump, null, 2));

  // Keep log lines tiny (big bodies exceed log size limits) — payloads live in R2.
  console.log(`[hook] ${request.method} ${url.pathname} dumped to ${key} (${rawBody.length} byte body)`);

  // Ingest pipeline: detect format → select mapper → map/filter → store.
  // Raw payload is already safe in R2, so storage failures are reported but
  // nothing is lost.
  const ingest = mapPayload(body, key);

  if (ingest.format === 'unknown') {
    console.log(`[ingest] unrecognized payload shape; raw dump kept at ${key}`);
    return Response.json({ ok: true, dumpKey: key, ingest: { ...ingest, samples: undefined } });
  }

  let stored = 0;
  if (ingest.samples.length > 0) {
    const sql = await getSql(env);
    try {
      stored = await storeSamples(sql, ingest.samples);
    } catch (error) {
      console.error(`[ingest] storage failed for ${key}:`, error);
      return Response.json(
        { ok: false, dumpKey: key, error: 'timeseries-storage-failed', ingest: { ...ingest, samples: undefined } },
        { status: 502 }
      );
    } finally {
      await sql.end().catch(() => {});
    }
  }

  console.log(
    `[ingest] ${ingest.format}: received=${ingest.received} stored=${stored} dropped=${ingest.dropped}` +
      (ingest.dropped > 0 ? ` droppedBy=${JSON.stringify(ingest.droppedBy)}` : '')
  );

  return Response.json({ ok: true, dumpKey: key, stored, ingest: { ...ingest, samples: undefined } });
}

const app = new Hono<{ Bindings: Env }>();

// Cross-origin auth from the dashboard: explicit origin + credentials so the
// session cookie round-trips. Must match trustedOrigins in src/auth.ts.
app.use(
  '/api/auth/*',
  cors({
    origin: (origin, c) => (origin === dashboardOrigin(c.env) ? origin : undefined),
    credentials: true,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']
  })
);

app.get('/health', (c) =>
  c.json(healthResponseSchema.parse({ status: 'ok', service: 'burn-rate-api' }))
);

app.get('/timeseries/health', (c) => handleTimeseriesHealth(c.env));

app.post('/hook', (c) => handleHook(c.req.raw, c.env, new URL(c.req.url)));

// Better Auth (passkey-only). One short-lived db pool per request — Hyperdrive
// pools at the edge, and pg connects lazily so this stays cheap.
app.all('/api/auth/*', async (c) => {
  const { db, end } = createDb(c.env.TIMESERIES_DB.connectionString, { max: 1 });
  try {
    const auth = createAuth(db, c.env);
    return await auth.handler(c.req.raw);
  } finally {
    await end().catch(() => {});
  }
});

export default app;
