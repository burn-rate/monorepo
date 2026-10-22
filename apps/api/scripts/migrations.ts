import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import type { Sql } from '../src/db';

export const DEFAULT_MIGRATIONS = Object.freeze([
  '000_metrics.sql', '002_encrypted.sql', '004_auth.sql', '005_limits.sql'
] as const);

export interface MigrationOptions {
  /** Destructive legacy cutover is never part of deployment's default path. */
  cutover?: boolean;
  loadMigration?: (name: string) => Promise<string>;
}
export interface MigrationResult { applied: string[]; skipped: string[] }
type Stage = 'load' | 'configure' | 'lock' | 'ledger' | 'checksum' | 'apply' | 'unlock';

/** Safe to report without serializing a driver error, SQL, or connection URL. */
export class MigrationFailure extends Error {
  readonly code = 'MIGRATION_FAILED';
  constructor(readonly stage: Stage, readonly migration?: string) {
    super(`Database migration failed at ${stage}${migration ? ` (${migration})` : ''}.`);
  }
}

async function loadMigration(name: string): Promise<string> {
  return readFile(fileURLToPath(new NodeURL(`../timescale/${name}`, import.meta.url)), 'utf8');
}

/**
 * Direct PostgreSQL client only: the session advisory lock serializes deploys.
 * The caller owns connection setup/cleanup. A DDL file and its ledger entry are
 * committed together; completed files survive a later file's failure.
 */
export async function applyMigrations(sql: Sql, options: MigrationOptions = {}): Promise<MigrationResult> {
  const names: readonly string[] = options.cutover ? ['003_cutover.sql'] : DEFAULT_MIGRATIONS;
  let files: { name: string; body: string; checksum: string }[];
  try {
    files = await Promise.all(names.map(async name => {
      const body = await (options.loadMigration ?? loadMigration)(name);
      if (typeof body !== 'string' || !body.trim()) throw new MigrationFailure('load', name);
      return { name, body, checksum: createHash('sha256').update(body).digest('hex') };
    }));
  } catch { throw new MigrationFailure('load'); }

  const result: MigrationResult = { applied: [], skipped: [] };
  let stage: Stage = 'configure';
  let currentMigration: string | undefined;
  let locked = false;
  let failure: MigrationFailure | undefined;
  try {
    await sql.query('SET statement_timeout=0');
    await sql.query("SET lock_timeout='30s'");
    stage = 'lock';
    await sql.query("SELECT pg_advisory_lock(hashtextextended('burn-rate-migrations', 0))");
    locked = true;
    stage = 'ledger';
    await sql.query(`CREATE TABLE IF NOT EXISTS api_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    // Check all previously applied files before making any new schema changes.
    const applied = new Set<string>();
    for (const file of files) {
      currentMigration = file.name;
      stage = 'checksum';
      const { rows } = await sql.query<{ checksum: string }>('SELECT checksum FROM api_migrations WHERE name=$1', [file.name]);
      if (rows.length) {
        if (rows[0].checksum !== file.checksum) throw new MigrationFailure('checksum', file.name);
        applied.add(file.name);
      }
    }
    for (const file of files) {
      currentMigration = file.name;
      if (applied.has(file.name)) { result.skipped.push(file.name); continue; }
      stage = 'apply';
      await sql.query('BEGIN');
      try {
        await sql.query(file.body);
        await sql.query('INSERT INTO api_migrations (name,checksum) VALUES ($1,$2)', [file.name, file.checksum]);
        await sql.query('COMMIT');
        result.applied.push(file.name);
      } catch {
        await sql.query('ROLLBACK').catch(() => {});
        throw new MigrationFailure('apply', file.name);
      }
    }
  } catch (error) {
    failure = error instanceof MigrationFailure ? error : new MigrationFailure(stage, currentMigration);
  } finally {
    if (locked) {
      try {
        const { rows } = await sql.query<{ unlocked: boolean }>("SELECT pg_advisory_unlock(hashtextextended('burn-rate-migrations', 0)) AS unlocked");
        if (rows[0]?.unlocked !== true) throw new MigrationFailure('unlock');
      } catch { failure ??= new MigrationFailure('unlock'); }
    }
  }
  if (failure) throw failure;
  return result;
}
