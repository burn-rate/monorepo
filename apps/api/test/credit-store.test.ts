import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserKeyring, CryptoFailure, retainedKeyInventory, rotateDataKey } from '../src/crypto';
import type { Sql } from '../src/db';
import { createCreditLoan, getCreditScore, listCreditLoans } from '../src/credit/service';
import { decryptStoredLoan, insertEncryptedLoan, lockCreditOwner, readCreditEvidence, storeEncryptedRingSummaries, type LoanRow } from '../src/credit/store';
import { creditConfig as config, creditMigrations, ringSummary } from './credit-test-helpers';
import { mapPayload } from '../src/ingest';
import fixture from './fixtures/health-exporter-v1.json';

describe('encrypted credit persistence (single-connection PostgreSQL/PGlite)', () => {
  let db: PGlite;
  let sql: Sql;
  let statements: string[];
  let active = false;
  beforeAll(async () => {
    db = new PGlite();
    for (const migration of await creditMigrations()) await db.exec(migration);
    sql = { query: async (text: string, values?: unknown[]) => {
      if (active) throw new Error('Queries must not overlap on a transaction connection.');
      active = true;
      statements.push(text);
      try {
        if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 0 };
        return await db.query(text, values);
      } finally { active = false; }
    } } as unknown as Sql;
  }, 30_000);
  beforeEach(async () => {
    statements = [];
    await db.exec('TRUNCATE calorie_loan_decisions,calorie_loans,activity_ring_summaries,calorie_credit_owners,health_user_keys,"user" CASCADE');
    await db.exec(`INSERT INTO "user" (id,name,email) VALUES ('alice','Alice','alice@test.invalid'),('bob','Bob','bob@test.invalid')`);
  });
  afterAll(async () => { await db.close(); });

  it('migrates repeatedly and enforces owner/idempotency/loan ownership constraints without plaintext sensitive columns', async () => {
    for (const migration of await creditMigrations()) await db.exec(migration);
    await expect(sql.query("INSERT INTO calorie_credit_owners VALUES ('missing')")).rejects.toThrow('foreign key');
    await createCreditLoan(sql, config, 'alice', { amountKcal: 200, durationDays: 7, timeZone: 'UTC' }, 'key');
    const original = (await sql.query('SELECT * FROM calorie_loan_decisions')).rows[0];
    await expect(sql.query(`INSERT INTO calorie_loan_decisions (owner_id,id,idempotency_digest,request_digest,http_status,loan_id,created_at,envelope)
      SELECT owner_id,'other',idempotency_digest,request_digest,http_status,loan_id,created_at,envelope FROM calorie_loan_decisions`)).rejects.toThrow('unique');
    await sql.query("INSERT INTO calorie_credit_owners VALUES ('bob')");
    await expect(sql.query(`INSERT INTO calorie_loan_decisions (owner_id,id,idempotency_digest,request_digest,http_status,loan_id,created_at,envelope)
      VALUES ('bob','other','key','request',201,$1,now(),$2::jsonb)`, [original.loan_id, JSON.stringify(original.envelope)])).rejects.toThrow('foreign key');
    const columns = (await sql.query(`SELECT column_name FROM information_schema.columns WHERE table_name IN
      ('activity_ring_summaries','calorie_loans','calorie_loan_decisions')`)).rows.map(row => row.column_name);
    for (const sensitive of ['amount_kcal','principal_kcal','time_zone','local_date','source_identity','response','repayment_target_kcal']) expect(columns).not.toContain(sensitive);
  });

  it('keeps whole correction winners independent of receipt order, including paused/incomplete/null-provenance invalidations', async () => {
    const initial = ringSummary();
    const corrected = ringSummary({ revisionAt: new Date(Date.parse(initial.revisionAt!) + 1000).toISOString(), move: { actual: 200, goal: 200, unit: 'kcal' } });
    await storeEncryptedRingSummaries(sql, config, 'alice', [corrected, initial, initial]);
    const keys = await createUserKeyring(sql, config, 'alice');
    let evidence = await readCreditEvidence(sql, keys, 'alice', 'UTC', new Date());
    expect(evidence.ringSummaries).toHaveLength(1);
    expect(evidence.ringSummaries[0]).toMatchObject({ move: corrected.move, exercise: initial.exercise });
    const paused = { ...corrected, paused: true, revisionAt: new Date(Date.parse(corrected.revisionAt!) + 1000).toISOString() };
    await storeEncryptedRingSummaries(sql, config, 'alice', [paused, corrected]);
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ score: null, historyDays: 0 });
    const incomplete = { ...paused, paused: false, exercise: { ...paused.exercise, goal: null }, revisionAt: new Date(Date.parse(paused.revisionAt!) + 1000).toISOString() };
    await storeEncryptedRingSummaries(sql, config, 'alice', [incomplete, corrected]);
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ score: null, historyDays: 0 });
    await storeEncryptedRingSummaries(sql, config, 'alice', [{ ...incomplete, revisionAt: null }]);
    await storeEncryptedRingSummaries(sql, config, 'alice', [{ ...initial, revisionAt: new Date().toISOString() }]);
    evidence = await readCreditEvidence(sql, keys, 'alice', 'UTC', new Date());
    expect(evidence.ringSummaries[0].revisionAt).toBeNull();
    expect((await sql.query('SELECT * FROM activity_ring_summaries')).rows).toHaveLength(1);
  });

  it('converges equal-timestamp revisions by content HMAC and authenticates summary metadata', async () => {
    const first = ringSummary();
    const second = ringSummary({ move: { actual: 0, goal: 200, unit: 'kcal' }, sourceRecordId: 'corrected-record' });
    await storeEncryptedRingSummaries(sql, config, 'alice', [first, second]);
    const before = (await sql.query('SELECT id,content_digest,envelope FROM activity_ring_summaries')).rows[0];
    await storeEncryptedRingSummaries(sql, config, 'alice', [second, first]);
    const after = (await sql.query('SELECT id,content_digest,envelope FROM activity_ring_summaries')).rows[0];
    expect(after).toEqual(before);
    expect(JSON.stringify((await sql.query('SELECT * FROM activity_ring_summaries')).rows)).not.toContain('private-source-record');
    await sql.query("UPDATE activity_ring_summaries SET content_digest='tampered'");
    await expect(getCreditScore(sql, config, 'alice', 'UTC')).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('roundtrips the actual exporter fixture and orders sub-millisecond revisions exactly', async () => {
    const summaries = mapPayload(fixture, 'private-dump', 'payload-owner').ringSummaries;
    await storeEncryptedRingSummaries(sql, config, 'alice', summaries);
    const keys = await createUserKeyring(sql, config, 'alice');
    const evidence = await readCreditEvidence(sql, keys, 'alice', 'America/Los_Angeles', '2026-10-22T21:00:00Z');
    expect(evidence.ringSummaries).toHaveLength(1);
    expect(evidence.ringSummaries[0]).toMatchObject(summaries[0]);
    const newer = { ...summaries[0], revisionAt: '2026-10-22T18:08:50.000001Z', paused: true };
    await storeEncryptedRingSummaries(sql, config, 'alice', [newer, summaries[0]]);
    expect((await readCreditEvidence(sql, keys, 'alice', 'America/Los_Angeles', '2026-10-22T21:00:00Z')).ringSummaries[0])
      .toMatchObject({ revisionAt: newer.revisionAt, paused: true });
    const newest = { ...newer, revisionAt: '2026-10-22T18:08:50.000001001Z', paused: false };
    await storeEncryptedRingSummaries(sql, config, 'alice', [newest, newer]);
    expect((await readCreditEvidence(sql, keys, 'alice', 'America/Los_Angeles', '2026-10-22T21:00:00Z')).ringSummaries[0])
      .toMatchObject({ revisionAt: newest.revisionAt, paused: false });
  });

  it.each(['2026-10-22T21:00:00.000Z', '2026-10-22T21:00:00.700Z'])('replays original decisions at timestamp %s', async instant => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(instant));
    try {
      const request = { amountKcal: 100, durationDays: 1, timeZone: 'UTC' };
      const approved = await createCreditLoan(sql, config, 'alice', request, 'fixed-time');
      expect(await createCreditLoan(sql, config, 'alice', request, 'fixed-time')).toEqual(approved);
    } finally { vi.useRealTimers(); }
  });

  it('approves frozen 200/255 terms from 575 policy and replays approvals/denials without new accounting', async () => {
    await storeEncryptedRingSummaries(sql, config, 'alice', [ringSummary()]);
    const request = { amountKcal: 200, durationDays: 7, timeZone: 'UTC' };
    const result = await createCreditLoan(sql, config, 'alice', request, 'approve');
    expect(result).toMatchObject({ status: 201, body: { outcome: 'approved', loan: { principalKcal: 200, repaymentTargetKcal: 255, repaymentProgressKcal: 0 },
      credit: { score: 575, creditLimitKcal: 1125, availableKcal: 925, outstandingKcal: 200 } } });
    const denied = await createCreditLoan(sql, config, 'alice', { ...request, amountKcal: 1000 }, 'deny');
    expect(denied).toMatchObject({ status: 200, body: { outcome: 'denied', loan: null, credit: { availableKcal: 925 } } });
    await storeEncryptedRingSummaries(sql, config, 'alice', [ringSummary({ paused: true, revisionAt: new Date().toISOString() })]);
    expect(await createCreditLoan(sql, config, 'alice', request, 'approve')).toEqual(result);
    expect(await createCreditLoan(sql, config, 'alice', { amountKcal: 1000, timeZone: 'Etc/UTC', durationDays: 7 }, 'deny')).toEqual(denied);
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ score: null, outstandingKcal: 200, availableKcal: 50 });
    await expect(createCreditLoan(sql, config, 'alice', { ...request, durationDays: 8 }, 'approve')).rejects.toMatchObject({ status: 409 });
    expect((await sql.query('SELECT id FROM calorie_loans')).rows).toHaveLength(1);
    expect((await sql.query('SELECT id FROM calorie_loan_decisions')).rows).toHaveLength(2);
  });

  it('keeps exact fractional and tiny decimal principal/target encrypted and old keys decrypt every family', async () => {
    const input = { amountKcal: 0.1, durationDays: 1, timeZone: 'UTC' };
    const result = await createCreditLoan(sql, config, 'alice', input, 'decimal');
    expect(result.body).toMatchObject({ outcome: 'approved', loan: { principalKcal: 0.1, repaymentTargetKcal: 0.15 } });
    const keys = await createUserKeyring(sql, config, 'alice');
    const row = (await sql.query<LoanRow>('SELECT * FROM calorie_loans')).rows[0];
    expect(await decryptStoredLoan(keys, 'alice', row)).toMatchObject({ principalKcal: '0.1', repaymentTargetKcal: '0.15' });
    await storeEncryptedRingSummaries(sql, config, 'alice', [ringSummary()]);
    await rotateDataKey(sql, config, 'alice');
    expect((await retainedKeyInventory(sql)).filter(key => key.owner_id === 'alice' && key.state === 'retired'))
      .toEqual([expect.objectContaining({ live_ring_summaries: '1', live_loans: '1', live_loan_decisions: '1' })]);
    expect(await createCreditLoan(sql, config, 'alice', input, 'decimal')).toEqual(result);
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ score: 575, outstandingKcal: 0.1 });
    const tiny = await createCreditLoan(sql, config, 'alice', { ...input, amountKcal: Number.MIN_VALUE }, 'tiny');
    expect(tiny.body).toMatchObject({ outcome: 'approved', loan: { principalKcal: Number.MIN_VALUE } });
    const persisted = JSON.stringify((await sql.query('SELECT * FROM calorie_loans')).rows);
    expect(persisted).not.toContain('principalKcal');
    expect(persisted).not.toContain('repaymentMultiplier');
  });

  it('provisions outside reservation, locks before the one evidence read, and rolls back commit-path failures', async () => {
    const request = { amountKcal: 200, durationDays: 7, timeZone: 'UTC' };
    await createUserKeyring(sql, config, 'alice');
    const injected = { query: async (text: string, values?: unknown[]) => {
      if (text === 'COMMIT') throw new Error('commit-path-failure');
      return sql.query(text, values);
    } } as unknown as Sql;
    statements = [];
    await expect(createCreditLoan(injected, config, 'alice', request, 'retry')).rejects.toThrow('commit-path-failure');
    expect((await sql.query('SELECT * FROM calorie_loans')).rows).toEqual([]);
    expect((await sql.query('SELECT * FROM calorie_loan_decisions')).rows).toEqual([]);
    const begin = statements.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');
    const locked = statements.findIndex(text => text.includes('FOR UPDATE'));
    const evidence = statements.findIndex(text => text.includes('FROM activity_ring_summaries s'));
    expect(statements[0]).toContain('health_user_keys');
    expect(begin).toBeGreaterThan(0);
    expect(locked).toBeGreaterThan(begin);
    expect(evidence).toBeGreaterThan(locked);
    expect(statements.filter(text => /^BEGIN/.test(text))).toHaveLength(1);
    expect(statements).toContain('ROLLBACK');
    expect((await createCreditLoan(sql, config, 'alice', request, 'retry')).status).toBe(201);
  });

  it('finishes first-use key provisioning before opening the reservation transaction', async () => {
    statements = [];
    await createCreditLoan(sql, config, 'alice', { amountKcal: 1, durationDays: 1, timeZone: 'UTC' }, 'first-use');
    const reservationBegin = statements.indexOf('BEGIN ISOLATION LEVEL READ COMMITTED');
    expect(reservationBegin).toBeGreaterThan(statements.indexOf('COMMIT'));
    expect(statements.filter(text => /^BEGIN/.test(text))).toEqual(['BEGIN', 'BEGIN ISOLATION LEVEL READ COMMITTED']);
    expect(statements.slice(reservationBegin).some(text => text.includes('health_user_keys'))).toBe(false);
  });

  it('separates owners and fails closed for corrupt or schema-invalid encrypted evidence/replay', async () => {
    const request = { amountKcal: 200, durationDays: 1, timeZone: 'UTC' };
    const result = await createCreditLoan(sql, config, 'alice', request, 'same-key');
    expect((await createCreditLoan(sql, config, 'bob', request, 'same-key')).status).toBe(201);
    await expect(createCreditLoan(sql, config, 'alice', { ...request, amountKcal: 0 }, 'invalid')).rejects.toMatchObject({ status: 400 });
    const keys = await createUserKeyring(sql, config, 'alice');
    const row = (await sql.query('SELECT * FROM calorie_loan_decisions WHERE owner_id=$1', ['alice'])).rows[0];
    const envelope = await keys.encrypt({ ownerId: 'alice', kind: 'loan-decision', id: row.id,
      metadata: [row.idempotency_digest, row.request_digest, String(row.http_status), row.loan_id, new Date(row.created_at).toISOString()] }, { ...result.body, credit: { score: 'invalid' } });
    await sql.query('UPDATE calorie_loan_decisions SET envelope=$1::jsonb WHERE owner_id=$2', [JSON.stringify(envelope), 'alice']);
    await expect(createCreditLoan(sql, config, 'alice', request, 'same-key')).rejects.toBeInstanceOf(CryptoFailure);
    await sql.query(`UPDATE calorie_loans SET envelope=jsonb_set(envelope,'{ciphertext}','"invalid"') WHERE owner_id='bob'`);
    await expect(getCreditScore(sql, config, 'bob', 'UTC')).rejects.toBeInstanceOf(CryptoFailure);
  });

  it('retains full overdue/partial principal, excludes completed loans, and never repays by import or time', async () => {
    const approval = await createCreditLoan(sql, config, 'alice', { amountKcal: 200, durationDays: 1, timeZone: 'UTC' }, 'first');
    if (approval.body.outcome !== 'approved') throw new Error('Expected approval.');
    const keys = await createUserKeyring(sql, config, 'alice');
    const existing = approval.body.loan;
    await sql.query('BEGIN');
    await lockCreditOwner(sql, 'alice');
    await insertEncryptedLoan(sql, keys, 'alice', { principalKcal: '300', repaymentTargetKcal: '450', loan: { ...existing,
      id: 'authoritative-overdue-fixture', status: 'overdue', principalKcal: 300, outstandingKcal: 300,
      repaymentTargetKcal: 450, repaymentProgressKcal: 225, startsAt: '2020-01-01T00:00:00.000Z', dueAt: '2020-01-02T00:00:00.000Z' } });
    await insertEncryptedLoan(sql, keys, 'alice', { principalKcal: '100', repaymentTargetKcal: '150', loan: { ...existing,
      id: 'authoritative-repaid-fixture', status: 'repaid', principalKcal: 100, outstandingKcal: 0,
      repaymentTargetKcal: 150, repaymentProgressKcal: 150 } });
    await sql.query('COMMIT');
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ outstandingKcal: 500, availableKcal: -250 });
    await storeEncryptedRingSummaries(sql, config, 'alice', [ringSummary()]);
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ outstandingKcal: 500, availableKcal: 625 });
    expect(await getCreditScore(sql, config, 'alice', 'UTC')).toMatchObject({ outstandingKcal: 500 });
  });

  it('lists every owner loan newest first, retaining stored status/progress and full unpaid principal', async () => {
    expect(await listCreditLoans(sql, config, 'alice')).toEqual({ loans: [] });
    expect((await sql.query('SELECT id FROM calorie_loans')).rows).toEqual([]);
    const approval = await createCreditLoan(sql, config, 'alice', { amountKcal: 200, durationDays: 1, timeZone: 'UTC' }, 'original');
    const bob = await createCreditLoan(sql, config, 'bob', { amountKcal: 25, durationDays: 1, timeZone: 'UTC' }, 'original');
    if (approval.body.outcome !== 'approved' || bob.body.outcome !== 'approved') throw new Error('Expected approval.');
    const base = approval.body.loan;
    const keys = await createUserKeyring(sql, config, 'alice');
    await sql.query('BEGIN');
    await lockCreditOwner(sql, 'alice');
    for (const id of ['future-a', 'future-b']) {
      await insertEncryptedLoan(sql, keys, 'alice', { principalKcal: '200', repaymentTargetKcal: '300', loan: { ...base, id,
        startsAt: '2030-01-01T00:00:00.000Z', dueAt: '2030-01-02T00:00:00.000Z' } });
    }
    await insertEncryptedLoan(sql, keys, 'alice', { principalKcal: '200', repaymentTargetKcal: '300', loan: { ...base,
      id: 'expired-partial', status: 'active', outstandingKcal: 100, repaymentProgressKcal: 150,
      startsAt: '2020-01-01T00:00:00.000Z', dueAt: '2020-01-02T00:00:00.000Z' } });
    await insertEncryptedLoan(sql, keys, 'alice', { principalKcal: '200', repaymentTargetKcal: '300', loan: { ...base,
      id: 'completed', status: 'repaid', outstandingKcal: 0, repaymentProgressKcal: 300,
      startsAt: '2021-01-01T00:00:00.000Z', dueAt: '2021-01-02T00:00:00.000Z' } });
    await sql.query('COMMIT');
    const listed = await listCreditLoans(sql, config, 'alice');
    expect(listed.loans.map(loan => loan.id)).toEqual(['future-b', 'future-a', base.id, 'completed', 'expired-partial']);
    expect(listed.loans.find(loan => loan.id === 'expired-partial')).toMatchObject({ status: 'active', outstandingKcal: 200, repaymentProgressKcal: 150 });
    expect(listed.loans.find(loan => loan.id === 'completed')).toMatchObject({ status: 'repaid', outstandingKcal: 0, repaymentProgressKcal: 300 });
    expect(await listCreditLoans(sql, config, 'bob')).toEqual({ loans: [bob.body.loan] });
    expect(await listCreditLoans(sql, config, 'alice')).toEqual(listed);
  });

  it('fails the whole loan list on corrupt, foreign-owner or schema-invalid retained loan envelopes', async () => {
    const request = { amountKcal: 100, durationDays: 1, timeZone: 'UTC' };
    await createCreditLoan(sql, config, 'alice', request, 'first');
    await createCreditLoan(sql, config, 'alice', request, 'second');
    await createCreditLoan(sql, config, 'bob', request, 'first');
    const alice = (await sql.query<LoanRow>('SELECT * FROM calorie_loans WHERE owner_id=$1 ORDER BY created_at,id', ['alice'])).rows[0];
    const keys = await createUserKeyring(sql, config, 'alice');
    const stored = await decryptStoredLoan(keys, 'alice', alice);
    const invalid = await keys.encrypt({ ownerId: 'alice', kind: 'loan', id: alice.id,
      metadata: [new Date(alice.created_at).toISOString(), String(alice.fully_repaid)] }, { ...stored, principalKcal: 'invalid' });
    await sql.query('UPDATE calorie_loans SET envelope=$1::jsonb WHERE owner_id=$2 AND id=$3', [JSON.stringify(invalid), 'alice', alice.id]);
    await expect(listCreditLoans(sql, config, 'alice')).rejects.toBeInstanceOf(CryptoFailure);
    await sql.query('UPDATE calorie_loans SET envelope=$1::jsonb WHERE owner_id=$2', [JSON.stringify(alice.envelope), 'bob']);
    await expect(listCreditLoans(sql, config, 'bob')).rejects.toBeInstanceOf(CryptoFailure);
    await sql.query(`UPDATE calorie_loans SET envelope=jsonb_set(envelope,'{ciphertext}','"invalid"') WHERE owner_id='alice'`);
    await expect(listCreditLoans(sql, config, 'alice')).rejects.toBeInstanceOf(CryptoFailure);
  });
});
