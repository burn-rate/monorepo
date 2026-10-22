import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { base64url, type CryptoConfig } from '../src/crypto';
import { completedLocalDates, localDayBounds } from '../src/credit/calendar';
import type { NormalizedRingSummary } from '../src/credit/types';

export const creditConfig: CryptoConfig = { ENCRYPTION_ENVIRONMENT: 'credit-test', HEALTH_KEK_ID: 'test-kek',
  HEALTH_KEKS: JSON.stringify({ 'test-kek': base64url(new Uint8Array(32).fill(37)) }) };

export async function creditMigrations(): Promise<string[]> {
  const migrations: string[] = [];
  for (const name of ['000_metrics.sql', '002_encrypted.sql', '004_auth.sql', '006_activity_credit.sql']) {
    const sql = await readFile(new NodeURL(`../timescale/${name}`, import.meta.url), 'utf8');
    // Only Timescale-specific statements are omitted; these credit tables use
    // ordinary Postgres DDL, constraints, indexes and transaction semantics.
    migrations.push(sql.replace(/SELECT create_hypertable[\s\S]*?;/g, '')
      .replace(/ALTER TABLE encrypted_health_samples SET \([\s\S]*?\);/g, '')
      .replace(/CALL add_columnstore_policy[\s\S]*?;/g, ''));
  }
  return migrations;
}

export function ringSummary(overrides: Partial<NormalizedRingSummary> = {}): NormalizedRingSummary {
  const localDate = completedLocalDates(new Date(), 'UTC')[0];
  const bounds = localDayBounds(localDate, 'UTC');
  return { sourceIdentity: 'com.apple.Fitness', sourceRecordId: 'private-source-record', localDate, timeZone: 'UTC', ...bounds,
    revisionAt: new Date(`${localDate}T23:59:00Z`).toISOString(), moveMode: 'energy', paused: false,
    move: { actual: 100, goal: 200, unit: 'kcal' }, exercise: { actual: 15, goal: 30, unit: 'min' }, stand: { actual: 6, goal: 12, unit: 'hr' }, ...overrides };
}
