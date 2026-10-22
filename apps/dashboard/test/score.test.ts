import { afterEach, describe, expect, it, vi } from 'vitest';
import { creditSnapshotSchema } from '@burn-rate/api-schema';
import { fetchScore, scoreFraction, stubScoreSnapshot } from '../src/lib/score';

const snapshot = stubScoreSnapshot('America/Los_Angeles', new Date('2026-10-22T21:00:00Z'));

afterEach(() => vi.unstubAllGlobals());

describe('fetchScore', () => {
  it('requests the timezone and parses the credit snapshot', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json(JSON.parse(JSON.stringify(snapshot)), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const score = await fetchScore('https://api.example.com', 'America/Los_Angeles');

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://api.example.com/score?timeZone=America%2FLos_Angeles'
    );
    expect((fetchMock.mock.calls[0][1] as RequestInit).credentials).toBe('include');
    expect(score.score).toBe(737);
    expect(creditSnapshotSchema.parse(score)).toEqual(score);
  });

  it('falls back to the stub snapshot when the endpoint is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));
    const score = await fetchScore('https://api.example.com', 'UTC');
    expect(score.score).toBe(737);
    expect(creditSnapshotSchema.parse(score)).toEqual(score);
  });

  it('throws on other failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    await expect(fetchScore('https://api.example.com', 'UTC')).rejects.toThrow('failed (500)');
  });
});

describe('scoreFraction', () => {
  it('maps the 300-850 scale onto [0, 1] and clamps', () => {
    expect(scoreFraction(300)).toBe(0);
    expect(scoreFraction(850)).toBe(1);
    expect(scoreFraction(575)).toBeCloseTo(0.5, 5);
    expect(scoreFraction(0)).toBe(0);
    expect(scoreFraction(900)).toBe(1);
  });
});
