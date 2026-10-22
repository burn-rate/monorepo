import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { removePasskey, type AuthSession } from '../src/auth';

// Explicit opt-in only. No dev/prod configuration files are read. Run against a
// disposable PostgreSQL database whose test role can create/drop its own schema.
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('PostgreSQL independent-connection passkey locking', () => {
  it('serializes competing removals and leaves a usable credential', async () => {
    const schema = `auth_lock_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const clients = Array.from({ length: 3 }, () => new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, statement_timeout: 10_000 }));
    const [control, first, second] = clients;
    let locked = false;
    let operations: PromiseSettledResult<void>[] | undefined;
    let pending: Promise<PromiseSettledResult<void>[]> | undefined;
    try {
      await Promise.all(clients.map(client => client.connect()));
      await control.query(`CREATE SCHEMA "${schema}"`);
      await Promise.all(clients.map(client => client.query(`SET search_path TO "${schema}"`)));
      await control.query(await readFile(new NodeURL('../timescale/004_auth.sql', import.meta.url), 'utf8'));
      await control.query(`INSERT INTO "user" (id,name,email) VALUES ('owner','Test owner','test@accounts.invalid')`);
      await control.query(`INSERT INTO passkey (id,user_id,credential_id,public_key,counter,device_type,backed_up)
        VALUES ('first','owner','credential-first','public-first',0,'singleDevice',false),
               ('second','owner','credential-second','public-second',4294967295,'singleDevice',false)`);
      const counters = (await control.query<{ counter: number }>('SELECT counter FROM passkey ORDER BY id')).rows;
      expect(counters.map(row => typeof row.counter)).toEqual(['number', 'number']);
      expect(counters.map(row => row.counter)).toEqual([0, 4294967295]);
      const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const secondPid = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      const session: AuthSession = { user: { id: 'owner', name: 'Test owner' }, session: {
        id: 'test-session', createdAt: new Date(), expiresAt: new Date(Date.now() + 60_000), passkeyVerifiedAt: new Date()
      } };
      // Hold the owner row so both operations are provably contending before
      // releasing them. This fails if the implementation omits the owner lock.
      await control.query('BEGIN');
      await control.query(`SELECT id FROM "user" WHERE id='owner' FOR UPDATE`);
      locked = true;
      pending = Promise.allSettled([removePasskey(first, session, 'first'), removePasskey(second, session, 'second')]);
      let bothBlocked = false;
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const result = await control.query<{ blocked: string }>(
          "SELECT count(*)::text AS blocked FROM pg_stat_activity WHERE pid = ANY($1::int[]) AND wait_event_type='Lock'",
          [[firstPid, secondPid]]
        );
        if (Number(result.rows[0].blocked) === 2) { bothBlocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      await control.query('COMMIT');
      locked = false;
      operations = await pending;
      expect(bothBlocked).toBe(true);
      expect(operations.filter(operation => operation.status === 'fulfilled')).toHaveLength(1);
      const rejected = operations.find(operation => operation.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toMatchObject({ code: 'LAST_PASSKEY' });
      expect((await control.query('SELECT id FROM passkey WHERE user_id=$1', ['owner'])).rows).toHaveLength(1);
    } finally {
      if (locked) await control.query('ROLLBACK').catch(() => {});
      if (pending && !operations) await pending;
      // Drop only the unique schema this test created, never a shared schema.
      await control.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => {});
      await Promise.all(clients.map(client => client.end().catch(() => {})));
    }
  }, 30_000);
});
