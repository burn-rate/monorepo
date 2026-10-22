import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const apiDirectory = fileURLToPath(new NodeURL('..', import.meta.url));
const timescaleCa = resolve(apiDirectory, 'certs/timescale-ca.pem');

function isTimescaleHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return host === 'tsdb.cloud.timescale.com' || host.endsWith('.tsdb.cloud.timescale.com');
}

/** Operator-only dotenv loading. Existing process inputs take precedence. */
export function loadOperatorEnvironment(): void {
  const path = resolve(apiDirectory, '.env');
  if (!existsSync(path)) return;
  for (const [name, value] of Object.entries(parseEnv(readFileSync(path, 'utf8')))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

/** Keep direct operator connections verified; the Worker still uses Hyperdrive. */
export function operatorConnectionString(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL || env.DB_CONNECTION_STRING;
  if (!value) throw new Error('Set DATABASE_URL or DB_CONNECTION_STRING in the API .env or environment');
  try {
    const url = new NodeURL(value);
    if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') throw new Error();
    const explicitCa = env.DATABASE_CA_FILE || env.PGSSLROOTCERT;
    let path: string | undefined;
    if (explicitCa) path = resolve(apiDirectory, explicitCa);
    else if (url.searchParams.has('sslrootcert')) {
      const existingCa = url.searchParams.get('sslrootcert');
      if (!existingCa) throw new Error();
      // Preserve pg's cwd-relative semantics for an explicit URL file path.
      path = resolve(existingCa);
    } else if (isTimescaleHost(url.hostname)) path = timescaleCa;
    if (path) {
      if (!existsSync(path)) throw new Error();
      url.searchParams.set('sslrootcert', path);
      url.searchParams.set('sslmode', 'verify-full');
      url.searchParams.delete('uselibpqcompat');
    }
    return url.toString();
  } catch {
    throw new Error('Database connection or CA configuration is invalid');
  }
}
