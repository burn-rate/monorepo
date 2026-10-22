/** Counts raw points that were skipped during mapping, keyed by reason. */
export class DropLog {
  private readonly counts = new Map<string, number>();

  drop(rawName: string, count = 1): void {
    this.counts.set(rawName, (this.counts.get(rawName) ?? 0) + count);
  }

  toRecord(): Record<string, number> {
    return Object.fromEntries([...this.counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  get total(): number {
    return [...this.counts.values()].reduce((sum, n) => sum + n, 0);
  }
}

/** Source names carry non-breaking spaces from HealthKit; normalize them. */
export function normalizeSourceName(name: unknown): string {
  return String(name).replace(/\u00a0/g, ' ');
}

const OFFSET_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/;

/**
 * Strictly parse the metrics-v1 date format ('2026-10-21 00:09:00 -0700').
 * `new Date()` parsing of non-ISO strings is engine-dependent, so the Worker
 * parses these manually. Throws on malformed input; callers drop + log.
 */
export function parseOffsetDate(value: string): Date {
  const match = OFFSET_DATE_RE.exec(value);
  if (!match) throw new Error(`unparseable date: ${value}`);

  const [, y, mo, d, h, mi, s, sign, oh, om] = match;
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offsetMinutes = (Number(oh) * 60 + Number(om)) * (sign === '-' ? -1 : 1);
  return new Date(asUtc - offsetMinutes * 60_000);
}

export function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
