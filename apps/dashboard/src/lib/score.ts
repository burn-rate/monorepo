import { creditSnapshotSchema, type CreditSnapshot } from '@burn-rate/api-schema';

/** Scale bounds a known credit score spans; matches the server's score schema. */
export const CREDIT_SCORE_MIN = 300;
export const CREDIT_SCORE_MAX = 850;

/** Placeholder rendered until GET /score ships or history exists; 737 sits two thirds of the way up the scale. */
export const STUB_CREDIT_SCORE = 737;

/** Contract-shaped placeholder snapshot behind the stub score. */
export function stubScoreSnapshot(timeZone: string, now = new Date()): CreditSnapshot {
  return {
    score: STUB_CREDIT_SCORE,
    creditLimitKcal: 1125,
    outstandingKcal: 0,
    availableKcal: 1125,
    repaymentMultiplier: 1.275,
    historyDays: 4,
    timeZone,
    calculatedAt: now.toISOString(),
    policyVersion: 'ring-consistency-v1'
  };
}

/**
 * Fetch the credit snapshot for the user's local calendar days. A missing or
 * unimplemented endpoint falls back to the stub snapshot instead of an error
 * state, so the dashboard renders before the backend ships.
 */
export async function fetchScore(
  baseUrl: string,
  timeZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone
): Promise<CreditSnapshot> {
  const response = await fetch(`${baseUrl}/score?timeZone=${encodeURIComponent(timeZone)}`, {
    credentials: 'include'
  });
  if (response.status === 404 || response.status === 501) return stubScoreSnapshot(timeZone);
  if (!response.ok) throw new Error(`Score request failed (${response.status})`);
  return creditSnapshotSchema.parse(await response.json());
}

/** Where the score falls on the credit scale, clamped to [0, 1] for the donut arc. */
export function scoreFraction(score: number): number {
  const fraction = (score - CREDIT_SCORE_MIN) / (CREDIT_SCORE_MAX - CREDIT_SCORE_MIN);
  return Math.min(1, Math.max(0, fraction));
}
