import type { CreditSnapshot } from '@burn-rate/api-schema/activity-credit';
import { Temporal } from '@js-temporal/polyfill';
import { canonicalizeTimeZone, completedLocalDates, localDayBounds } from './calendar';
import { Rational } from './decimal';
import type { CreditEvidence, NormalizedRingSummary, RingSummaryEvidence } from './types';

export const CREDIT_POLICY_VERSION = 'ring-consistency-v1' as const;

export interface CreditCalculation {
  credit: CreditSnapshot;
  exact: {
    creditLimitKcal: Rational;
    outstandingKcal: Rational;
    availableKcal: Rational;
    repaymentMultiplier: Rational;
  };
}

/** Pure calculation over one successfully read, authenticated account snapshot. */
export function calculateCredit(evidence: CreditEvidence, timeZone: string, now: Date | string): CreditCalculation {
  const zone = canonicalizeTimeZone(timeZone);
  const calculatedAt = Temporal.Instant.from(now instanceof Date ? now.toISOString() : now).toString();
  const days = new Set(completedLocalDates(calculatedAt, zone));
  const selected = new Map<string, RingSummaryEvidence>();
  for (const candidate of evidence.ringSummaries) {
    if (!candidate.localDate || !days.has(candidate.localDate)) continue;
    const previous = selected.get(candidate.localDate);
    // Authority precedes usability, including pause state, goals, and provenance.
    if (!previous || compareAuthority(candidate, previous) > 0) selected.set(candidate.localDate, candidate);
  }

  let total = Rational.from(0);
  let historyDays = 0;
  for (const summary of selected.values()) {
    const consistency = usableConsistency(summary, zone);
    if (consistency === null) continue;
    total = total.add(consistency);
    historyDays++;
  }

  const consistency = historyDays ? total.divide(historyDays) : null;
  const creditLimitKcal = consistency ? consistency.multiply(1750).add(250).floor(6) : Rational.from(250);
  const repaymentMultiplier = consistency ? Rational.from('1.5').subtract(consistency.multiply('0.45')).roundHalfUp(6) : Rational.from('1.5');
  let outstandingKcal = Rational.from(0);
  for (const loan of evidence.loans) {
    const principal = Rational.from(loan.principalKcal);
    if (principal.compare(0) <= 0 || typeof loan.fullyRepaid !== 'boolean') throw new RangeError('Invalid retained principal.');
    if (!loan.fullyRepaid) outstandingKcal = outstandingKcal.add(principal);
  }
  const availableKcal = creditLimitKcal.subtract(outstandingKcal);

  return {
    credit: {
      score: consistency ? consistency.multiply(550).add(300).roundHalfUp(0).toNumber() : null,
      creditLimitKcal: creditLimitKcal.toNumber(),
      outstandingKcal: outstandingKcal.toNumber(),
      availableKcal: availableKcal.toNumber(),
      repaymentMultiplier: repaymentMultiplier.toNumber(),
      historyDays,
      timeZone: zone,
      calculatedAt,
      policyVersion: CREDIT_POLICY_VERSION
    },
    exact: { creditLimitKcal, outstandingKcal, availableKcal, repaymentMultiplier }
  };
}

function sourceRank(identity: string | null): string {
  if (identity === 'com.apple.Fitness' || identity?.trim().replace(/\s+/g, ' ').toLowerCase() === 'apple fitness') return '';
  // Missing source cannot be used, but must not outrank a known source.
  return identity === null || !identity.trim() ? '\uffff' : identity;
}

function compareAuthority(left: RingSummaryEvidence, right: RingSummaryEvidence): number {
  const leftSource = sourceRank(left.sourceIdentity);
  const rightSource = sourceRank(right.sourceIdentity);
  if (leftSource !== rightSource) return leftSource < rightSource ? 1 : -1;
  const leftRevision = revision(left.revisionAt);
  const rightRevision = revision(right.revisionAt);
  // A recognizable correction without trustworthy provenance quarantines its day.
  if (leftRevision === null || rightRevision === null) {
    if (leftRevision !== rightRevision) return leftRevision === null ? 1 : -1;
  } else {
    const order = Temporal.Instant.compare(leftRevision, rightRevision);
    if (order) return order;
  }
  const leftDigest = left.revisionDigest ?? '';
  const rightDigest = right.revisionDigest ?? '';
  if (leftDigest !== rightDigest) return leftDigest > rightDigest ? 1 : -1;
  // Persisted evidence is already unique by revision tuple. A tie is the same revision.
  return 0;
}

function revision(value: string | null): Temporal.Instant | null {
  if (!value) return null;
  try { return Temporal.Instant.from(value); } catch { return null; }
}

function usableConsistency(summary: NormalizedRingSummary, timeZone: string): Rational | null {
  if (!summary.sourceIdentity?.trim() || !summary.sourceRecordId?.trim() || !summary.localDate || !summary.timeZone ||
      !summary.startsAt || !summary.endsAt || summary.paused !== false || !summary.moveMode || !revision(summary.revisionAt)) return null;
  try {
    if (canonicalizeTimeZone(summary.timeZone) !== timeZone) return null;
    const bounds = localDayBounds(summary.localDate, timeZone);
    if (Temporal.Instant.compare(summary.startsAt, bounds.startsAt) !== 0 || Temporal.Instant.compare(summary.endsAt, bounds.endsAt) !== 0) return null;
  } catch { return null; }

  const moveUnits = summary.moveMode === 'energy' ? ['kcal', 'kilocalorie', 'kilocalories'] : ['min', 'minute', 'minutes'];
  const move = ringCompletion(summary.move, moveUnits);
  const exercise = ringCompletion(summary.exercise, ['min', 'minute', 'minutes']);
  // `count` is the exporter unit for appleStandHours, not a generic event count.
  const stand = ringCompletion(summary.stand, ['count', 'h', 'hr', 'hour', 'hours']);
  if (move === null || exercise === null || stand === null) return null;
  return move.add(exercise).add(stand).divide(3);
}

function ringCompletion(ring: NormalizedRingSummary['move'], units: string[]): Rational | null {
  if (ring.actual === null || ring.goal === null || !Number.isFinite(ring.actual) || !Number.isFinite(ring.goal) ||
      ring.actual < 0 || ring.goal <= 0 || ring.unit === null || !units.includes(ring.unit.trim().toLowerCase())) return null;
  const fraction = Rational.from(ring.actual).divide(ring.goal);
  return fraction.compare(1) > 0 ? Rational.from(1) : fraction;
}
