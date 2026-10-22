import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { Sql } from '../src/db';
import { applyMigrations, DEFAULT_MIGRATIONS, MigrationFailure } from '../scripts/migrations';

let database: PGlite;
let sql: Sql;
let locks: string[];
let statements: string[];
const files: Record<string, string> = {
  '000_metrics.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY); INSERT INTO migration_probe VALUES (1)',
  '002_encrypted.sql': 'CREATE TABLE encrypted_probe (id INTEGER PRIMARY KEY)',
  '004_auth.sql': 'CREATE TABLE auth_probe (id INTEGER PRIMARY KEY)',
  '005_limits.sql': 'CREATE TABLE limits_probe (id INTEGER PRIMARY KEY)',
  '003_cutover.sql': 'CREATE TABLE cutover_probe (id INTEGER PRIMARY KEY)'
};
const loadMigration = async (name: string) => files[name];

beforeAll(async () => { database = new PGlite(); }, 30_000);
beforeEach(async () => {
  await database.exec('DROP TABLE IF EXISTS api_migrations, migration_probe, encrypted_probe, auth_probe, limits_probe, cutover_probe, rollback_probe');
  locks = [];
  statements = [];
  sql = { query: async (text: string, values?: unknown[]) => {
    statements.push(text);
    // PGlite lacks shared-process advisory locks. Only these calls are stubbed;
    // PostgreSQL executes all DDL, ledger SQL and transactions.
    if (text.includes('pg_advisory_unlock')) { locks.push('unlock'); return { rows: [{ unlocked: true }] }; }
    if (text.includes('pg_advisory_lock')) { locks.push('lock'); return { rows: [{}] }; }
    // Match pg's simple-query protocol for multi-statement migration bodies.
    if (!values && text.includes(';')) {
      const results = await database.exec(text);
      return results[results.length - 1];
    }
    return database.query(text, values);
  } } as unknown as Sql;
});
afterAll(async () => { await database?.close(); });

