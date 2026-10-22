import { createLoanInputSchema, creditSnapshotSchema, loanDecisionSchema, type CreateLoanInput, type CreditSnapshot, type Loan, type LoanDecision } from '@burn-rate/api-schema';
import { createUserKeyring, type CryptoConfig } from '../crypto';
import type { Sql } from '../db';
import { RequestFailure } from '../limits';
import { addCalendarDays, canonicalizeTimeZone } from './calendar';
import { Rational } from './decimal';
import { calculateCredit } from './policy';
import { insertEncryptedLoan, insertLoanDecision, listEncryptedLoans, lockCreditOwner, readCreditEvidence, readLoanDecision } from './store';

export async function getCreditScore(sql: Sql, config: CryptoConfig, ownerId: string, timeZone: string): Promise<CreditSnapshot> {
  const zone = canonicalizeTimeZone(timeZone);
  const keys = await createUserKeyring(sql, config, ownerId);
  const now = new Date();
  const evidence = await readCreditEvidence(sql, keys, ownerId, zone, now);
  return creditSnapshotSchema.parse(calculateCredit(evidence, zone, now).credit);
}

export async function listCreditLoans(sql: Sql, config: CryptoConfig, ownerId: string): Promise<{ loans: Loan[] }> {
  const keys = await createUserKeyring(sql, config, ownerId);
  return { loans: await listEncryptedLoans(sql, keys, ownerId) };
}

/** Commit reservation and original response together before returning an approval. */
export async function createCreditLoan(sql: Sql, config: CryptoConfig, ownerId: string, input: CreateLoanInput, idempotencyKey: string): Promise<{ status: 200 | 201; body: LoanDecision }> {
  const parsed = createLoanInputSchema.safeParse(input);
  if (!parsed.success || !idempotencyKey.trim()) throw new RequestFailure(400, 'invalid-request', 'Invalid request parameters.');
  const normalized = { ...parsed.data, timeZone: canonicalizeTimeZone(parsed.data.timeZone) };
  const principal = Rational.from(normalized.amountKcal);
  // First-use provisioning can open its own transaction; always finish it first.
  const keys = await createUserKeyring(sql, config, ownerId);
  const idempotencyDigest = await keys.digest('loan-idempotency', [idempotencyKey]);
  const requestDigest = await keys.digest('loan-request', [principal.toString(), String(normalized.durationDays), normalized.timeZone]);
  await sql.query('BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await lockCreditOwner(sql, ownerId);
    const previous = await readLoanDecision(sql, keys, ownerId, idempotencyDigest);
    if (previous) {
      if (previous.row.request_digest !== requestDigest) throw new RequestFailure(409, 'idempotency-conflict', 'Idempotency key was already used for a different request.');
      await sql.query('COMMIT');
      return { status: previous.row.http_status, body: previous.body };
    }
    const now = new Date();
    const startsAt = now.toISOString();
    const evidence = await readCreditEvidence(sql, keys, ownerId, normalized.timeZone, now);
    const { credit, exact } = calculateCredit(evidence, normalized.timeZone, now);
    let body: LoanDecision;
    let status: 200 | 201;
    if (principal.compare(exact.availableKcal) > 0) {
      status = 200;
      body = { outcome: 'denied', loan: null, reason: 'insufficient-credit', message: 'The requested amount exceeds available credit.', credit };
    } else {
      status = 201;
      const target = principal.multiply(exact.repaymentMultiplier);
      const loan = { id: `loan_${crypto.randomUUID()}`, status: 'active' as const, principalKcal: principal.toNumber(), outstandingKcal: principal.toNumber(),
        repaymentMetric: 'move_kcal' as const, repaymentMultiplier: exact.repaymentMultiplier.toNumber(), repaymentTargetKcal: target.toNumber(), repaymentProgressKcal: 0,
        durationDays: normalized.durationDays, timeZone: normalized.timeZone, startsAt,
        dueAt: addCalendarDays(startsAt, normalized.durationDays, normalized.timeZone), policyVersion: 'ring-consistency-v1' as const };
      body = loanDecisionSchema.parse({ outcome: 'approved', loan, credit: { ...credit,
        outstandingKcal: exact.outstandingKcal.add(principal).toNumber(), availableKcal: exact.availableKcal.subtract(principal).toNumber() } });
      await insertEncryptedLoan(sql, keys, ownerId, { loan, principalKcal: principal.toString(), repaymentTargetKcal: target.toString() });
    }
    body = loanDecisionSchema.parse(body);
    await insertLoanDecision(sql, keys, { owner_id: ownerId, id: `decision_${crypto.randomUUID()}`, idempotency_digest: idempotencyDigest,
      request_digest: requestDigest, http_status: status, loan_id: body.outcome === 'approved' ? body.loan.id : null, created_at: startsAt }, body);
    await sql.query('COMMIT');
    return { status, body };
  } catch (error) {
    await sql.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
