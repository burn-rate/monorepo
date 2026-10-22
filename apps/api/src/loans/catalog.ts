import {
  LOAN_TERM_OPTIONS,
  LOAN_TREATS,
  type LoanRequestInput,
  type LoanRequestResponse,
  type LoanTermUnit
} from '@burn-rate/api-schema';

/** Catalog re-exports so app-internal consumers (and tests) have one import site. */
export { LOAN_TERM_OPTIONS, LOAN_TREATS };

/**
 * Builds the stubbed loan request returned by POST /loan/req: the agreed
 * treat and term echoed back with a computed due date and a placeholder
 * repayment requirement. No credit decision, persistence, or allocation.
 */
export function stubLoanRequest(input: LoanRequestInput, now = new Date()): LoanRequestResponse {
  const option = LOAN_TERM_OPTIONS.find((term) => term.unit === input.termUnit);
  if (!option) throw new Error(`Unknown term unit: ${input.termUnit}`);
  const treat = LOAN_TREATS[input.treatId];
  return {
    id: crypto.randomUUID(),
    // TODO: attribute to the session user once /loan/req joins the
    // authenticated /api surface; 'default' matches the single-user ingest.
    userId: 'default',
    requestedAt: now.toISOString(),
    status: 'requested',
    treatId: treat.id,
    treat,
    principalKcal: treat.caloriesKcal,
    term: {
      length: option.length,
      unit: option.unit,
      timeZone: STUB_TIME_ZONE,
      startsAt: now.toISOString(),
      dueAt: dueAt(input.termUnit, now)
    },
    requirement: {
      metric: 'stand_hours',
      // TODO: how treat size and history set the target is contract open
      // decision 2; a flat ring-goal-per-day keeps the stub honest.
      target: STAND_HOURS_PER_DAY * TERM_LENGTH_DAYS[input.termUnit]
    }
  };
}

const STUB_TIME_ZONE = 'America/Los_Angeles';
const STAND_HOURS_PER_DAY = 12;

/** Flat stub month; calendar-month and DST semantics are contract open decision 6. */
const TERM_LENGTH_DAYS = { days: 1, weeks: 7, months: 30 } as const;

function dueAt(unit: LoanTermUnit, now: Date): string {
  if (unit === 'months') {
    const due = new Date(now);
    due.setUTCMonth(due.getUTCMonth() + 1);
    return due.toISOString();
  }
  return new Date(now.getTime() + TERM_LENGTH_DAYS[unit] * 86_400_000).toISOString();
}
