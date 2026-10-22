import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOAN_TERM_OPTIONS,
  LOAN_TREAT_IDS,
  loansViewResponseSchema,
  type LoanView
} from '@burn-rate/api-schema';
import {
  fetchLoans,
  filterRecentLoans,
  LoansUnavailableError,
  METRIC_LABELS,
  requestLoan,
  sortLoansForView,
  TERM_LABELS,
  TREAT_ART
} from '../src/lib/loans';

const input = { amountKcal: 400, durationDays: 7, timeZone: 'America/Los_Angeles' };
const credit = {
  score: 850, creditLimitKcal: 2000, outstandingKcal: 400, availableKcal: 1600,
  repaymentMultiplier: 1.05, historyDays: 7, timeZone: input.timeZone,
  calculatedAt: '2026-10-22T12:00:00.000Z', policyVersion: 'ring-consistency-v1'
};
const validBody = { outcome: 'approved', loan: viewLoan({ principalKcal: 400 }), credit };

afterEach(() => vi.unstubAllGlobals());

describe('requestLoan', () => {
  it('posts calorie terms to /loans with session credentials and an idempotency key', async () => {
    const fetchMock = vi.fn(async () => Response.json(validBody, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);

    const loan = await requestLoan(input, 'https://api.example.com', 'application-1');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/loans');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(input);
    expect(init.credentials).toBe('include');
    expect(new Headers(init.headers).get('Idempotency-Key')).toBe('application-1');
    expect(loan.outcome).toBe('approved');
    expect(loan.loan?.principalKcal).toBe(400);
    expect(loan.loan?.dueAt).toBe('2026-10-29T21:05:00Z');
  });

  it('returns insufficient-credit denials even with a successful HTTP response', async () => {
    const denial = { outcome: 'denied', loan: null, reason: 'insufficient-credit', message: 'Insufficient credit.', credit };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(denial)));
    await expect(requestLoan(input, 'https://api.example.com', 'denied-1')).resolves.toEqual(denial);
  });

  it('reuses the supplied key and body when retrying after a lost response', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('Connection lost'))
      .mockResolvedValueOnce(Response.json(validBody, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(requestLoan(input, 'https://api.example.com', 'retry-1')).rejects.toThrow('Connection lost');
    await requestLoan(input, 'https://api.example.com', 'retry-1');
    expect(fetchMock.mock.calls[0]).toEqual(fetchMock.mock.calls[1]);
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 400 })));
    await expect(
      requestLoan(input, 'https://api.example.com', 'application-1')
    ).rejects.toThrow('failed (400)');
  });

  it('throws when the response violates the contract', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ garbage: true })));
    await expect(
      requestLoan(input, 'https://api.example.com', 'application-1')
    ).rejects.toThrow();
  });
});

describe('presentation map', () => {
  it('covers every catalog treat and term option', () => {
    for (const id of LOAN_TREAT_IDS) {
      expect(TREAT_ART[id].emoji).toBeTruthy();
      expect(TREAT_ART[id].image).toBe(`/loans/${id}.png`);
    }
    for (const { unit } of LOAN_TERM_OPTIONS) {
      expect(TERM_LABELS[unit]).toBeTruthy();
    }
  });

  it('labels every repayment metric', () => {
    for (const metric of ['move_kcal', 'move_minutes', 'exercise_minutes', 'stand_hours'] as const) {
      expect(METRIC_LABELS[metric]).toBeTruthy();
    }
  });
});

const NOW = new Date('2026-10-22T12:00:00.000Z');

function viewLoan(overrides: Partial<LoanView> = {}): LoanView {
  return {
    id: 'loan_1',
    status: 'active',
    principalKcal: 200,
    outstandingKcal: 200,
    repaymentMetric: 'move_kcal',
    repaymentMultiplier: 1.275,
    repaymentTargetKcal: 255,
    repaymentProgressKcal: 0,
    durationDays: 7,
    timeZone: 'America/Los_Angeles',
    startsAt: '2026-10-22T21:05:00Z',
    dueAt: '2026-10-29T21:05:00Z',
    policyVersion: 'ring-consistency-v1',
    ...overrides
  };
}

describe('fetchLoans', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses the loans envelope with credentials included', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ loans: [JSON.parse(JSON.stringify(viewLoan()))] }, { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const loans = await fetchLoans('https://api.example.com');

    expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/loans');
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
    expect(loansViewResponseSchema.parse({ loans }).loans).toHaveLength(1);
    expect(loans[0].repaymentTargetKcal).toBe(255);
  });

  it('marks a missing or unimplemented endpoint as unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    await expect(fetchLoans('https://api.example.com')).rejects.toBeInstanceOf(LoansUnavailableError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 501 })));
    await expect(fetchLoans('https://api.example.com')).rejects.toBeInstanceOf(LoansUnavailableError);
  });

  it('throws a plain error on other failures and contract violations', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(fetchLoans('https://api.example.com')).rejects.toThrow('failed (500)');
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ loans: 'not-a-list' })));
    await expect(fetchLoans('https://api.example.com')).rejects.toThrow();
  });
});

describe('rolling 90-day window', () => {
  it('keeps active loans and settled loans due within the window', () => {
    const loans = [
      viewLoan({ id: 'active' }),
      viewLoan({ id: 'recent-past', status: 'repaid', dueAt: '2026-09-01T00:00:00Z' }),
      viewLoan({ id: 'old-past', status: 'overdue', dueAt: '2026-01-01T00:00:00Z' })
    ];
    expect(filterRecentLoans(loans, NOW).map((loan) => loan.id)).toEqual(['active', 'recent-past']);
  });
});

describe('sortLoansForView', () => {
  it('orders active loans by due date, then settled by most recent', () => {
    const sorted = sortLoansForView([
      viewLoan({ id: 'active-late', dueAt: '2026-11-15T00:00:00Z' }),
      viewLoan({ id: 'active-soon', dueAt: '2026-10-25T00:00:00Z' }),
      viewLoan({ id: 'repaid-older', status: 'repaid', dueAt: '2026-10-01T00:00:00Z' }),
      viewLoan({ id: 'overdue-recent', status: 'overdue', dueAt: '2026-10-10T00:00:00Z' })
    ]);
    expect(sorted.map((loan) => loan.id)).toEqual([
      'active-soon',
      'active-late',
      'overdue-recent',
      'repaid-older'
    ]);
  });
});
