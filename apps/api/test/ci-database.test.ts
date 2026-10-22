import { X509Certificate } from 'node:crypto';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rootCertificates } from 'node:tls';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { withCiDatabaseConnection } from '../scripts/ci-database';

const connection = 'postgresql://ci:dummy@database.example/api?sslmode=disable&uselibpqcompat=true';
const ca = rootCertificates.find(value => new X509Certificate(value).ca)!;
const bundledCa = fileURLToPath(new NodeURL('../certs/timescale-ca.pem', import.meta.url));

describe('deployment database configuration', () => {
  it('requires the explicit CI secret even when DATABASE_URL is present', async () => {
    const operation = vi.fn();
    await expect(withCiDatabaseConnection({ DATABASE_URL: connection }, operation))
      .rejects.toThrow('Set the GitHub Actions secret DB_CONNECTION_STRING');
    expect(operation).not.toHaveBeenCalled();
  });

  it('selects the CI connection and enforces verified TLS without a private CA', async () => {
    await withCiDatabaseConnection({
      DB_CONNECTION_STRING: connection,
      DATABASE_URL: 'postgresql://wrong:dummy@another.example/api'
    }, async value => {
      const url = new NodeURL(value);
      expect(url.hostname).toBe('database.example');
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      expect(url.searchParams.has('uselibpqcompat')).toBe(false);
      expect(url.searchParams.has('sslrootcert')).toBe(false);
    });
  });

  it('creates a private CA file and removes its directory after success', async () => {
    let path = '';
    const result = await withCiDatabaseConnection({ DB_CONNECTION_STRING: connection, DATABASE_CA_PEM: ca }, async value => {
      const url = new NodeURL(value);
      path = url.searchParams.get('sslrootcert')!;
      expect(path).toBeTruthy();
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await readFile(path, 'utf8')).trim()).toBe(ca.trim());
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      return 'completed';
    });
    expect(result).toBe('completed');
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('inherits the pinned Tiger CA while excluding lookalike domains', async () => {
    await withCiDatabaseConnection({ DB_CONNECTION_STRING: 'postgresql://ci:dummy@service.tsdb.cloud.timescale.com/api' }, async value => {
      const url = new NodeURL(value);
      expect(url.searchParams.get('sslrootcert')).toBe(bundledCa);
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
    });
    await withCiDatabaseConnection({ DB_CONNECTION_STRING: 'postgresql://ci:dummy@service.tsdb.cloud.timescale.com.attacker.invalid/api' }, async value => {
      expect(new NodeURL(value).searchParams.has('sslrootcert')).toBe(false);
    });
  });
  it('honors explicit CI PEM and URL CA paths over the Tiger default', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'burn-rate-ci-ca-precedence-'));
    const path = join(directory, 'explicit.pem');
    try {
      await writeFile(path, ca);
      const input = new NodeURL('postgresql://ci:dummy@service.tsdb.cloud.timescale.com/api');
      input.searchParams.set('sslrootcert', path);
      await withCiDatabaseConnection({ DB_CONNECTION_STRING: input.toString() }, async value => {
        expect(new NodeURL(value).searchParams.get('sslrootcert')).toBe(path);
      });
      await withCiDatabaseConnection({ DB_CONNECTION_STRING: input.toString(), DATABASE_CA_PEM: ca }, async value => {
        const selected = new NodeURL(value).searchParams.get('sslrootcert')!;
        expect(selected).not.toBe(path);
        expect(selected).not.toBe(bundledCa);
        expect((await readFile(selected, 'utf8')).trim()).toBe(ca.trim());
      });
      input.searchParams.set('sslrootcert', join(directory, 'missing.pem'));
      await expect(withCiDatabaseConnection({ DB_CONNECTION_STRING: input.toString() }, async () => undefined))
        .rejects.toThrow('Database connection or CA configuration is invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('removes the temporary CA after a migration failure', async () => {
    let path = '';
    await expect(withCiDatabaseConnection({ DB_CONNECTION_STRING: connection, DATABASE_CA_PEM: ca }, async value => {
      path = new NodeURL(value).searchParams.get('sslrootcert')!;
      await access(path);
      throw new Error('migration rejected');
    })).rejects.toThrow('migration rejected');
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects malformed CA input before connecting without logging secret contents', async () => {
    const operation = vi.fn();
    await expect(withCiDatabaseConnection({ DB_CONNECTION_STRING: connection, DATABASE_CA_PEM: 'private invalid content' }, operation))
      .rejects.toThrow('DATABASE_CA_PEM must contain a valid trusted CA certificate in PEM format.');
    expect(operation).not.toHaveBeenCalled();
  });
});
