import type { LoanPaymentCandidate } from './types';

/**
 * Choose which loan a quest payment should be made against.
 *
 * Policy per docs/activity-credit-contract.md: the unpaid eligible loan with
 * the earliest deadline wins. Ties go to the oldest approval, then the loan
 * ID for stable ordering.
 *
 * Stub scope: eligibility here is just "not repaid with a balance remaining".
 * Checking that the activity satisfies the loan's required metric and falls
 * inside its term is future work.
 *
 * Returns null when nothing owes: no candidates, or only repaid loans and
 * zero balances.
 */
export function chooseLoanForPayment(
  candidates: LoanPaymentCandidate[]
): LoanPaymentCandidate | null {
  return candidates.reduce<LoanPaymentCandidate | null>((best, candidate) => {
    if (!isEligible(candidate)) return best;
    if (best === null || repaysFirst(candidate, best)) return candidate;
    return best;
  }, null);
}

/** Repaid loans are settled; a zero balance has nothing to pay against. */
function isEligible(candidate: LoanPaymentCandidate): boolean {
  return candidate.loan.status !== 'repaid' && candidate.outstandingKcal > 0;
}

/** Earliest deadline, then oldest approval, then loan ID. */
function repaysFirst(a: LoanPaymentCandidate, b: LoanPaymentCandidate): boolean {
  if (a.loan.dueAt !== b.loan.dueAt) {
    return a.loan.dueAt < b.loan.dueAt;
  }
  if (a.loan.startsAt !== b.loan.startsAt) {
    return a.loan.startsAt < b.loan.startsAt;
  }
  return a.loan.id <= b.loan.id;
}
