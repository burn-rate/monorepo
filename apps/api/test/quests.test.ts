import { describe, expect, it } from 'vitest';
import type { Loan } from '@burn-rate/api-schema/activity-credit';
import { chooseLoanForPayment } from '../src/quests/choose-loan';
import {
  MOVE_FIVE_MINUTES_QUEST,
  QUEST_DEFINITIONS,
  STAND_UP_QUEST
} from '../src/quests/definitions';
import { createQuestOffer, shouldTriggerQuest, sumMetricInWindow } from '../src/quests/evaluate';
import type { LoanPaymentCandidate, QuestSample } from '../src/quests/types';

const NOW = new Date('2026-10-22T12:00:00.000Z');

function minutesAgo(minutes: number): Date {
  return new Date(NOW.getTime() - minutes * 60_000);
}

/** One-minute stand_time bucket ending `endedMinutesAgo` before NOW. */
function standSample(endedMinutesAgo: number, value = 1): QuestSample {
  return {
    metric: 'stand_time',
    intervalStart: minutesAgo(endedMinutesAgo + 1),
    intervalEnd: minutesAgo(endedMinutesAgo),
    value,
    sourceName: 'watch'
  };
}

function exerciseSample(endedMinutesAgo: number, value = 1): QuestSample {
  return { ...standSample(endedMinutesAgo, value), metric: 'exercise_time' };
}

const BASE_TERM = {
  length: 7,
  unit: 'days' as const,
  timeZone: 'America/Los_Angeles',
  startsAt: '2026-10-22T10:00:00.000Z',
  dueAt: '2026-10-29T10:00:00.000Z'
};

function makeLoan(overrides: Partial<Loan> = {}): Loan {
  return {
    id: 'loan-1',
    userId: 'default',
    requestId: 'req-1',
    approvedAt: '2026-10-22T10:00:00.000Z',
    treat: { id: 'donut', name: 'Donut', serving: '1 donut', caloriesKcal: 250, isEstimate: false },
    principalKcal: 250,
    term: BASE_TERM,
    requirement: { metric: 'stand_hours', target: 12 },
    status: 'active',
    ...overrides
  };
}

function candidate(
  id: string,
  opts: {
    dueAt?: string;
    approvedAt?: string;
    outstandingKcal?: number;
    status?: Loan['status'];
  } = {}
): LoanPaymentCandidate {
  return {
    loan: makeLoan({
      id,
      approvedAt: opts.approvedAt,
      status: opts.status,
      ...(opts.dueAt ? { term: { ...BASE_TERM, dueAt: opts.dueAt } } : {})
    }),
    outstandingKcal: opts.outstandingKcal ?? 100
  };
}

describe('chooseLoanForPayment', () => {
  it('picks the loan with the earliest deadline', () => {
    const candidates = [
      candidate('later', { dueAt: '2026-10-30T10:00:00.000Z', outstandingKcal: 400 }),
      candidate('sooner', { dueAt: '2026-10-25T10:00:00.000Z', outstandingKcal: 100 })
    ];
    expect(chooseLoanForPayment(candidates)?.loan.id).toBe('sooner');
  });

  it('breaks deadline ties by oldest approval', () => {
    const candidates = [
      candidate('newer', { approvedAt: '2026-10-22T12:00:00.000Z' }),
      candidate('older', { approvedAt: '2026-10-21T09:00:00.000Z' })
    ];
    expect(chooseLoanForPayment(candidates)?.loan.id).toBe('older');
  });

  it('breaks full ties by loan ID for stable ordering', () => {
    const candidates = [candidate('loan-b'), candidate('loan-a')];
    expect(chooseLoanForPayment(candidates)?.loan.id).toBe('loan-a');
  });

  it('ignores repaid loans and zero balances', () => {
    const candidates = [
      candidate('repaid', { status: 'repaid', outstandingKcal: 999 }),
      candidate('settled', { outstandingKcal: 0 })
    ];
    expect(chooseLoanForPayment(candidates)).toBeNull();
  });

  it('still considers overdue loans', () => {
    const candidates = [candidate('late', { status: 'overdue' })];
    expect(chooseLoanForPayment(candidates)?.loan.id).toBe('late');
  });

  it('returns null with no candidates', () => {
    expect(chooseLoanForPayment([])).toBeNull();
  });
});

