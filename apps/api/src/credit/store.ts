import { loanDecisionSchema, loanSchema, type Loan, type LoanDecision } from '@burn-rate/api-schema';
import { Temporal } from '@js-temporal/polyfill';
import { createUserKeyring, CryptoFailure, type CryptoConfig, type Envelope, type UserKeyring } from '../crypto';
import type { Sql } from '../db';
import { canonicalizeTimeZone, completedLocalDates } from './calendar';
import { Rational } from './decimal';
import { normalizedRingSummarySchema, type CreditEvidence, type NormalizedRingSummary } from './types';

interface SummaryRow {
  owner_id: string; id: string; day_digest: string; revision_at: string | null; revision_order: string | null;
  content_digest: string; envelope: Envelope;
}
export interface LoanRow {
  owner_id: string; id: string; created_at: Date | string; fully_repaid: boolean; envelope: Envelope;
}
export interface StoredLoan {
  loan: ReturnType<typeof loanSchema.parse>;
  principalKcal: string;
  repaymentTargetKcal: string;
}
export interface DecisionRow {
  owner_id: string; id: string; idempotency_digest: string; request_digest: string;
  http_status: 200 | 201; loan_id: string | null; created_at: Date | string; envelope: Envelope;
}
const iso = (value: Date | string): string => new Date(value).toISOString();
const summaryMetadata = (row: SummaryRow) => [row.day_digest, row.revision_at ?? '', row.revision_order ?? '', row.content_digest];
const loanMetadata = (row: LoanRow) => [iso(row.created_at), String(row.fully_repaid)];
const decisionMetadata = (row: DecisionRow) => [row.idempotency_digest, row.request_digest, String(row.http_status), row.loan_id ?? '', iso(row.created_at)];

function canonicalSummary(input: NormalizedRingSummary): NormalizedRingSummary {
  const summary = normalizedRingSummarySchema.parse(input);
  if (summary.timeZone !== null) {
    try { summary.timeZone = canonicalizeTimeZone(summary.timeZone); } catch { /* Retain unknown provenance encrypted. */ }
  }
  if (summary.revisionAt !== null) {
    try { summary.revisionAt = Temporal.Instant.from(summary.revisionAt).toString(); } catch { summary.revisionAt = null; }
  }
  return summary;
}

async function summaryIdentity(keys: UserKeyring, summary: NormalizedRingSummary) {
  const dayDigest = await keys.digest('ring-summary-day', [summary.localDate ?? '', summary.timeZone ?? '']);
  const id = await keys.digest('ring-summary-identity', [summary.sourceIdentity ?? '', summary.localDate ?? '', summary.timeZone ?? '']);
  const contentDigest = await keys.digest('ring-summary-content', [JSON.stringify(summary)]);
  return { dayDigest, id, contentDigest };
}

/** Each logical source/day stores one complete winning revision, never merged fields. */
export async function storeEncryptedRingSummaries(sql: Sql, config: CryptoConfig, ownerId: string, summaries: NormalizedRingSummary[]): Promise<number> {
  if (!summaries.length) return 0;
  const valid = summaries.map(canonicalSummary);
  const keys = await createUserKeyring(sql, config, ownerId);
  let stored = 0;
  for (const summary of valid) {
    const { dayDigest, id, contentDigest } = await summaryIdentity(keys, summary);
    const revisionOrder = summary.revisionAt === null ? null : Temporal.Instant.from(summary.revisionAt).epochNanoseconds.toString();
    const row: SummaryRow = { owner_id: ownerId, id, day_digest: dayDigest, revision_at: summary.revisionAt, revision_order: revisionOrder,
      content_digest: contentDigest, envelope: undefined as never };
    const envelope = await keys.encrypt({ ownerId, kind: 'ring-summary', id, metadata: summaryMetadata(row) }, summary);
    const result = await sql.query(`INSERT INTO activity_ring_summaries
      (owner_id,id,day_digest,revision_at,revision_order,content_digest,envelope) VALUES ($1,$2,$3,$4,$5::numeric,$6,$7::jsonb)
      ON CONFLICT (owner_id,id) DO UPDATE SET day_digest=EXCLUDED.day_digest,
        revision_at=EXCLUDED.revision_at,revision_order=EXCLUDED.revision_order,content_digest=EXCLUDED.content_digest,envelope=EXCLUDED.envelope,received_at=now()
      WHERE (activity_ring_summaries.revision_at IS NOT NULL AND EXCLUDED.revision_at IS NULL)
        OR (activity_ring_summaries.revision_at IS NOT NULL AND EXCLUDED.revision_order > activity_ring_summaries.revision_order)
        OR (activity_ring_summaries.revision_order IS NOT DISTINCT FROM EXCLUDED.revision_order
          AND EXCLUDED.content_digest COLLATE "C" > activity_ring_summaries.content_digest COLLATE "C")`,
    [ownerId, id, dayDigest, summary.revisionAt, revisionOrder, contentDigest, JSON.stringify(envelope)]);
    stored += result.rowCount ?? 0;
  }
  return stored;
}

