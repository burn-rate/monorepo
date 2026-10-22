import type { Sql } from './db';
import { AuthError } from './auth-config';
import type { AuthSession } from './auth';

const encoder = new TextEncoder();
const FRESHNESS_MS = 5 * 60 * 1000;

export function requireFreshPasskey(session: AuthSession, now = Date.now()): void {
  const verified = session.session.passkeyVerifiedAt;
  const timestamp = verified ? new Date(verified).getTime() : Number.NaN;
  if (!Number.isFinite(timestamp) || timestamp > now || now - timestamp > FRESHNESS_MS) {
    throw new AuthError(403, 'PASSKEY_VERIFICATION_REQUIRED', 'Verify a passkey again before this action.');
  }
}

function randomSecret(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function hashToken(token: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(token))), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface IngestionTokenMetadata {
  id: string;
  name: string;
  createdAt: string;
  revokedAt: string | null;
}

type TokenRow = { id: string; name: string; created_at: Date; revoked_at: Date | null };
const metadata = (row: TokenRow): IngestionTokenMetadata => ({
  id: row.id, name: row.name, createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null
});

export async function createIngestionToken(sql: Sql, session: AuthSession, name: string): Promise<IngestionTokenMetadata & { token: string }> {
  requireFreshPasskey(session);
  if (!name.trim() || name.trim().length > 100) throw new AuthError(400, 'INVALID_TOKEN_NAME', 'Provide a token name between 1 and 100 characters.');
  const id = crypto.randomUUID();
  const token = `br_ingest_${id}.${randomSecret()}`;
  const result = await sql.query<TokenRow>(
    'INSERT INTO ingestion_tokens (id, user_id, name, token_hash) VALUES ($1, $2, $3, $4) RETURNING id, name, created_at, revoked_at',
    [id, session.user.id, name.trim(), await hashToken(token)]
  );
  return { ...metadata(result.rows[0]), token };
}

export async function listIngestionTokens(sql: Sql, owner: string): Promise<IngestionTokenMetadata[]> {
  const result = await sql.query<TokenRow>('SELECT id, name, created_at, revoked_at FROM ingestion_tokens WHERE user_id = $1 ORDER BY created_at DESC, id', [owner]);
  return result.rows.map(metadata);
}

/** Both missing and foreign IDs return false; revocation of an already revoked own token succeeds. */
export async function revokeIngestionToken(sql: Sql, owner: string, id: string): Promise<boolean> {
  const result = await sql.query('UPDATE ingestion_tokens SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1 AND user_id = $2 RETURNING id', [id, owner]);
  return result.rowCount === 1;
}

export async function authenticateIngestionToken(sql: Sql, authorization: string | null): Promise<string | null> {
  const match = authorization?.match(/^Bearer (br_ingest_([0-9a-f-]{36})\.[0-9a-f]{64})$/);
  if (!match) return null;
  // The full high-entropy credential is hashed; the public id is only a lookup hint.
  const result = await sql.query<{ user_id: string }>(
    'SELECT user_id FROM ingestion_tokens WHERE id = $1 AND token_hash = $2 AND revoked_at IS NULL',
    [match[2], await hashToken(match[1])]
  );
  return result.rows[0]?.user_id ?? null;
}
