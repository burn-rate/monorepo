import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.js';

/**
 * Create a drizzle instance over node-postgres. Works in Node (dashboard SSR)
 * and in Workers via a Hyperdrive connection string (nodejs_compat).
 *
 * On Workers pass the Hyperdrive binding's connectionString and max: 1 —
 * Hyperdrive pools at the edge, and client-side SSL must stay off (the proxy
 * terminates TLS; see apps/api/src/db.ts).
 */
export function createDb(connectionString: string, options: { max?: number } = {}) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    statement_timeout: 10_000
  });
  const db = drizzle(pool, { schema });
  return {
    db,
    /** Close the underlying pool. Call on shutdown / test teardown. */
    end: () => pool.end()
  };
}

/** The drizzle instance type — what better-auth's drizzleAdapter consumes. */
export type Database = ReturnType<typeof createDb>['db'];
