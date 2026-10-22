import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { URL as NodeURL } from 'node:url';
import { apiErrorSchema } from '@burn-rate/api-schema';
import {
  canonicalCreditTimeZone, createLoanInputSchema, creditSnapshotSchema, getScoreQuerySchema,
  loanDecisionSchema, loanHeadersSchema, loanSchema, loansResponseSchema
} from '@burn-rate/api-schema';

import { knownCredit, unknownCredit, approvedDecision, deniedDecision } from './fixtures/activity-credit';

describe('activity-credit public runtime schemas', () => {
  const valid = { amountKcal: 200, durationDays: 7, timeZone: 'America/Los_Angeles' };
  it('accepts raw finite positive calories without adding a decimal restriction', () => {
    for (const amountKcal of [200, 0.1, 0.123456789, Number.MIN_VALUE, Number.MAX_VALUE]) {
      expect(createLoanInputSchema.parse({ ...valid, amountKcal }).amountKcal).toBe(amountKcal);
    }
    expect(createLoanInputSchema.parse({ ...valid, durationDays: 1 }).durationDays).toBe(1);
    expect(createLoanInputSchema.parse({ ...valid, durationDays: 30 }).durationDays).toBe(30);
    expect(getScoreQuerySchema.parse({ timeZone: 'UTC' })).toEqual({ timeZone: 'UTC' });
    expect(canonicalCreditTimeZone('US/Pacific')).toBe(canonicalCreditTimeZone('America/Los_Angeles'));
  });
  it('rejects malformed parameters and client-selected owner or terms', () => {
    for (const invalid of [
      { ...valid, amountKcal: 0 }, { ...valid, amountKcal: -1 }, { ...valid, amountKcal: Infinity },
      { ...valid, amountKcal: NaN }, { ...valid, amountKcal: '200' }, { ...valid, amountKcal: undefined },
      { ...valid, durationDays: 0 }, { ...valid, durationDays: 31 }, { ...valid, durationDays: 1.5 },
      { ...valid, durationDays: '7' }, { ...valid, timeZone: undefined }, { ...valid, timeZone: 'not/a-zone' },
      { ...valid, timeZone: '+01:00' }, { ...valid, userId: 'another-owner' },
      { ...valid, repaymentMultiplier: 1 }, { ...valid, treatId: 'donut' }, { ...valid, score: 850 }
    ]) expect(createLoanInputSchema.safeParse(invalid).success, JSON.stringify(invalid)).toBe(false);
    expect(getScoreQuerySchema.safeParse({}).success).toBe(false);
    expect(getScoreQuerySchema.safeParse({ timeZone: 'UTC', userId: 'another-owner' }).success).toBe(false);
    expect(loanHeadersSchema.safeParse({}).success).toBe(false);
    expect(loanHeadersSchema.safeParse({ 'idempotency-key': '' }).success).toBe(false);
    expect(loanHeadersSchema.safeParse({ 'idempotency-key': '   ' }).success).toBe(false);
    expect(loanHeadersSchema.parse({ 'idempotency-key': 'application-1' })['idempotency-key']).toBe('application-1');
  });
  it('represents known/unknown scores, negative credit, flat loans, and both business outcomes', () => {
    expect(creditSnapshotSchema.parse(knownCredit)).toEqual(knownCredit);
    expect(creditSnapshotSchema.parse(unknownCredit).score).toBeNull();
    expect(creditSnapshotSchema.parse({ ...unknownCredit, outstandingKcal: 300, availableKcal: -50 }).availableKcal).toBe(-50);
    expect(loansResponseSchema.parse({ loans: [] })).toEqual({ loans: [] });
    expect(loansResponseSchema.parse({ loans: [approvedDecision.loan] })).toEqual({ loans: [approvedDecision.loan] });
    expect(loanDecisionSchema.parse(approvedDecision)).toEqual(approvedDecision);
    expect(loanDecisionSchema.parse(deniedDecision)).toEqual(deniedDecision);
    expect(loanDecisionSchema.safeParse({ ...deniedDecision, loan: approvedDecision.loan }).success).toBe(false);
    expect(loanDecisionSchema.safeParse({ ...approvedDecision, loan: null }).success).toBe(false);
    expect(loanSchema.safeParse({ ...approvedDecision.loan, repaymentMetric: 'stand_hours' }).success).toBe(false);
    expect(creditSnapshotSchema.safeParse({ ...knownCredit, calculatedAt: '2026-10-22T14:05:00-07:00' }).success).toBe(false);
    expect(creditSnapshotSchema.safeParse({ ...knownCredit, historyDays: 8 }).success).toBe(false);
    const publicCredit = creditSnapshotSchema.parse({ ...knownCredit, ownerId: 'secret', envelope: 'secret' });
    expect(publicCredit).not.toHaveProperty('ownerId');
    expect(publicCredit).not.toHaveProperty('envelope');
  });
  it('keeps every copyable JSON handoff example valid against its shared runtime schema', async () => {
    const contract = await readFile(new NodeURL('../../../docs/activity-credit-contract.md', import.meta.url), 'utf8');
    const examples = [...contract.matchAll(/```json\n([\s\S]*?)\n```/g)].map(match => JSON.parse(match[1]) as Record<string, unknown>);
    expect(examples).toHaveLength(8);
    for (const example of examples) {
      const schema = 'loans' in example ? loansResponseSchema : 'amountKcal' in example ? createLoanInputSchema : 'outcome' in example ? loanDecisionSchema : 'error' in example ? apiErrorSchema : creditSnapshotSchema;
      expect(schema.safeParse(example).success, JSON.stringify(example)).toBe(true);
    }
  });

});
