import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { KNOWN_METRICS } from '@burn-rate/api-schema';
import { expect, it } from 'vitest';

it('initializes an empty database without plaintext health storage and repeats cleanly', async () => {
  const database = new PGlite();
  try {
    const names = ['000_metrics.sql', '002_encrypted.sql', '004_auth.sql', '005_limits.sql'];
    const migrations: string[] = [];
    for (const name of names) {
      const body = await readFile(new NodeURL(`../timescale/${name}`, import.meta.url), 'utf8');
      // PGlite runs the real PostgreSQL DDL. The separate Timescale staging
      // rehearsal validates extension installation, partitioning and policies.
      migrations.push(name === '002_encrypted.sql' ? body
        .replace(/SELECT create_hypertable[\s\S]*?;/g, '')
        .replace(/ALTER TABLE encrypted_health_samples SET \([\s\S]*?\);/g, '')
        .replace(/CALL add_columnstore_policy[\s\S]*?;/g, '') : body);
    }
    let firstTables: unknown[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      for (const body of migrations) await database.exec(body);
      const metricRows = await database.query('SELECT metric, display_name, category, unit FROM metrics ORDER BY metric');
      expect(metricRows.rows).toEqual(Object.entries(KNOWN_METRICS).map(([metric, definition]) => ({
        metric, display_name: definition.displayName, category: definition.category, unit: definition.unit
      })).sort((a, b) => a.metric.localeCompare(b.metric)));
      expect((await database.query("SELECT to_regclass('health_samples') AS samples, to_regclass('health_daily') AS daily")).rows[0])
        .toEqual({ samples: null, daily: null });
      const tables = (await database.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename")).rows;
      if (firstTables) expect(tables).toEqual(firstTables);
      else firstTables = tables;
      expect(tables).toEqual(expect.arrayContaining([
        { tablename: 'encrypted_health_samples' }, { tablename: 'health_user_keys' },
        { tablename: 'user' }, { tablename: 'session' }, { tablename: 'ingestion_tokens' }
      ]));
      expect((await database.query('SELECT count(*)::text AS count FROM encrypted_health_samples')).rows[0]).toEqual({ count: '0' });
      expect((await database.query('SELECT count(*)::text AS count FROM health_migration_state')).rows[0]).toEqual({ count: '1' });
    }
    const columns = (await database.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='encrypted_health_samples'")).rows.map(row => row.column_name);
    for (const protectedColumn of ['value', 'value_min', 'value_max', 'unit', 'source_name', 'device', 'ext_id', 'dump_key', 'attrs']) {
      expect(columns).not.toContain(protectedColumn);
    }
  } finally { await database.close(); }
}, 30_000);

it('upgrades the historical canonical auth schema without replacing existing accounts or credentials', async () => {
  const database = new PGlite();
  try {
    const historical = await readFile(new NodeURL('../../../packages/db/drizzle/0000_lean_kinsey_walden.sql', import.meta.url), 'utf8');
    const upgrade = await readFile(new NodeURL('../timescale/004_auth.sql', import.meta.url), 'utf8');
    await database.exec(historical);
    await database.exec(`INSERT INTO "user" (id,name,email) VALUES ('existing-owner','Existing owner','existing@example.invalid');
      INSERT INTO "passkey" (id,user_id,credential_id,public_key,counter,device_type,backed_up)
        VALUES ('existing-passkey','existing-owner','existing-credential','existing-public-key',2147483647,'singleDevice',false);
      INSERT INTO "session" (id,user_id,token,expires_at,updated_at)
        VALUES ('existing-session','existing-owner','existing-session-token',now()+interval '1 hour',now())`);
    for (let attempt = 0; attempt < 2; attempt++) await database.exec(upgrade);
    expect((await database.query('SELECT id,name,email FROM "user"')).rows)
      .toEqual([{ id: 'existing-owner', name: 'Existing owner', email: 'existing@example.invalid' }]);
    expect((await database.query('SELECT id,credential_id,public_key,counter FROM "passkey"')).rows)
      .toEqual([{ id: 'existing-passkey', credential_id: 'existing-credential', public_key: 'existing-public-key', counter: 2147483647 }]);
    expect((await database.query('SELECT id,passkey_verified_at FROM "session"')).rows)
      .toEqual([{ id: 'existing-session', passkey_verified_at: null }]);
    expect((await database.query(`SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='passkey' AND column_name='counter'`)).rows[0])
      .toEqual({ data_type: 'double precision' });
    await database.exec('UPDATE "passkey" SET counter=4294967295');
    expect((await database.query('SELECT counter FROM "passkey"')).rows[0]).toEqual({ counter: 4294967295 });
    for (const counter of [-1, 4294967296, 1.5]) {
      await expect(database.query('UPDATE "passkey" SET counter=$1', [counter])).rejects.toThrow('passkey_counter_uint32');
    }
    await expect(database.query(`INSERT INTO "passkey" (id,user_id,credential_id,public_key,counter,device_type,backed_up)
      VALUES ('duplicate','existing-owner','existing-credential','other-public-key',0,'singleDevice',false)`)).rejects.toThrow('passkey_credential_id_unique');
    await database.exec(`INSERT INTO auth_onboarding (context_hash,user_id,name,email,expires_at)
      VALUES ('new-context','not-yet-created-user','New user',NULL,now()+interval '5 minutes');
      INSERT INTO ingestion_tokens (id,user_id,name,token_hash) VALUES ('token','existing-owner','Exporter','hash')`);
    expect((await database.query('SELECT email FROM auth_onboarding')).rows).toEqual([{ email: null }]);
    await expect(database.query("INSERT INTO ingestion_tokens (id,user_id,name,token_hash) VALUES ('foreign','missing-user','Exporter','other-hash')"))
      .rejects.toThrow('foreign key constraint');
    const duplicates = await database.query(`SELECT tablename FROM pg_tables WHERE schemaname='public'
      AND tablename IN ('auth_users','auth_sessions','auth_accounts','auth_verifications','auth_passkeys')`);
    expect(duplicates.rows).toEqual([]);
  } finally { await database.close(); }
}, 30_000);

it('limits optional legacy updates to the target schema despite search-path fallthrough', async () => {
  const database = new PGlite();
  try {
    await database.exec(`CREATE TABLE public.health_samples (time TIMESTAMPTZ NOT NULL);
      CREATE SCHEMA migration_test;
      SET search_path TO migration_test, public`);
    const registry = await readFile(new NodeURL('../timescale/000_metrics.sql', import.meta.url), 'utf8');
    const encrypted = (await readFile(new NodeURL('../timescale/002_encrypted.sql', import.meta.url), 'utf8'))
      .replace(/SELECT create_hypertable[\s\S]*?;/g, '')
      .replace(/ALTER TABLE encrypted_health_samples SET \([\s\S]*?\);/g, '')
      .replace(/CALL add_columnstore_policy[\s\S]*?;/g, '');
    await database.exec(registry);
    await database.exec(encrypted);
    expect((await database.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='health_samples' AND column_name='legacy_migration_id'`)).rows).toEqual([]);
    expect((await database.query("SELECT to_regclass('migration_test.encrypted_health_samples') AS encrypted")).rows[0])
      .toEqual({ encrypted: 'encrypted_health_samples' });
    // When the intended schema does have legacy data, only that table changes;
    // the public table remains untouched even on a repeated migration.
    await database.exec('CREATE TABLE migration_test.health_samples (time TIMESTAMPTZ NOT NULL)');
    await database.exec(encrypted);
    expect((await database.query(`SELECT table_schema FROM information_schema.columns
      WHERE table_name='health_samples' AND column_name='legacy_migration_id' ORDER BY table_schema`)).rows)
      .toEqual([{ table_schema: 'migration_test' }]);
    expect((await database.query(`SELECT schemaname FROM pg_indexes WHERE indexname='health_samples_legacy_migration_id'`)).rows)
      .toEqual([{ schemaname: 'migration_test' }]);
  } finally { await database.close(); }
}, 30_000);
