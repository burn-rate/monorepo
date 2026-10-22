/**
 * Draft, type-only boundaries for the activity-credit feature.
 * See docs/activity-credit-contract.md for invariants and unresolved decisions.
 * These types do not validate input or implement lending or repayment behavior.
 */
export type IsoTimestamp = string;

export type ActivityMetric =
  | 'move_kcal'
  | 'move_minutes'
  | 'exercise_minutes'
  | 'stand_hours';

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
  /** Unknown pause state must remain distinguishable from false. */
  isPaused?: boolean;
  receivedAt: IsoTimestamp;
}

export interface CreditSnapshot {
  userId: string;
  calculatedAt: IsoTimestamp;
  policyVersion: string;
  score: number;
  creditLimitKcal: number;
  outstandingKcal: number;
  availableKcal: number;
}

export interface Treat {
  id: string;
  name: string;
  serving: string;
  caloriesKcal: number;
  isEstimate: boolean;
  sourceUrl?: string;
}

export interface TreatCatalog {
  version: 1;
  treats: Treat[];
}

export interface LoanTerm {
  length: number;
  unit: 'days' | 'weeks' | 'months';
  timeZone: string;
  startsAt: IsoTimestamp;
  dueAt: IsoTimestamp;
}

export interface ActivityRequirement {
  metric: ActivityMetric;
  target: number;
}

export interface LoanRequest {
  id: string;
  userId: string;
  requestedAt: IsoTimestamp;
  treatId: string;
  term: LoanTerm;
  requirement: ActivityRequirement;
}

export type LoanDecision =
  | {
      requestId: string;
      decidedAt: IsoTimestamp;
      outcome: 'approved';
      loanId: string;
      creditSnapshot: CreditSnapshot;
    }
  | {
      requestId: string;
      decidedAt: IsoTimestamp;
      outcome: 'denied';
      reason: string;
      creditSnapshot: CreditSnapshot;
    };

export interface Loan {
  id: string;
  userId: string;
  requestId: string;
  approvedAt: IsoTimestamp;
  /** Immutable copy of the serving and calories agreed at approval. */
  treat: Treat;
  principalKcal: number;
  term: LoanTerm;
  requirement: ActivityRequirement;
  status: 'active' | 'repaid' | 'overdue';
  repaidAt?: IsoTimestamp;
}

export interface RepaymentAllocation {
  id: string;
  userId: string;
  loanId: string;
  /**
   * Canonical activity unit shared across overlapping ring metrics.
   * Defining these units from source observations is a future ingestion task.
   */
  activityUnitId: string;
  observationIds: string[];
  intervalStart: IsoTimestamp;
  intervalEnd: IsoTimestamp;
  metric: ActivityMetric;
  amount: number;
  allocatedAt: IsoTimestamp;
  policyVersion: string;
}
