import {
  loanRequestResponseSchema,
  loansViewResponseSchema,
  type LoanRequestInput,
  type LoanRequestResponse,
  type LoanTermUnit,
  type LoanTreatId,
  type LoanView
} from '@burn-rate/api-schema';

/**
 * GET /loans is not implemented server-side yet; until then this surfaces as
 * a "not available yet" state rather than an error.
 */
export class LoansUnavailableError extends Error {}

/** The history view covers current loans plus the trailing 90 days. */
export const LOANS_WINDOW_DAYS = 90;

/**
 * POST the loan request. The API base is injected so this stays testable
 * outside SvelteKit (vitest runs these helpers without the dev server).
 */
export async function requestLoan(
  input: LoanRequestInput,
  baseUrl: string
): Promise<LoanRequestResponse> {
  const response = await fetch(`${baseUrl}/loan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input)
  });
  if (!response.ok) throw new Error(`Loan request failed (${response.status})`);
  return loanRequestResponseSchema.parse(await response.json());
}

/** Fetch current and past loans. Throws LoansUnavailableError on 404/501. */
export async function fetchLoans(baseUrl: string): Promise<LoanView[]> {
  const response = await fetch(`${baseUrl}/loans`, { credentials: 'include' });
  if (response.status === 404 || response.status === 501) throw new LoansUnavailableError('Loan history is not implemented yet');
  if (!response.ok) throw new Error(`Loan history failed (${response.status})`);
  return loansViewResponseSchema.parse(await response.json()).loans;
}

/**
 * Keep active loans at any age plus settled loans whose term ended within
 * the rolling window. The backend is expected to filter the same way; this
 * keeps the view honest regardless.
 */
export function filterRecentLoans(
  loans: LoanView[],
  now: Date,
  days: number = LOANS_WINDOW_DAYS
): LoanView[] {
  const cutoffMs = now.getTime() - days * 86_400_000;
  return loans.filter(
    (loan) => loan.status === 'active' || new Date(loan.dueAt).getTime() >= cutoffMs
  );
}

/** Active loans first, soonest due; settled loans after, most recent first. */
export function sortLoansForView(loans: LoanView[]): LoanView[] {
  const active = loans
    .filter((loan) => loan.status === 'active')
    .sort((a, b) => a.dueAt.localeCompare(b.dueAt));
  const settled = loans
    .filter((loan) => loan.status !== 'active')
    .sort((a, b) => b.dueAt.localeCompare(a.dueAt));
  return [...active, ...settled];
}

export const METRIC_LABELS: Record<LoanView['repaymentMetric'], string> = {
  move_kcal: 'Move kcal',
  move_minutes: 'Move minutes',
  exercise_minutes: 'Exercise minutes',
  stand_hours: 'Stand hours'
};

/**
 * Presentation the shared catalog does not carry: art paths and copy.
 * Images live in static/loans/ (see the README there); the emoji shows
 * until the file is dropped in.
 */
export const TREAT_ART: Record<LoanTreatId, { emoji: string; image: string; blurb: string }> = {
  donut: { emoji: '🍩', image: '/loans/donut.png', blurb: 'Glazed motivation, served flat.' },
  beer: { emoji: '🍺', image: '/loans/beer.png', blurb: 'Best chased with a brisk walk.' }
};

export const TERM_LABELS: Record<LoanTermUnit, string> = {
  days: '1 day',
  weeks: '1 week',
  months: '1 month'
};
