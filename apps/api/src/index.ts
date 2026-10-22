import { healthResponseSchema } from '@burn-rate/api-schema';

export interface Env {
  DB: D1Database;
  TIMESERIES_DB_URL?: string;
  TIMESERIES_DB_TOKEN?: string;
}

async function handleHook(request: Request, url: URL): Promise<Response> {
  const rawBody = await request.text();
  let body: unknown = rawBody;
  try {
    body = JSON.parse(rawBody);
  } catch {
    // Not JSON — log the raw text as-is.
  }

  console.log('[hook] received webhook:', {
    method: request.method,
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers: Object.fromEntries(request.headers),
    body
  });

  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(
        healthResponseSchema.parse({ status: 'ok', service: 'burn-rate-api' })
      );
    }

    if (url.pathname === '/hook') {
      return handleHook(request, url);
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
