import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { URL as NodeURL } from 'node:url';
import { operatorConnectionString } from './environment';

export class CiDatabaseConfigurationError extends Error {}

/** Keep CI inputs out of argv/logs and remove the private trust file on failure too. */
export async function withCiDatabaseConnection<T>(
  env: NodeJS.ProcessEnv,
  operation: (connectionString: string) => Promise<T>
): Promise<T> {
  if (!env.DB_CONNECTION_STRING?.trim()) {
    throw new CiDatabaseConfigurationError('Set the GitHub Actions secret DB_CONNECTION_STRING before deployment.');
  }
  let directory: string | undefined;
  try {
    const pem = env.DATABASE_CA_PEM?.trim();
    let caFile: string | undefined;
    if (pem) {
      try {
        const certificates = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
        if (!certificates?.length || !certificates.some(value => new X509Certificate(value).ca)) throw new Error();
      } catch {
        throw new CiDatabaseConfigurationError('DATABASE_CA_PEM must contain a valid trusted CA certificate in PEM format.');
      }
      directory = await mkdtemp(join(env.RUNNER_TEMP || tmpdir(), 'burn-rate-migrations-'));
      caFile = join(directory, 'database-ca.pem');
      await writeFile(caFile, `${pem}\n`, { mode: 0o600 });
    }
    // Only the explicit CI connection is selected; an ambient DATABASE_URL or
    // developer .env file must not redirect a production migration.
    const connection = new NodeURL(operatorConnectionString({
      DB_CONNECTION_STRING: env.DB_CONNECTION_STRING,
      DATABASE_CA_FILE: caFile
    }));
    connection.searchParams.set('sslmode', 'verify-full');
    connection.searchParams.delete('uselibpqcompat');
    return await operation(connection.toString());
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