it('applies defaults once in order, records checksums, and excludes destructive cutover', async () => {
  expect(await applyMigrations(sql, { loadMigration })).toEqual({ applied: [...DEFAULT_MIGRATIONS], skipped: [] });
  expect((await database.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
  const ledger = (await database.query<{ name: string; checksum: string }>('SELECT name,checksum FROM api_migrations ORDER BY name')).rows;
  expect(ledger.map(row => row.name)).toEqual([...DEFAULT_MIGRATIONS]);
  expect(ledger.every(row => /^[a-f0-9]{64}$/.test(row.checksum))).toBe(true);
  expect((await database.query("SELECT to_regclass('cutover_probe') AS cutover")).rows[0]).toEqual({ cutover: null });
  // These fixtures have no IF NOT EXISTS: executing twice would fail.
  expect(await applyMigrations(sql, { loadMigration })).toEqual({ applied: [], skipped: [...DEFAULT_MIGRATIONS] });
  expect((await database.query('SELECT name,checksum FROM api_migrations ORDER BY name')).rows).toEqual(ledger);
  expect(locks).toEqual(['lock', 'unlock', 'lock', 'unlock']);
  expect(statements.slice(0, 3)).toEqual([
    'SET statement_timeout=0', "SET lock_timeout='30s'",
    "SELECT pg_advisory_lock(hashtextextended('burn-rate-migrations', 0))"
  ]);
});

it('rolls back failed DDL and its ledger entry, releases the lock, and resumes', async () => {
  const interrupted = async (name: string) => name === '002_encrypted.sql'
    ? 'CREATE TABLE rollback_probe (id INTEGER); INSERT INTO migration_probe VALUES (2); SELECT 1/0 /* private-health-and-credentials */'
    : loadMigration(name);
  const failure = await applyMigrations(sql, { loadMigration: interrupted }).catch(error => error);
  expect(failure).toBeInstanceOf(MigrationFailure);
  expect(failure).toMatchObject({ stage: 'apply', migration: '002_encrypted.sql' });
  expect(String(failure)).not.toContain('private-health');
  expect((await database.query('SELECT name FROM api_migrations')).rows).toEqual([{ name: '000_metrics.sql' }]);
  expect((await database.query('SELECT id FROM migration_probe')).rows).toEqual([{ id: 1 }]);
  expect((await database.query("SELECT to_regclass('rollback_probe') AS rollback")).rows[0]).toEqual({ rollback: null });
  expect(locks).toEqual(['lock', 'unlock']);
  expect(await applyMigrations(sql, { loadMigration })).toEqual({ applied: [...DEFAULT_MIGRATIONS].slice(1), skipped: ['000_metrics.sql'] });
  expect(locks).toEqual(['lock', 'unlock', 'lock', 'unlock']);
});

it('rejects an applied checksum change before any new DDL and releases the lock', async () => {
  await applyMigrations(sql, { loadMigration });
  await database.query("DELETE FROM api_migrations WHERE name='005_limits.sql'");
  await database.exec('DROP TABLE limits_probe');
  const changed = async (name: string) => `${files[name]}${name === '000_metrics.sql' ? '; -- changed private secret' : ''}`;
  await expect(applyMigrations(sql, { loadMigration: changed })).rejects.toMatchObject({ stage: 'checksum', migration: '000_metrics.sql' });
  expect((await database.query("SELECT to_regclass('limits_probe') AS pending")).rows[0]).toEqual({ pending: null });
  expect((await database.query('SELECT count(*)::text AS count FROM api_migrations')).rows[0]).toEqual({ count: '3' });
  expect(locks).toEqual(['lock', 'unlock', 'lock', 'unlock']);
});

it('fails safely before database mutations when a file is unavailable', async () => {
  const failure = await applyMigrations(sql, { loadMigration: async () => { throw new Error('postgres://private-secret@host/db'); } }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'load' });
  expect(String(failure)).not.toContain('private-secret');
  expect(locks).toEqual([]);
  expect((await database.query("SELECT to_regclass('api_migrations') AS ledger")).rows[0]).toEqual({ ledger: null });
});

it('fails deployment when advisory lock cleanup fails, without exposing the driver error', async () => {
  const badUnlock = { query: async (text: string, values?: unknown[]) => {
    if (text.includes('pg_advisory_unlock')) throw new Error('private driver connection URL');
    return sql.query(text, values);
  } } as unknown as Sql;
  const failure = await applyMigrations(badUnlock, { loadMigration }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'unlock' });
  expect(String(failure)).not.toContain('private driver');
  // Caller cleanup closes the connection and releases any remaining session lock.
  expect((await database.query('SELECT count(*)::text AS count FROM api_migrations')).rows[0]).toEqual({ count: '4' });
});

it('rolls back DDL when its ledger insert fails and releases the lock', async () => {
  const failedLedger = { query: async (text: string, values?: unknown[]) => {
    if (text.startsWith('INSERT INTO api_migrations')) throw new Error('private driver parameters');
    return sql.query(text, values);
  } } as unknown as Sql;
  await expect(applyMigrations(failedLedger, { loadMigration })).rejects.toMatchObject({ stage: 'apply', migration: '000_metrics.sql' });
  expect((await database.query("SELECT to_regclass('migration_probe') AS probe")).rows[0]).toEqual({ probe: null });
  expect((await database.query('SELECT count(*)::text AS count FROM api_migrations')).rows[0]).toEqual({ count: '0' });
  expect(locks).toEqual(['lock', 'unlock']);
});

it('fails safely on advisory lock timeout before creating the migration ledger', async () => {
  const blockedLock = { query: async (text: string, values?: unknown[]) => {
    if (text.includes('pg_advisory_lock')) throw new Error('private server lock diagnostics');
    return sql.query(text, values);
  } } as unknown as Sql;
  const failure = await applyMigrations(blockedLock, { loadMigration }).catch(error => error);
  expect(failure).toMatchObject({ stage: 'lock' });
  expect(String(failure)).not.toContain('private server');
  expect(statements).toContain("SET lock_timeout='30s'");
  expect((await database.query("SELECT to_regclass('api_migrations') AS ledger")).rows[0]).toEqual({ ledger: null });
  expect(locks).toEqual([]);
});

it('runs cutover only through the explicit operator option', async () => {
  expect(await applyMigrations(sql, { loadMigration, cutover: true })).toEqual({ applied: ['003_cutover.sql'], skipped: [] });
  expect((await database.query("SELECT to_regclass('cutover_probe') IS NOT NULL AS present")).rows[0]).toEqual({ present: true });
  expect(locks).toEqual(['lock', 'unlock']);
});
