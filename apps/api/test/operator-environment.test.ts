import { X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { operatorConnectionString } from '../scripts/environment';

const bundledCa = fileURLToPath(new NodeURL('../certs/timescale-ca.pem', import.meta.url));

describe('private operator database configuration', () => {
  it('bundles the reviewed Timescale CA certificate and exact fingerprint', () => {
    const certificate = new X509Certificate(readFileSync(bundledCa));
    expect(certificate.ca).toBe(true);
    expect(certificate.subject).toBe('O=Timescale Inc\nCN=ca.timescale.com');
    expect(certificate.issuer).toBe(certificate.subject);
    expect(certificate.fingerprint256).toBe('06:5A:75:0D:0D:64:F6:2D:AC:DC:97:9E:3B:83:D2:11:95:40:71:EA:59:B8:F3:40:7C:4E:87:CA:68:34:64:57');
  });
  it('accepts the API env connection alias while preserving caller precedence', () => {
    expect(new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: 'postgresql://test:dummy@localhost/example' })).hostname).toBe('localhost');
    expect(new NodeURL(operatorConnectionString({ DATABASE_URL: 'postgresql://test:dummy@preferred/example', DB_CONNECTION_STRING: 'postgresql://test:dummy@fallback/example' })).hostname).toBe('preferred');
  });
  it('uses a supplied trusted CA with full hostname verification', () => {
    const directory = mkdtempSync(join(tmpdir(), 'burn-rate-ca-config-'));
    try {
      const path = join(directory, 'ca.pem');
      writeFileSync(path, 'test certificate placeholder; no connection is attempted');
      const url = new NodeURL(operatorConnectionString({
        DB_CONNECTION_STRING: 'postgresql://test:dummy@localhost/example?sslmode=require&uselibpqcompat=true', DATABASE_CA_FILE: path
      }));
      expect(url.searchParams.get('sslrootcert')).toBe(path);
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      expect(url.searchParams.has('uselibpqcompat')).toBe(false);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('uses the pinned CA only for the exact Tiger domain and dot-bound subdomains', () => {
    for (const host of ['tsdb.cloud.timescale.com', 'service.tsdb.cloud.timescale.com', 'SERVICE.TSDB.CLOUD.TIMESCALE.COM.']) {
      const url = new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: `postgresql://test:dummy@${host}/example?sslmode=require&uselibpqcompat=true` }));
      expect(url.searchParams.get('sslrootcert')).toBe(bundledCa);
      expect(url.searchParams.get('sslmode')).toBe('verify-full');
      expect(url.searchParams.has('uselibpqcompat')).toBe(false);
    }
    for (const host of ['eviltsdb.cloud.timescale.com', 'service.tsdb.cloud.timescale.com.attacker.invalid', 'timescale.com', 'localhost']) {
      const url = new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: `postgresql://test:dummy@${host}/example` }));
      expect(url.searchParams.has('sslrootcert')).toBe(false);
    }
  });
  it('honors explicit CA environment and URL paths ahead of the bundled pin', () => {
    const directory = mkdtempSync(join(tmpdir(), 'burn-rate-ca-precedence-'));
    try {
      const override = join(directory, 'override.pem'), existing = join(directory, 'existing.pem');
      writeFileSync(override, 'test CA placeholder; no connection is attempted');
      writeFileSync(existing, 'test CA placeholder; no connection is attempted');
      const input = new NodeURL('postgresql://test:dummy@service.tsdb.cloud.timescale.com/example?sslmode=require&uselibpqcompat=true');
      input.searchParams.set('sslrootcert', existing);
      expect(new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: input.toString(), DATABASE_CA_FILE: override })).searchParams.get('sslrootcert')).toBe(override);
      expect(new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: input.toString(), PGSSLROOTCERT: override })).searchParams.get('sslrootcert')).toBe(override);
      const preserved = new NodeURL(operatorConnectionString({ DB_CONNECTION_STRING: input.toString() }));
      expect(preserved.searchParams.get('sslrootcert')).toBe(existing);
      expect(preserved.searchParams.get('sslmode')).toBe('verify-full');
      expect(preserved.searchParams.has('uselibpqcompat')).toBe(false);
      const missing = new NodeURL(input);
      missing.searchParams.set('sslrootcert', join(directory, 'missing.pem'));
      for (const env of [
        { DB_CONNECTION_STRING: input.toString(), DATABASE_CA_FILE: join(directory, 'missing.pem') },
        { DB_CONNECTION_STRING: input.toString(), PGSSLROOTCERT: join(directory, 'missing.pem') },
        { DB_CONNECTION_STRING: missing.toString() }
      ]) expect(() => operatorConnectionString(env)).toThrow('Database connection or CA configuration is invalid');
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it('reports invalid inputs without including the private connection value', () => {
    for (const env of [
      { DATABASE_URL: 'https://test:private-credential@localhost/example' },
      { DATABASE_URL: 'postgresql://test:private-credential@localhost/example', DATABASE_CA_FILE: '/nonexistent/burn-rate-ca.pem' }
    ]) {
      try { operatorConnectionString(env); throw new Error('should reject'); }
      catch (error) { expect((error as Error).message).toBe('Database connection or CA configuration is invalid'); }
    }
    expect(() => operatorConnectionString({})).toThrow('Set DATABASE_URL or DB_CONNECTION_STRING');
  });
});
