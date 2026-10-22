import { z } from 'zod';

/** A real named IANA zone (including UTC); fixed-offset strings are not zones. */
export function canonicalCreditTimeZone(value: string): string {
  if (!value || /^[+-]/.test(value)) throw new RangeError('Invalid IANA time zone');
  return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
}

export const creditTimeZoneSchema = z.string().refine((value) => {
  try { canonicalCreditTimeZone(value); return true; } catch { return false; }
}, 'A valid IANA time zone is required.').describe('IANA time zone, such as America/Los_Angeles. Equivalent zone aliases are canonicalized by the server.');

export const getScoreQuerySchema = z.object({ timeZone: creditTimeZoneSchema }).strict();
export const createLoanInputSchema = z.object({
  amountKcal: z.number().finite().positive().describe('Positive finite calorie principal. No additional decimal-place restriction.'),
  durationDays: z.number().int().min(1).max(30),
  timeZone: creditTimeZoneSchema
}).strict();
export const loanHeadersSchema = z.object({
  'idempotency-key': z.string().min(1).refine((value) => value.trim().length > 0, 'A nonempty Idempotency-Key is required.')
    .describe('Reuse this key and the same validated body to retry the original decision. Use a new key for a new application.')
});

const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const policyVersion = z.literal('ring-consistency-v1');
const utcTimestamp = z.iso.datetime().describe('UTC ISO timestamp.');

/** Account identity comes only from the session and is never a public payload field. */
export const creditSnapshotSchema = z.object({
  score: z.number().int().min(300).max(850).nullable(),
  creditLimitKcal: finite.min(250).max(2000),
  outstandingKcal: nonnegative,
  availableKcal: finite.describe('Limit minus full unpaid principal; may be negative.'),
  repaymentMultiplier: finite.min(1.05).max(1.5),
  historyDays: z.number().int().min(0).max(7),
  timeZone: creditTimeZoneSchema,
  calculatedAt: utcTimestamp,
  policyVersion
});
export const loanSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['active', 'repaid', 'overdue']),
  principalKcal: finite.positive(),
  outstandingKcal: nonnegative.describe('Full principal until authoritative full repayment; partial progress releases none.'),
  repaymentMetric: z.literal('move_kcal'),
  repaymentMultiplier: finite.min(1.05).max(1.5),
  repaymentTargetKcal: nonnegative,
  repaymentProgressKcal: nonnegative,
  durationDays: z.number().int().min(1).max(30),
  timeZone: creditTimeZoneSchema,
  startsAt: utcTimestamp,
  dueAt: utcTimestamp,
  policyVersion
});
export const loansResponseSchema = z.object({ loans: z.array(loanSchema) });
export type LoansResponse = z.infer<typeof loansResponseSchema>;

export const loanDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('approved'), loan: loanSchema, credit: creditSnapshotSchema }),
  z.object({ outcome: z.literal('denied'), loan: z.null(), reason: z.literal('insufficient-credit'),
    message: z.string().min(1), credit: creditSnapshotSchema })
]);
export const approvedLoanDecisionSchema = loanDecisionSchema.options[0];
export const deniedLoanDecisionSchema = loanDecisionSchema.options[1];

export type GetScoreQuery = z.infer<typeof getScoreQuerySchema>;
export type CreateLoanInput = z.infer<typeof createLoanInputSchema>;
/** Compatibility name for the public application body; the server owns all terms. */
export type LoanRequest = CreateLoanInput;
export type CreditSnapshot = z.infer<typeof creditSnapshotSchema>;
export type Loan = z.infer<typeof loanSchema>;
export type LoanDecision = z.infer<typeof loanDecisionSchema>;

/** Future ingestion/catalog/allocation boundaries, not additional loan API fields. */
export type IsoTimestamp = string;
export type ActivityMetric = 'move_kcal' | 'move_minutes' | 'exercise_minutes' | 'stand_hours';
export interface ActivityObservation {
  id: string;
  userId: string;
  metric: ActivityMetric;
  intervalStart: IsoTimestamp;
  intervalEnd: IsoTimestamp;
  /** Amount within this interval, rather than a running cumulative total. */
  value: number;
  resolution: 'source_interval' | 'hour' | 'day';
  source: string;
  sourceRecordId: string;
  receivedAt: IsoTimestamp;
}
export interface RingGoalSnapshot {
  userId: string;
  /** Local calendar date, YYYY-MM-DD. */
  localDate: string;
  timeZone: string;
  move: { metric: 'move_kcal' | 'move_minutes'; target: number };
  exerciseMinutes: number;
  standHours: number;
  isPaused?: boolean;
  receivedAt: IsoTimestamp;
}
export interface Treat {
  id: string;
  name: string;
  serving: string;
  caloriesKcal: number;
  isEstimate: boolean;
  sourceUrl?: string;
}
export interface TreatCatalog { version: 1; treats: Treat[] }
export interface RepaymentAllocation {
  id: string;
  userId: string;
  loanId: string;
  /** Future canonical activity unit shared across overlapping ring metrics. */
  activityUnitId: string;
  observationIds: string[];
  intervalStart: IsoTimestamp;
  intervalEnd: IsoTimestamp;
  metric: ActivityMetric;
  amount: number;
  allocatedAt: IsoTimestamp;
  policyVersion: string;
}
