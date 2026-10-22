import { Temporal } from '@js-temporal/polyfill';
import { canonicalCreditTimeZone } from '@burn-rate/api-schema/activity-credit';

export const canonicalizeTimeZone = canonicalCreditTimeZone;

function instant(value: Date | string): Temporal.Instant {
  return Temporal.Instant.from(value instanceof Date ? value.toISOString() : value);
}

export function localDateAt(now: Date | string, timeZone: string): string {
  return instant(now).toZonedDateTimeISO(canonicalizeTimeZone(timeZone)).toPlainDate().toString();
}

export function completedLocalDates(now: Date | string, timeZone: string, count = 7): string[] {
  const today = Temporal.PlainDate.from(localDateAt(now, timeZone));
  return Array.from({ length: count }, (_, index) => today.subtract({ days: index + 1 }).toString());
}

export function localDayBounds(localDate: string, timeZone: string): { startsAt: string; endsAt: string } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) throw new RangeError('Invalid local date.');
  const date = Temporal.PlainDate.from(localDate);
  const zone = canonicalizeTimeZone(timeZone);
  const start = date.toZonedDateTime(zone).startOfDay();
  if (start.toPlainDate().toString() !== localDate) throw new RangeError('Local date does not exist.');
  const end = date.add({ days: 1 }).toZonedDateTime(zone).startOfDay();
  return { startsAt: start.toInstant().toString(), endsAt: end.toInstant().toString() };
}

/** Add wall-clock calendar days, resolving a gap forward and a fold to its earlier instant. */
export function addCalendarDays(startsAt: string, durationDays: number, timeZone: string): string {
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 30) throw new RangeError('Invalid loan duration.');
  const zone = canonicalizeTimeZone(timeZone);
  const target = instant(startsAt).toZonedDateTimeISO(zone).toPlainDateTime().add({ days: durationDays });
  return target.toZonedDateTime(zone, { disambiguation: 'compatible' }).toInstant().toString();
}
