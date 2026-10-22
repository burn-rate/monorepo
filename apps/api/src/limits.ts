import type { Sql } from './db';

export class RequestFailure extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
  }
}

export function positiveLimit(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new RequestFailure(503, 'configuration-error', 'Service configuration is unavailable');
  }
  return parsed;
}

/** Shared fixed-window limiter. Postgres serializes concurrent increments across Workers. */
export async function enforceRateLimit(
  sql: Sql, scope: string, identity: string, limit: number, now = Date.now()
): Promise<void> {
  const windowStart = new Date(Math.floor(now / 60_000) * 60_000);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(identity));
  const key = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
  const result = await sql.query<{ hits: number }>(
    `INSERT INTO api_rate_limits (scope, identity_digest, window_start, hits)
     VALUES ($1,$2,$3,1)
     ON CONFLICT (scope,identity_digest,window_start) DO UPDATE
       SET hits=LEAST(api_rate_limits.hits + 1, $4::integer + 1)
     RETURNING hits`, [scope, key, windowStart, limit]
  );
  if (result.rows[0].hits > limit) {
    throw new RequestFailure(429, 'rate-limit-exceeded', 'Too many requests; retry after one minute');
  }
}

export async function readBoundedBody(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) {
    throw new RequestFailure(413, 'payload-too-large', 'Upload exceeds the payload limit');
  }
  if (!request.body) return '';
  const reader = request.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestFailure(413, 'payload-too-large', 'Upload exceeds the payload limit');
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  return new TextDecoder().decode(bytes);
}
