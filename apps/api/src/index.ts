import { healthResponseSchema, timeseriesHealthResponseSchema } from '@burn-rate/api-schema';
import { getSql } from './db';
import { mapPayload } from './ingest';
import { storeSamples } from './store';

export interface Env {
  DB: D1Database;
  HOOK_DUMPS: R2Bucket;
  TIMESERIES_DB: Hyperdrive;
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
