import pg from 'pg';

export type Sql = pg.Client;

/**
 * Connect to TimescaleDB via the Hyperdrive binding. The binding routes to the
 * origin database in production; in local dev wrangler connects directly using
 * WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_TIMESERIES_DB (.dev.vars).
 *
 * One client per hook invocation — Hyperdrive pools at the edge, so the client
 * should be ended when the request finishes.
 */
export async function getSql(env: { TIMESERIES_DB: Hyperdrive }): Promise<Sql> {
  const client = new pg.Client({
    connectionString: env.TIMESERIES_DB.connectionString,
    statement_timeout: 10_000
  });
  await client.connect();
  return client;
}
