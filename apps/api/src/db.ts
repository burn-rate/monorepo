import pg from 'pg';

export type Sql = pg.Client;

/**
 * Connect to TimescaleDB via the Hyperdrive binding. Hyperdrive terminates
 * TLS: in production the binding proxies to the origin, and in local dev
 * wrangler's Hyperdrive sim proxies using
 * WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_TIMESERIES_DB (.dev.vars).
 *
 * Pass the binding's connection string as-is and do not enable client-side
 * SSL — the proxy speaks TLS to the origin itself, and forcing SSL from pg
 * fails the SSLRequest handshake against the local proxy.
 */
export async function getSql(env: { TIMESERIES_DB: Pick<Hyperdrive, 'connectionString'> }): Promise<Sql> {
  const client = new pg.Client({
    connectionString: env.TIMESERIES_DB.connectionString,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 10_000
  });
  try {
    await client.connect();
    return client;
  } catch {
    await client.end().catch(() => {});
    throw new Error('Database connection unavailable');
  }
}
