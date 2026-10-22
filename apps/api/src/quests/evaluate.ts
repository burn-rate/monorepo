import { chooseLoanForPayment } from './choose-loan';
import type { QuestDefinition, QuestMetric, QuestOffer, QuestSample } from './types';

/**
 * Sum a metric's values across samples that overlap the rolling window
 * ending at `now`. Overlap, rather than containment, so a bucket that
 * straddles the window start still counts.
 */
export function sumMetricInWindow(
  samples: QuestSample[],
  metric: QuestMetric,
  now: Date,
  windowMinutes: number
): number {
  const windowStartMs = now.getTime() - windowMinutes * 60_000;
  let total = 0;
  for (const sample of samples) {
    if (sample.metric !== metric) continue;
    const overlaps =
      sample.intervalEnd.getTime() > windowStartMs && sample.intervalStart.getTime() < now.getTime();
    if (overlaps) total += sample.value;
  }
  return total;
}

/**
 * Whether a quest's trigger fires right now.
 *
 * A window with no data at all does not trigger: missing data is unknown, not
 * zero (mirroring the activity-credit contract), so a paused or syncless watch
 * does not nag. Partial coverage still evaluates against what arrived; how
 * much coverage to require is an open decision.
 */
export function shouldTriggerQuest(
  definition: QuestDefinition,
  samples: QuestSample[],
  now: Date
): boolean {
  const { trigger } = definition;
  const hasData = samples.some((sample) => sample.metric === trigger.metric);
  if (!hasData) return false;
  return (
    sumMetricInWindow(samples, trigger.metric, now, trigger.windowMinutes) <
    trigger.thresholdMinutes
  );
}

/**
 * Create a quest offer when the trigger fires, targeting whichever loan the
 * payment policy selects. Returns null when the trigger does not fire or
 * there is no eligible loan to pay against.
 */
export function createQuestOffer(
  definition: QuestDefinition,
  userId: string,
  samples: QuestSample[],
  now: Date,
  loanCandidates: Parameters<typeof chooseLoanForPayment>[0]
): QuestOffer | null {
  if (!shouldTriggerQuest(definition, samples, now)) return null;
  const target = chooseLoanForPayment(loanCandidates);
  if (target === null) return null;
  return {
    definitionId: definition.id,
    userId,
    offeredAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + definition.completion.windowMinutes * 60_000).toISOString(),
    rewardKcal: definition.rewardKcal,
    completion: definition.completion,
    targetLoanId: target.loan.id
  };
}
