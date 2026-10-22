/**
 * Treat-loan request boundaries and the stub catalog shared by the API and
 * dashboard. The catalog moves to Postgres (seeded from data/treats.json)
 * once lending persistence lands; these types then become the API contract.
 */
import { z } from 'zod';
import type { Treat } from './activity-credit';

/**
 * Stub catalog. data/treats.json mirrors these entries for the future seed;
 * a test in apps/api keeps the two in sync.
 */
export const LOAN_TREATS = {
  donut: { id: 'donut', name: 'Donut', serving: '1 donut', caloriesKcal: 400, isEstimate: true },
  beer: { id: 'beer', name: 'Beer', serving: '1 pint', caloriesKcal: 200, isEstimate: true }
} as const satisfies Record<string, Treat>;

export type LoanTreatId = keyof typeof LOAN_TREATS;
export const LOAN_TREAT_IDS = Object.keys(LOAN_TREATS) as LoanTreatId[];

/** Every treat is requestable at exactly these term lengths. */
export const LOAN_TERM_OPTIONS = [
  { length: 1, unit: 'days' },
  { length: 1, unit: 'weeks' },
  { length: 1, unit: 'months' }
] as const;

export type LoanTermUnit = (typeof LOAN_TERM_OPTIONS)[number]['unit'];

export const loanTreatIdSchema = z.enum(['donut', 'beer']);
export const loanTermUnitSchema = z.enum(['days', 'weeks', 'months']);

export const loanRequestInputSchema = z.object({
  treatId: loanTreatIdSchema,
  termUnit: loanTermUnitSchema
});
export type LoanRequestInput = z.infer<typeof loanRequestInputSchema>;

export const loanTermSchema = z.object({
  length: z.number().int().positive(),
  unit: loanTermUnitSchema,
  timeZone: z.string(),
  startsAt: z.string(),
  dueAt: z.string()
});

export const loanRequirementSchema = z.object({
  metric: z.enum(['stand_hours']),
  target: z.number().positive()
});

export const loanRequestResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  requestedAt: z.string(),
  /** Requested, not yet approved: a credit decision is future work. */
  status: z.literal('requested'),
  treatId: loanTreatIdSchema,
  treat: z.object({
    id: loanTreatIdSchema,
    name: z.string(),
    serving: z.string(),
    caloriesKcal: z.number().positive(),
    isEstimate: z.boolean()
  }),
  principalKcal: z.number().positive(),
  term: loanTermSchema,
  requirement: loanRequirementSchema
});
export type LoanRequestResponse = z.infer<typeof loanRequestResponseSchema>;

/**
 * Read view for GET /loans: current and past loans with repayment progress.
 * Backend not implemented yet; the dashboard renders this contract as-is.
 */
export const loanViewSchema = z.object({
  id: z.string(),
  status: z.enum(['active', 'repaid', 'overdue']),
  principalKcal: z.number().nonnegative(),
  outstandingKcal: z.number().nonnegative(),
  repaymentMetric: z.enum(['move_kcal', 'move_minutes', 'exercise_minutes', 'stand_hours']),
  /** Repayment target = principal x multiplier, kcal-denominated. */
  repaymentMultiplier: z.number().positive(),
  repaymentTargetKcal: z.number().positive(),
  repaymentProgressKcal: z.number().nonnegative(),
  durationDays: z.number().int().positive(),
  timeZone: z.string(),
  startsAt: z.string(),
  dueAt: z.string(),
  policyVersion: z.string()
});
export type LoanView = z.infer<typeof loanViewSchema>;

export const loansViewResponseSchema = z.object({ loans: z.array(loanViewSchema) });
export type LoansViewResponse = z.infer<typeof loansViewResponseSchema>;
