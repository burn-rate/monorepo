import { describe, expect, it } from 'vitest';
import { addCalendarDays, canonicalizeTimeZone, completedLocalDates, localDateAt, localDayBounds } from '../src/credit/calendar';

const zone = 'America/Los_Angeles';
const hoursBetween = (left: string, right: string) => (Date.parse(right) - Date.parse(left)) / 3_600_000;

describe('credit local calendars', () => {
  it('canonicalizes equivalent IANA identifiers and rejects invalid zones and offsets', () => {
    expect(canonicalizeTimeZone('US/Pacific')).toBe(zone);
    for (const invalid of ['', 'Mars/Example', '+01:00', '-08:00']) expect(() => canonicalizeTimeZone(invalid)).toThrow();
  });

  it('uses completed local dates across DST and excludes the evaluation date', () => {
    const now = '2026-03-09T06:59:00Z';
    expect(localDateAt(now, zone)).toBe('2026-03-08');
    expect(completedLocalDates(now, zone)).toEqual([
      '2026-03-07', '2026-03-06', '2026-03-05', '2026-03-04', '2026-03-03', '2026-03-02', '2026-03-01'
    ]);
  });

  it('recognizes 23-hour and 25-hour full local days', () => {
    const spring = localDayBounds('2026-03-08', zone);
    const fall = localDayBounds('2026-11-01', zone);
    expect(hoursBetween(spring.startsAt, spring.endsAt)).toBe(23);
    expect(hoursBetween(fall.startsAt, fall.endsAt)).toBe(25);
    expect(() => localDayBounds('2026-02-30', zone)).toThrow();
    expect(() => localDayBounds('2011-12-30', 'Pacific/Apia')).toThrow();
  });

  it('keeps local term clock times over 23/25-hour days', () => {
    expect(addCalendarDays('2026-03-07T20:00:00Z', 1, zone)).toBe('2026-03-08T19:00:00Z');
    expect(addCalendarDays('2026-10-31T19:00:00Z', 1, zone)).toBe('2026-11-01T20:00:00Z');
    expect(addCalendarDays('2026-10-22T21:05:00Z', 7, zone)).toBe('2026-10-29T21:05:00Z');
  });

  it('resolves a destination gap forward and a destination fold to its earlier instant', () => {
    expect(addCalendarDays('2026-03-07T10:30:00Z', 1, zone)).toBe('2026-03-08T10:30:00Z');
    expect(addCalendarDays('2026-10-31T08:30:00Z', 1, zone)).toBe('2026-11-01T08:30:00Z');
    expect(() => addCalendarDays('2026-10-22T21:05:00Z', 0, zone)).toThrow();
    expect(() => addCalendarDays('2026-10-22T21:05:00Z', 31, zone)).toThrow();
  });
});
