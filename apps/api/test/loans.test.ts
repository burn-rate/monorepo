import { describe, expect, it, vi } from 'vitest';
import treatsSeed from '../../../data/treats.json';
import { createApp, type Env } from '../src/index';
import type { Sql } from '../src/db';
// Catalog values come from the app's own module, not directly from
// @burn-rate/api-schema: importing the schema package before src/index makes
// vitest resolve a second zod instance and break routes.ts OpenAPI patching.
import { LOAN_TERM_OPTIONS, LOAN_TREATS, stubLoanRequest } from '../src/loans/catalog';

function loanApp() {
  const app = createApp(async () => ({ query: vi.fn(), end: vi.fn() }) as unknown as Sql);
  const bindings = { HOOK_DUMPS: { put: vi.fn() } } as unknown as Env;
  return (body: unknown) =>
    app.request(
      'https://api.example.com/loan',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body)
      },
      bindings
    );
}

const NOW = new Date('2026-10-22T12:00:00.000Z');

describe('stubLoanRequest', () => {
  it('prices the donut at 400 kcal due in one day', () => {
    const stub = stubLoanRequest({ treatId: 'donut', termUnit: 'days' }, NOW);
    expect(stub).toMatchObject({
      treatId: 'donut',
      treat: { name: 'Donut', caloriesKcal: 400 },
      principalKcal: 400,
      status: 'requested',
      term: { length: 1, unit: 'days', startsAt: NOW.toISOString(), dueAt: '2026-10-23T12:00:00.000Z' },
      requirement: { metric: 'stand_hours', target: 12 }
    });
  });

  it('maps week and month terms to due dates and scaled targets', () => {
    const week = stubLoanRequest({ treatId: 'beer', termUnit: 'weeks' }, NOW);
    expect(week.principalKcal).toBe(200);
    expect(week.term.dueAt).toBe('2026-10-29T12:00:00.000Z');
    expect(week.requirement.target).toBe(84);

    const month = stubLoanRequest({ treatId: 'beer', termUnit: 'months' }, NOW);
    expect(month.term.dueAt).toBe('2026-11-22T12:00:00.000Z');
    expect(month.requirement.target).toBe(360);
  });

  it('issues unique ids and stamps the stub user and zone', () => {
    const requests = [
      stubLoanRequest({ treatId: 'donut', termUnit: 'days' }, NOW),
      stubLoanRequest({ treatId: 'donut', termUnit: 'days' }, NOW)
    ];
    expect(requests[0].id).not.toBe(requests[1].id);
    expect(requests[0].userId).toBe('default');
    expect(requests[0].term.timeZone).toBe('America/Los_Angeles');
  });
});

describe('POST /loan/req', () => {
  it('accepts every treat and term option combination', async () => {
    const request = loanApp();
    for (const treatId of ['donut', 'beer'] as const) {
      for (const { unit } of LOAN_TERM_OPTIONS) {
        const response = await request({ treatId, termUnit: unit });
        expect(response.status).toBe(201);
        await expect(response.json()).resolves.toMatchObject({
          treatId,
          status: 'requested',
          term: { unit }
        });
      }
    }
  });

  it('rejects unknown treats, unknown units, and malformed bodies', async () => {
    const request = loanApp();
    expect((await request({ treatId: 'pizza', termUnit: 'days' })).status).toBe(400);
    expect((await request({ treatId: 'donut', termUnit: 'fortnights' })).status).toBe(400);
    expect((await request('not json')).status).toBe(400);
  });

  it('is published in the OpenAPI contract', async () => {
    const app = createApp(async () => ({ query: vi.fn(), end: vi.fn() }) as unknown as Sql);
    const bindings = { HOOK_DUMPS: { put: vi.fn() } } as unknown as Env;
    const response = await app.request('https://api.example.com/openapi.json', {}, bindings);
    const doc = (await response.json()) as { paths: Record<string, Record<string, unknown>> };
    expect(doc.paths['/loan']?.post).toBeDefined();
  });
});

describe('treats seed', () => {
  it('stays in sync with the shared stub catalog', () => {
    expect(treatsSeed).toEqual({
      version: 1,
      treats: Object.values(LOAN_TREATS)
    });
  });
});
