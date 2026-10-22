import { healthResponseSchema, timeseriesHealthResponseSchema } from '@burn-rate/api-schema';
import { getTimeseriesPool } from './timeseries';

export interface Env {
  DB: D1Database;
  HOOK_DUMPS: R2Bucket;
  TIMESERIES_DB_URL?: string;
  TIMESERIES_DB_TOKEN?: string;
  HYPERDRIVE?: Hyperdrive;
}

async function handleTimeseriesHealth(env: Env): Promise<Response> {
  // Prod: Hyperdrive binding. Local dev: TIMESERIES_DB_URL from .dev.vars.
  const url = env.TIMESERIES_DB_URL ?? env.HYPERDRIVE?.connectionString;
  if (!url) {
    return Response.json({ status: 'unconfigured' }, { status: 503 });
  }

  try {
    const pool = getTimeseriesPool(url);
    const { rows } = await pool.query('select version() as version');
    return Response.json(
      timeseriesHealthResponseSchema.parse({ status: 'ok', version: rows[0].version })
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    console.log(`[timeseries] health check failed: ${message}`);
    return Response.json({ status: 'error', message }, { status: 503 });
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

  return Response.json({ ok: true, dumpKey: key, received: body });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(
        healthResponseSchema.parse({ status: 'ok', service: 'burn-rate-api' })
      );
    }

    if (request.method === 'GET' && url.pathname === '/timeseries/health') {
      return handleTimeseriesHealth(env);
    }

    if (url.pathname === '/hook') {
      return handleHook(request, env, url);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
