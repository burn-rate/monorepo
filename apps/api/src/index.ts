import { healthResponseSchema } from '@burn-rate/api-schema';

export interface Env {
  DB: D1Database;
  TIMESERIES_DB_URL?: string;
  TIMESERIES_DB_TOKEN?: string;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json(
        healthResponseSchema.parse({ status: 'ok', service: 'burn-rate-api' })
      );
    }

    return Response.json({ error: 'Not found' }, { status: 404 });
  }
} satisfies ExportedHandler<Env>;
