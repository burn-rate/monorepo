import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createUserKeyring } from '../src/crypto';
import { createCreditLoan, getCreditScore } from '../src/credit/service';
import { creditConfig as config, creditMigrations } from './credit-test-helpers';

// Explicit disposable database opt-in, never a development/deployment .env.
describe.runIf(Boolean(process.env.TEST_DATABASE_URL))('credit reservations across independent PostgreSQL connections', () => {
  async function isolated(run: (control: pg.Client, first: pg.Client, second: pg.Client) => Promise<void>) {
    const schema = `credit_lock_test_${crypto.randomUUID().replaceAll('-', '')}`;
    const clients = Array.from({ length: 3 }, () => new pg.Client({ connectionString: process.env.TEST_DATABASE_URL, statement_timeout: 10_000 }));
    const [control, first, second] = clients;
    let created = false;
    try {
      await Promise.all(clients.map(client => client.connect()));
      await control.query(`CREATE SCHEMA "${schema}"`);
      created = true;
      await Promise.all(clients.map(client => client.query(`SET search_path TO "${schema}"`)));
      for (const migration of await creditMigrations()) await control.query(migration);
      await control.query(`INSERT INTO "user" (id,name,email) VALUES ('alice','Alice','alice@test.invalid'),('bob','Bob','bob@test.invalid');
        INSERT INTO calorie_credit_owners VALUES ('alice'),('bob')`);
      await createUserKeyring(first, config, 'alice');
      await createUserKeyring(second, config, 'bob');
      await run(control, first, second);
    } finally {
      await Promise.all(clients.map(client => client.query('ROLLBACK').catch(() => {})));
      if (created) await control.query(`DROP SCHEMA "${schema}" CASCADE`);
      await Promise.all(clients.map(client => client.end().catch(() => {})));
    }
  }

  async function contending<T>(control: pg.Client, first: pg.Client, second: pg.Client, operations: () => Promise<T>[]) {
    const pids = await Promise.all([first, second].map(async client => (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid));
    await control.query('BEGIN');
    await control.query("SELECT owner_id FROM calorie_credit_owners WHERE owner_id='alice' FOR UPDATE");
    const pending = Promise.allSettled(operations());
    let bothBlocked = false;
    try {
      const deadline = Date.now() + 3_000;
      while (Date.now() < deadline) {
        const result = await control.query<{ count: string }>("SELECT count(*)::text AS count FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND wait_event_type='Lock'", [pids]);
        if (Number(result.rows[0].count) === 2) { bothBlocked = true; break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    } finally { await control.query('COMMIT'); }
    const results = await pending;
    // A lock-free implementation cannot satisfy this observed contention check.
    expect(bothBlocked).toBe(true);
    return results;
  }

  it('serializes competing 200 kcal applications against 250, then observes fresh committed principal', async () => {
    await isolated(async (control, first, second) => {
      const request = { amountKcal: 200, durationDays: 7, timeZone: 'UTC' };
      const results = await contending(control, first, second, () => [
        createCreditLoan(first, config, 'alice', request, 'first'), createCreditLoan(second, config, 'alice', request, 'second')
      ]);
      expect(results.every(result => result.status === 'fulfilled')).toBe(true);
      const decisions = results.map(result => (result as PromiseFulfilledResult<Awaited<ReturnType<typeof createCreditLoan>>>).value);
      expect(decisions.map(decision => decision.status).sort()).toEqual([200, 201]);
      expect(decisions.find(decision => decision.status === 200)?.body).toMatchObject({ outcome: 'denied', reason: 'insufficient-credit', credit: { outstandingKcal: 200, availableKcal: 50 } });
      expect(await getCreditScore(control, config, 'alice', 'UTC')).toMatchObject({ outstandingKcal: 200, availableKcal: 50 });
      expect((await control.query('SELECT id FROM calorie_loans')).rows).toHaveLength(1);
      expect((await control.query('SELECT id FROM calorie_loan_decisions')).rows).toHaveLength(2);
    });
  }, 30_000);

  it('replays concurrent identical keys as one original decision and rejects changed concurrent payloads', async () => {
    await isolated(async (control, first, second) => {
      const request = { amountKcal: 100, durationDays: 7, timeZone: 'UTC' };
      const same = await contending(control, first, second, () => [
        createCreditLoan(first, config, 'alice', request, 'same'), createCreditLoan(second, config, 'alice', request, 'same')
      ]);
      expect(same[0].status).toBe('fulfilled');
      expect(same[1]).toEqual(same[0]);
      expect((await control.query('SELECT id FROM calorie_loans')).rows).toHaveLength(1);
      expect((await control.query('SELECT id FROM calorie_loan_decisions')).rows).toHaveLength(1);
      const changed = await contending(control, first, second, () => [
        createCreditLoan(first, config, 'alice', { ...request, amountKcal: 50 }, 'changed'),
        createCreditLoan(second, config, 'alice', { ...request, amountKcal: 75 }, 'changed')
      ]);
      expect(changed.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect((changed.find(result => result.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ status: 409, code: 'idempotency-conflict' });
      expect((await control.query('SELECT id FROM calorie_loans')).rows).toHaveLength(2);
      expect((await control.query('SELECT id FROM calorie_loan_decisions')).rows).toHaveLength(2);
      expect((await getCreditScore(control, config, 'alice', 'UTC')).outstandingKcal).toBeGreaterThanOrEqual(150);
      expect((await getCreditScore(control, config, 'alice', 'UTC')).outstandingKcal).toBeLessThanOrEqual(175);
    });
  }, 30_000);

  it('allows a separate owner to finish while the first owner is blocked and isolates shared key text', async () => {
    await isolated(async (control, first, second) => {
      const request = { amountKcal: 200, durationDays: 1, timeZone: 'UTC' };
      const firstPid = (await first.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      await control.query('BEGIN');
      await control.query("SELECT owner_id FROM calorie_credit_owners WHERE owner_id='alice' FOR UPDATE");
      const alice = createCreditLoan(first, config, 'alice', request, 'shared-key');
      let blocked = false;
      try {
        const deadline = Date.now() + 3_000;
        while (Date.now() < deadline) {
          blocked = (await control.query<{ blocked: boolean }>("SELECT wait_event_type='Lock' AS blocked FROM pg_stat_activity WHERE pid=$1", [firstPid])).rows[0]?.blocked;
          if (blocked) break;
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        expect(blocked).toBe(true);
        // This must complete before Alice's lock is released.
        const bob = await createCreditLoan(second, config, 'bob', request, 'shared-key');
        expect(bob.status).toBe(201);
      } finally { await control.query('COMMIT'); }
      expect((await alice).status).toBe(201);
      const counts = (await control.query('SELECT owner_id,count(*)::text AS count FROM calorie_loan_decisions GROUP BY owner_id ORDER BY owner_id')).rows;
      expect(counts).toEqual([{ owner_id: 'alice', count: '1' }, { owner_id: 'bob', count: '1' }]);
    });
  }, 30_000);

  it('rolls back loan and decision on a real deferred COMMIT failure, then safely retries', async () => {
    await isolated(async (control, first) => {
      // The exception is raised by PostgreSQL when COMMIT runs, after both
      // application inserts have succeeded, rather than by a driver mock.
      await control.query(`CREATE FUNCTION reject_credit_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'synthetic deferred constraint failure'; END $$;
        CREATE CONSTRAINT TRIGGER reject_credit_commit AFTER INSERT ON calorie_loan_decisions
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_credit_commit()`);
      const request = { amountKcal: 200, durationDays: 7, timeZone: 'UTC' };
      await expect(createCreditLoan(first, config, 'alice', request, 'retry')).rejects.toThrow();
      expect((await control.query('SELECT id FROM calorie_loans')).rows).toEqual([]);
      expect((await control.query('SELECT id FROM calorie_loan_decisions')).rows).toEqual([]);
      expect(await getCreditScore(control, config, 'alice', 'UTC')).toMatchObject({ outstandingKcal: 0, availableKcal: 250 });
      await control.query('DROP TRIGGER reject_credit_commit ON calorie_loan_decisions');
      const approved = await createCreditLoan(first, config, 'alice', request, 'retry');
      expect(approved.status).toBe(201);
      expect(await createCreditLoan(first, config, 'alice', request, 'retry')).toEqual(approved);
      expect((await control.query('SELECT id FROM calorie_loans')).rows).toHaveLength(1);
    });
  }, 30_000);
});