/** Call only after BEGIN; all reservation writers must lock this row first. */
export async function lockCreditOwner(sql: Sql, ownerId: string): Promise<void> {
  await sql.query('INSERT INTO calorie_credit_owners (owner_id) VALUES ($1) ON CONFLICT DO NOTHING', [ownerId]);
  await sql.query('SELECT owner_id FROM calorie_credit_owners WHERE owner_id=$1 FOR UPDATE', [ownerId]);
}

/** Preloaded keys avoid key provisioning's own transaction inside a reservation. */
export async function readCreditEvidence(sql: Sql, keys: UserKeyring, ownerId: string, timeZone: string, now: Date | string): Promise<CreditEvidence> {
  const days = completedLocalDates(now, timeZone);
  const digests: string[] = [];
  for (const day of days) digests.push(await keys.digest('ring-summary-day', [day, timeZone]));
  // Both families share exactly one MVCC statement snapshot, including an empty history.
  const { rows } = await sql.query<{ summaries: SummaryRow[]; loans: LoanRow[] }>(`SELECT
    COALESCE((SELECT jsonb_agg(to_jsonb(s) || jsonb_build_object('revision_order',s.revision_order::text)) FROM activity_ring_summaries s
      WHERE s.owner_id=$1 AND s.day_digest=ANY($2::text[])), '[]'::jsonb) AS summaries,
    COALESCE((SELECT jsonb_agg(to_jsonb(l)) FROM calorie_loans l
      WHERE l.owner_id=$1 AND NOT l.fully_repaid), '[]'::jsonb) AS loans`, [ownerId, digests]);
  if (rows.length !== 1 || !Array.isArray(rows[0].summaries) || !Array.isArray(rows[0].loans)) throw new CryptoFailure();
  const evidence: CreditEvidence = { ringSummaries: [], loans: [] };
  for (const row of rows[0].summaries) {
    if (row.owner_id !== ownerId || !digests.includes(row.day_digest)) throw new CryptoFailure();
    try {
      const summary = canonicalSummary(await keys.decrypt<NormalizedRingSummary>({ ownerId, kind: 'ring-summary', id: row.id, metadata: summaryMetadata(row) }, row.envelope));
      const identity = await summaryIdentity(keys, summary);
      const revisionOrder = summary.revisionAt === null ? null : Temporal.Instant.from(summary.revisionAt).epochNanoseconds.toString();
      if (identity.id !== row.id || identity.dayDigest !== row.day_digest || identity.contentDigest !== row.content_digest || summary.revisionAt !== row.revision_at || revisionOrder !== row.revision_order) throw new CryptoFailure();
      evidence.ringSummaries.push({ ...summary, revisionDigest: row.content_digest });
    } catch { throw new CryptoFailure(); }
  }
  for (const row of rows[0].loans) {
    const loan = await decryptStoredLoan(keys, ownerId, row);
    evidence.loans.push({ principalKcal: loan.principalKcal, fullyRepaid: row.fully_repaid });
  }
  return evidence;
}

