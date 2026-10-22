/**
 * Draft boundaries for the quest system.
 *
 * Quests are short-horizon activity nudges: a trigger watches a rolling window
 * of activity data, and completing the quest pays points (kcal) against a
 * treat loan from the activity-credit feature. See
 * docs/activity-credit-contract.md for the loan invariants this feeds into.
 *
 * These types do not persist anything and do not validate input.
 */
import type { Loan } from '@burn-rate/api-schema/activity-credit';
import type { IsoTimestamp } from '@burn-rate/api-schema/activity-credit';
import type { KnownMetricName } from '@burn-rate/api-schema';

/**
 * Minute-bucketed activity metrics that can drive a quest trigger or
 * completion requirement. Stand quests use `stand_time` minute buckets, which
 * is genuine minute-grained data; the contract's caution about minute
 * timelines applies to `stand_hour` day-grain summaries, not this.
 */
export type QuestMetric = Extract<KnownMetricName, 'stand_time' | 'exercise_time' | 'move_time'>;

/** A single interval-bucketed activity reading, in the metric's canonical unit. */
export interface QuestSample {
  metric: QuestMetric;
  intervalStart: Date;
  intervalEnd: Date;
  /** Amount within this interval; minutes for the time-based quest metrics. */
  value: number;
  sourceName: string;
}

export interface QuestTrigger {
  /** Rolling lookback window over which the metric is summed. */
  windowMinutes: number;
  metric: QuestMetric;
  /** The quest fires when the window sum is below this many minutes. */
  thresholdMinutes: number;
}

export interface QuestCompletion {
  metric: QuestMetric;
  /** Minutes of `metric` required to complete the quest. */
  minutes: number;
  /** How long the user has to finish, starting when the quest is offered. */
  windowMinutes: number;
}

export interface QuestDefinition {
  id: string;
  title: string;
  description: string;
  trigger: QuestTrigger;
  completion: QuestCompletion;
  /** Points paid against the targeted loan on completion. Points are kcal for now. */
  rewardKcal: number;
}

/** A loan paired with the balance a payment should settle against. */
export interface LoanPaymentCandidate {
  loan: Loan;
  /**
   * Outstanding kcal remaining on the loan. Derived from the allocation
   * ledger; the Loan type itself deliberately does not carry a balance.
   */
  outstandingKcal: number;
}

export interface QuestOffer {
  definitionId: string;
  userId: string;
  offeredAt: IsoTimestamp;
  expiresAt: IsoTimestamp;
  rewardKcal: number;
  completion: QuestCompletion;
  /** Loan the reward pays against, chosen when the offer is created. */
  targetLoanId: string;
}
