import { getSql, type Sql } from '../src/db';
import { loadOperatorEnvironment, operatorConnectionString } from './environment';
import { applyMigrations } from './migrations';

async function run(): Promise<void> {
  let sql: Sql | undefined;
  try {
    // Include private configuration and connection failures in the safe boundary.
    loadOperatorEnvironment();
    sql = await getSql({ TIMESERIES_DB: { connectionString: operatorConnectionString() } });
    const result = await applyMigrations(sql, { cutover: process.argv.includes('--cutover') });
    for (const name of result.applied) console.info(`${name}: applied`);
    for (const name of result.skipped) console.info(`${name}: already applied`);
  } catch {
    console.error('Migration failed. No credentials or database error parameters are included.');
    process.exitCode = 1;
  } finally {
    await sql?.end().catch(() => {});
  }
}

await run();
