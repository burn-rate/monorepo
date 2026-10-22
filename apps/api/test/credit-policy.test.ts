import { describe, expect, it } from 'vitest';
import { calculateCredit } from '../src/credit/policy';
import { localDayBounds } from '../src/credit/calendar';
import { normalizedRingSummarySchema, type CreditEvidence, type NormalizedRingSummary, type RingSummaryEvidence } from '../src/credit/types';

const zone = 'America/Los_Angeles';
const now = '2026-10-22T21:00:00Z';

function summary(actual = 50, date = '2026-10-21', overrides: Partial<RingSummaryEvidence> = {}): RingSummaryEvidence {
  return {
    sourceIdentity: 'com.apple.Fitness', sourceRecordId: `summary:${date}`, localDate: date, timeZone: zone,
    ...localDayBounds(date, zone), revisionAt: '2026-10-22T18:00:00Z', moveMode: 'energy', paused: false,
    move: { actual, goal: 100, unit: 'kcal' }, exercise: { actual, goal: 100, unit: 'min' }, stand: { actual, goal: 100, unit: 'count' },
    ...overrides
  };
}

function calculate(ringSummaries: RingSummaryEvidence[], loans: CreditEvidence['loans'] = [], at = now) {
  return calculateCredit({ ringSummaries, loans }, zone, at);
}