describe('sumMetricInWindow', () => {
  it('sums only the requested metric inside the window', () => {
    const samples = [
      standSample(10),
      standSample(30, 2),
      standSample(90), // outside the 60-minute window
      exerciseSample(20)
    ];
    expect(sumMetricInWindow(samples, 'stand_time', NOW, 60)).toBe(3);
  });

  it('counts buckets that straddle the window start', () => {
    const straddler: QuestSample = {
      metric: 'stand_time',
      intervalStart: minutesAgo(65),
      intervalEnd: minutesAgo(55),
      value: 10,
      sourceName: 'watch'
    };
    expect(sumMetricInWindow([straddler], 'stand_time', NOW, 60)).toBe(10);
  });

  it('ignores buckets ending in the future', () => {
    const future: QuestSample = {
      metric: 'stand_time',
      intervalStart: new Date(NOW.getTime() + 60_000),
      intervalEnd: new Date(NOW.getTime() + 120_000),
      value: 10,
      sourceName: 'watch'
    };
    expect(sumMetricInWindow([future], 'stand_time', NOW, 60)).toBe(0);
  });
});

describe('shouldTriggerQuest', () => {
  it('fires the stand-up quest after 55+ minutes of sitting', () => {
    const samples = [standSample(10), standSample(20, 3)]; // 4 stood minutes in the hour
    expect(shouldTriggerQuest(STAND_UP_QUEST, samples, NOW)).toBe(true);
  });

  it('stays quiet when the user stood enough in the window', () => {
    const samples = [standSample(10), standSample(20), standSample(30), standSample(40), standSample(50)];
    expect(shouldTriggerQuest(STAND_UP_QUEST, samples, NOW)).toBe(false);
  });

  it('does not count stand time older than the window', () => {
    const samples = [standSample(70), standSample(80), standSample(90), standSample(100), standSample(110)];
    expect(shouldTriggerQuest(STAND_UP_QUEST, samples, NOW)).toBe(true);
  });

  it('fires the move quest under 5 active minutes in 2 hours', () => {
    expect(shouldTriggerQuest(MOVE_FIVE_MINUTES_QUEST, [exerciseSample(30, 4)], NOW)).toBe(true);
    expect(
      shouldTriggerQuest(
        MOVE_FIVE_MINUTES_QUEST,
        [exerciseSample(30), exerciseSample(60), exerciseSample(90), exerciseSample(100), exerciseSample(110)],
        NOW
      )
    ).toBe(false);
  });

  it('does not fire on an empty window', () => {
    expect(shouldTriggerQuest(STAND_UP_QUEST, [], NOW)).toBe(false);
  });
});

describe('createQuestOffer', () => {
  const candidates = [
    candidate('later', { dueAt: '2026-10-30T10:00:00.000Z', outstandingKcal: 400 }),
    candidate('sooner', { dueAt: '2026-10-25T10:00:00.000Z', outstandingKcal: 100 })
  ];

  it('targets the earliest-deadline loan and expires after the completion window', () => {
    const offer = createQuestOffer(STAND_UP_QUEST, 'default', [standSample(10)], NOW, candidates);
    expect(offer).toEqual({
      definitionId: 'stand-up',
      userId: 'default',
      offeredAt: NOW.toISOString(),
      expiresAt: minutesAgo(-30).toISOString(),
      rewardKcal: 25,
      completion: STAND_UP_QUEST.completion,
      targetLoanId: 'sooner'
    });
  });

  it('returns null when the trigger does not fire or no loan is eligible', () => {
    const stoodEnough = [standSample(10), standSample(20), standSample(30), standSample(40), standSample(50)];
    expect(createQuestOffer(STAND_UP_QUEST, 'default', stoodEnough, NOW, candidates)).toBeNull();
    expect(createQuestOffer(STAND_UP_QUEST, 'default', [standSample(10)], NOW, [])).toBeNull();
  });
});

describe('quest definitions', () => {
  it('has unique ids', () => {
    const ids = Object.keys(QUEST_DEFINITIONS);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the sit/stand rule: 55+ minutes sitting in the last 60', () => {
    expect(STAND_UP_QUEST.trigger).toEqual({ windowMinutes: 60, metric: 'stand_time', thresholdMinutes: 5 });
    expect(STAND_UP_QUEST.rewardKcal).toBe(25);
  });

  it('encodes the movement rule: under 5 active minutes in 2 hours, 5 due within 30', () => {
    expect(MOVE_FIVE_MINUTES_QUEST.trigger).toEqual({
      windowMinutes: 120,
      metric: 'exercise_time',
      thresholdMinutes: 5
    });
    expect(MOVE_FIVE_MINUTES_QUEST.completion).toEqual({
      metric: 'exercise_time',
      minutes: 5,
      windowMinutes: 30
    });
    expect(MOVE_FIVE_MINUTES_QUEST.rewardKcal).toBe(75);
  });
});
