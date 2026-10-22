import { getSql } from '../src/db';
import { withCiDatabaseConnection, CiDatabaseConfigurationError } from './ci-database';
import { applyMigrations, MigrationFailure } from './migrations';
import { assertNoPlaintextHealthData, DeploymentPreflightError } from './deployment-preflight';

await withCiDatabaseConnection(process.env, async connectionString => {
  const sql = await getSql({ TIMESERIES_DB: { connectionString } });
  try {
    await assertNoPlaintextHealthData(sql);
    const { applied, skipped } = await applyMigrations(sql);
    console.info(JSON.stringify({ status: 'database-migrations-complete', applied, alreadyApplied: skipped }));
  } finally {
    await sql.end().catch(() => {});
  }
}).catch(error => {
  const message = error instanceof CiDatabaseConfigurationError || error instanceof MigrationFailure || error instanceof DeploymentPreflightError
    ? error.message
    : 'Database migration failed. Check the private connection and trusted CA configuration; deployment has stopped.';
  // Never serialize driver/crypto exceptions, connection strings, or PEM values.
  console.error(message);
  process.exitCode = 1;
});