describe('ring-consistency-v1', () => {
  it.each([
    [0, 300, 250, 1.5], [50, 575, 1125, 1.275], [100, 850, 2000, 1.05]
  ])('maps %s percent consistency directly to policy terms', (actual, score, limit, multiplier) => {
    expect(calculate([summary(actual)]).credit).toMatchObject({
      score, creditLimitKcal: limit, repaymentMultiplier: multiplier, availableKcal: limit,
      outstandingKcal: 0, historyDays: 1, timeZone: zone, calculatedAt: now, policyVersion: 'ring-consistency-v1'
    });
  });

  it('distinguishes no history from known zero and accepts one usable day', () => {
    expect(calculate([]).credit).toMatchObject({ score: null, historyDays: 0, creditLimitKcal: 250, repaymentMultiplier: 1.5 });
    expect(calculate([summary(0)]).credit.score).toBe(300);
    expect(calculate([summary(100)]).credit.score).toBe(850);
  });

  it('caps each ring independently and weights rings and usable days equally', () => {
    const first = summary(0, '2026-10-21', { move: { actual: 1000, goal: 100, unit: 'kcal' } });
    const second = summary(100, '2026-10-20', { stand: { actual: 0, goal: 100, unit: 'count' } });
    expect(calculate([first, second]).credit).toMatchObject({ score: 575, historyDays: 2, creditLimitKcal: 1125 });
  });

  it('calculates rounded display and six-place terms from unrounded rational consistency', () => {
    const fractional = summary(0, '2026-10-21', { move: { actual: 1, goal: 3, unit: 'kcal' } });
    expect(calculate([fractional]).credit).toMatchObject({ score: 361, creditLimitKcal: 444.444444, repaymentMultiplier: 1.45 });
    const tie = summary(1, '2026-10-21', {
      move: { actual: 1, goal: 1100, unit: 'kcal' }, exercise: { actual: 1, goal: 1100, unit: 'min' }, stand: { actual: 1, goal: 1100, unit: 'count' }
    });
    expect(calculate([tie]).credit.score).toBe(301);
  });

  it('uses the previous seven completed dates only and includes the DST day as one day', () => {
    const dates = ['2026-10-22', '2026-10-21', '2026-10-20', '2026-10-19', '2026-10-18', '2026-10-17', '2026-10-16', '2026-10-15', '2026-10-14'];
    const rows = dates.map((date) => summary(date === '2026-10-22' || date === '2026-10-14' ? 100 : 0, date));
    expect(calculate(rows).credit).toMatchObject({ score: 300, historyDays: 7 });
    expect(calculate([summary(100, '2026-03-08')], [], '2026-03-09T19:00:00Z').credit).toMatchObject({ score: 850, historyDays: 1 });
  });

  it('matches canonical equivalent source zones without shifting daily totals', () => {
    expect(calculate([summary(100, '2026-10-21', { timeZone: 'US/Pacific' })]).credit.score).toBe(850);
    expect(calculate([summary(100, '2026-10-21', { timeZone: 'UTC' })]).credit.historyDays).toBe(0);
    expect(calculate([summary(100, '2026-10-21', { endsAt: '2026-10-22T08:00:00Z' })]).credit.historyDays).toBe(0);
  });

  it('uses explicitly selected Move time and qualifying stand hours', () => {
    expect(calculate([summary(50, '2026-10-21', { moveMode: 'time', move: { actual: 50, goal: 100, unit: 'min' } })]).credit.score).toBe(575);
    expect(calculate([summary(50, '2026-10-21', { moveMode: 'time' })]).credit.historyDays).toBe(0);
    expect(calculate([summary(50, '2026-10-21', { stand: { actual: 50, goal: 100, unit: 'min' } })]).credit.historyDays).toBe(0);
  });

  it.each([
    { paused: true }, { paused: null }, { moveMode: null }, { sourceRecordId: null }, { revisionAt: null },
    { exercise: { actual: null, goal: 100, unit: 'min' } }, { exercise: { actual: 50, goal: null, unit: 'min' } },
    { move: { actual: -1, goal: 100, unit: 'kcal' } }, { stand: { actual: 50, goal: 0, unit: 'count' } }
  ] satisfies Partial<NormalizedRingSummary>[])('keeps incomplete/paused summaries unknown: %o', (overrides) => {
    expect(calculate([summary(100, '2026-10-21', overrides)]).credit.historyDays).toBe(0);
  });

  it('chooses source authority without summing duplicates or falling back to better history', () => {
    const apple = summary(0);
    const other = summary(100, '2026-10-21', { sourceIdentity: 'another.source' });
    expect(calculate([other, apple, apple]).credit).toMatchObject({ score: 300, historyDays: 1 });
    expect(calculate([{ ...apple, paused: true }, other]).credit).toMatchObject({ score: null, historyDays: 0 });
    const lexicalFirst = summary(0, '2026-10-21', { sourceIdentity: 'a.source' });
    expect(calculate([other, lexicalFirst]).credit.score).toBe(300);
  });

  it('selects revisions before usability and never merges old goals into corrections', () => {
    const old = summary(100, '2026-10-21', { revisionAt: '2026-10-22T17:00:00Z' });
    const corrected = summary(0, '2026-10-21', { exercise: { actual: 50, goal: null, unit: 'min' } });
    for (const rows of [[old, corrected], [corrected, old]]) expect(calculate(rows).credit.historyDays).toBe(0);
    expect(calculate([old, { ...corrected, paused: true }]).credit.historyDays).toBe(0);
    expect(calculate([old, { ...corrected, revisionAt: null }]).credit.historyDays).toBe(0);
    expect(calculate([{ ...corrected, revisionAt: 'invalid' }, old]).credit.historyDays).toBe(0);
  });

  it('resolves equal revision times with the persisted canonical-content HMAC', () => {
    const low = summary(100, '2026-10-21', { revisionDigest: '00' });
    const high = summary(0, '2026-10-21', { revisionDigest: 'ff' });
    expect(calculate([low, high]).credit.score).toBe(300);
    expect(calculate([high, low]).credit.score).toBe(300);
  });

  it('reserves exact full principal until authoritative full repayment', () => {
    const loans = [{ principalKcal: '0.1', fullyRepaid: false }, { principalKcal: '0.2', fullyRepaid: false }, { principalKcal: '200', fullyRepaid: true }];
    const result = calculate([], loans);
    expect(result.exact.outstandingKcal.toString()).toBe('0.3');
    expect(result.exact.availableKcal.toString()).toBe('249.7');
    expect(calculate([], [{ principalKcal: '300', fullyRepaid: false }]).credit.availableKcal).toBe(-50);
    expect(calculate([], [{ principalKcal: '300', fullyRepaid: true }]).credit.availableKcal).toBe(250);
    expect(calculate([summary(100)], [{ principalKcal: '200', fullyRepaid: false }], '2027-01-01T00:00:00Z').credit.outstandingKcal).toBe(200);
  });

  it('does not downgrade invalid retained principal to starter credit', () => {
    expect(() => calculate([], [{ principalKcal: 'not-a-decimal', fullyRepaid: false }])).toThrow();
    expect(() => calculate([], [{ principalKcal: '-1', fullyRepaid: false }])).toThrow();
    expect(() => normalizedRingSummarySchema.parse({ ...summary(), move: { actual: Infinity, goal: 100, unit: 'kcal' } })).toThrow();
  });
});
