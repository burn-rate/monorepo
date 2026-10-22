import { Pool } from 'pg';

// One pool per connection string, reused across invocations on the same
// isolate. Hyperdrive terminates TLS and fronts the pooling in prod.
const pools = new Map<string, Pool>();

export function getTimeseriesPool(connectionString: string): Pool {
  let pool = pools.get(connectionString);
  if (!pool) {
    pool = new Pool({ connectionString, max: 5 });
    pools.set(connectionString, pool);
  }
  return pool;
}