export async function decryptStoredLoan(keys: UserKeyring, ownerId: string, row: LoanRow): Promise<StoredLoan> {
  try {
    if (row.owner_id !== ownerId || typeof row.fully_repaid !== 'boolean') throw new CryptoFailure();
    const stored = await keys.decrypt<StoredLoan>({ ownerId, kind: 'loan', id: row.id, metadata: loanMetadata(row) }, row.envelope);
    const loan = loanSchema.parse(stored.loan);
    if (typeof stored.principalKcal !== 'string' || typeof stored.repaymentTargetKcal !== 'string') throw new CryptoFailure();
    const principal = Rational.from(stored.principalKcal);
    const target = Rational.from(stored.repaymentTargetKcal);
    if (principal.compare(0) <= 0 || target.compare(0) <= 0 || principal.toString() !== stored.principalKcal || target.toString() !== stored.repaymentTargetKcal ||
      principal.toNumber() !== loan.principalKcal || target.toNumber() !== loan.repaymentTargetKcal || loan.id !== row.id || loan.startsAt !== iso(row.created_at) ||
      target.compare(principal.multiply(Rational.from(loan.repaymentMultiplier))) !== 0 || (loan.status === 'repaid') !== row.fully_repaid) throw new CryptoFailure();
    return { loan, principalKcal: stored.principalKcal, repaymentTargetKcal: stored.repaymentTargetKcal };
  } catch { throw new CryptoFailure(); }
}

/** A history read does not infer progress, repayment, or overdue transitions. */
export async function listEncryptedLoans(sql: Sql, keys: UserKeyring, ownerId: string): Promise<Loan[]> {
  const { rows } = await sql.query<LoanRow>('SELECT * FROM calorie_loans WHERE owner_id=$1 ORDER BY created_at DESC,id DESC', [ownerId]);
  const loans: Loan[] = [];
  for (const row of rows) {
    const stored = await decryptStoredLoan(keys, ownerId, row);
    loans.push(loanSchema.parse({ ...stored.loan, outstandingKcal: row.fully_repaid ? 0 : Rational.from(stored.principalKcal).toNumber() }));
  }
  return loans;
}

export async function insertEncryptedLoan(sql: Sql, keys: UserKeyring, ownerId: string, stored: StoredLoan): Promise<void> {
  const row: LoanRow = { owner_id: ownerId, id: stored.loan.id, created_at: stored.loan.startsAt, fully_repaid: stored.loan.status === 'repaid', envelope: undefined as never };
  const envelope = await keys.encrypt({ ownerId, kind: 'loan', id: row.id, metadata: loanMetadata(row) }, stored);
  await sql.query('INSERT INTO calorie_loans (owner_id,id,created_at,fully_repaid,envelope) VALUES ($1,$2,$3,$4,$5::jsonb)',
    [ownerId, row.id, row.created_at, row.fully_repaid, JSON.stringify(envelope)]);
}

export async function readLoanDecision(sql: Sql, keys: UserKeyring, ownerId: string, idempotencyDigest: string): Promise<{ row: DecisionRow; body: LoanDecision } | null> {
  const { rows } = await sql.query<DecisionRow>('SELECT * FROM calorie_loan_decisions WHERE owner_id=$1 AND idempotency_digest=$2', [ownerId, idempotencyDigest]);
  if (!rows.length) return null;
  const row = rows[0];
  try {
    if (rows.length !== 1 || row.owner_id !== ownerId || row.idempotency_digest !== idempotencyDigest) throw new CryptoFailure();
    const body = loanDecisionSchema.parse(await keys.decrypt({ ownerId, kind: 'loan-decision', id: row.id, metadata: decisionMetadata(row) }, row.envelope));
    if ((body.outcome === 'approved') !== (row.http_status === 201) || (body.outcome === 'approved' ? body.loan.id : null) !== row.loan_id ||
      Temporal.Instant.compare(body.credit.calculatedAt, iso(row.created_at)) !== 0) throw new CryptoFailure();
    return { row, body };
  } catch { throw new CryptoFailure(); }
}

export async function insertLoanDecision(sql: Sql, keys: UserKeyring, row: Omit<DecisionRow, 'envelope'>, body: LoanDecision): Promise<void> {
  const envelope = await keys.encrypt({ ownerId: row.owner_id, kind: 'loan-decision', id: row.id, metadata: decisionMetadata(row as DecisionRow) }, loanDecisionSchema.parse(body));
  await sql.query(`INSERT INTO calorie_loan_decisions
    (owner_id,id,idempotency_digest,request_digest,http_status,loan_id,created_at,envelope) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
  [row.owner_id, row.id, row.idempotency_digest, row.request_digest, row.http_status, row.loan_id, row.created_at, JSON.stringify(envelope)]);
}
