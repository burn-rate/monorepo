export const knownCredit = {
  score: 575, creditLimitKcal: 1125, outstandingKcal: 0, availableKcal: 1125,
  repaymentMultiplier: 1.275, historyDays: 4, timeZone: 'America/Los_Angeles',
  calculatedAt: '2026-10-22T21:05:00Z', policyVersion: 'ring-consistency-v1' as const
};
export const unknownCredit = {
  ...knownCredit, score: null, creditLimitKcal: 250, availableKcal: 250,
  repaymentMultiplier: 1.5, historyDays: 0
};
export const approvedDecision = {
  outcome: 'approved' as const,
  loan: {
    id: 'loan_example_001', status: 'active' as const, principalKcal: 200, outstandingKcal: 200,
    repaymentMetric: 'move_kcal' as const, repaymentMultiplier: 1.275, repaymentTargetKcal: 255,
    repaymentProgressKcal: 0, durationDays: 7, timeZone: 'America/Los_Angeles',
    startsAt: '2026-10-22T21:05:00Z', dueAt: '2026-10-29T21:05:00Z', policyVersion: 'ring-consistency-v1' as const
  },
  credit: { ...knownCredit, outstandingKcal: 200, availableKcal: 925 }
};
export const deniedDecision = {
  outcome: 'denied' as const, loan: null, reason: 'insufficient-credit' as const,
  message: 'The requested calories exceed available credit.', credit: approvedDecision.credit
};

