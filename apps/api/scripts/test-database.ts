import { spawnSync } from 'node:child_process';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { loadOperatorEnvironment, operatorConnectionString } from './environment';
import { getSql } from '../src/db';

async function run(): Promise<void> {
  loadOperatorEnvironment();
  const connectionString = operatorConnectionString();
  // Fail with a safe message before the test runner can serialize driver errors.
  const sql = await getSql({ TIMESERIES_DB: { connectionString } });
  try {
    const { rows: [info] } = await sql.query("SELECT current_setting('server_version') AS postgres, (SELECT extversion FROM pg_extension WHERE extname='timescaledb') AS timescale");
    if (!info.timescale) throw new Error('Timescale is required');
    console.info(JSON.stringify({ databaseVerification: 'isolated-temporary-schemas', ...info }));
  } finally { await sql.end().catch(() => {}); }
  const runner = fileURLToPath(new NodeURL('../node_modules/vitest/vitest.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [runner, 'run', '--pool=threads', 'test/auth-postgres.test.ts', 'test/timescale.test.ts'], {
    cwd: fileURLToPath(new NodeURL('..', import.meta.url)), stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: connectionString }
  });
  process.exitCode = result.status ?? 1;
}

await run().catch(() => {
  console.error('Database verification could not complete. Check the private connection and trusted CA settings. No credentials are included.');
  process.exitCode = 1;
});
