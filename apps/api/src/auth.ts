import { betterAuth } from 'better-auth';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { passkey } from '@better-auth/passkey';
import { Kysely, PostgresDialect, type PostgresPool } from 'kysely';
import type { Sql } from './db';
import { AuthError, assertTrustedMutation, readAuthConfig, type AuthEnvironment } from './auth-config';
import { hashToken, requireFreshPasskey } from './tokens';

export type { AuthEnvironment } from './auth-config';
export { AuthError, assertTrustedMutation, readAuthConfig } from './auth-config';

export interface AuthSession {
  user: { id: string; name: string };
  session: { id: string; createdAt: Date; expiresAt: Date; passkeyVerifiedAt?: Date | null };
}

const ONBOARDING_TTL = 5 * 60 * 1000;
type OnboardingRow = { user_id: string; name: string; expires_at: Date };

async function resolveOnboarding(sql: Sql, context: string | null | undefined): Promise<OnboardingRow> {
  if (!context || !/^[a-f0-9]{64}$/.test(context)) throw new APIError('BAD_REQUEST', { code: 'INVALID_ONBOARDING_CONTEXT', message: 'Start a new passkey registration.' });
  const result = await sql.query<OnboardingRow>(
    'SELECT user_id, name, expires_at FROM auth_onboarding WHERE context_hash = $1 AND consumed_at IS NULL AND expires_at > now()',
    [await hashToken(context)]
  );
  if (!result.rows[0]) throw new APIError('BAD_REQUEST', { code: 'INVALID_ONBOARDING_CONTEXT', message: 'Start a new passkey registration.' });
  return result.rows[0];
}

/** A facade over the caller's already connected client; it opens and closes no connections. */
function requestScopedPool(sql: Sql): PostgresPool {
  const client = Object.create(sql) as Sql & { release(): void };
  client.query = sql.query.bind(sql);
  client.release = () => {};
  return { options: {}, connect: async () => client as unknown as Awaited<ReturnType<PostgresPool['connect']>>, end: async () => {} };
}

export function createAuth(sql: Sql, env: AuthEnvironment) {
  const config = readAuthConfig(env);
  const plugin = passkey({
    rpID: config.rpID,
    rpName: config.rpName,
    origin: config.passkeyOrigins,
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    schema: { passkey: { modelName: 'auth_passkeys', fields: {
      publicKey: 'public_key', userId: 'user_id', credentialID: 'credential_id', deviceType: 'device_type', backedUp: 'backed_up', createdAt: 'created_at'
    } } },
    registration: {
      requireSession: false,
      resolveUser: async ({ context }) => {
        const onboarding = await resolveOnboarding(sql, context);
        return { id: onboarding.user_id, name: onboarding.name, displayName: onboarding.name };
      },
      afterVerification: async ({ ctx, verification, user, context }) => {
        // 1.7.12 verifies the signature with requireUserVerification:false. Enforce
        // the signed authenticator UV bit here before any account/key/session write.
        if (!verification.registrationInfo?.userVerified) throw new APIError('FORBIDDEN', { code: 'USER_VERIFICATION_REQUIRED', message: 'Passkey user verification is required.' });
        const session = await getSessionFromCtx(ctx);
        if (session) return { userId: session.user.id };
        const onboarding = await resolveOnboarding(sql, context);
        if (onboarding.user_id !== user.id) throw new APIError('BAD_REQUEST', { code: 'INVALID_ONBOARDING_CONTEXT', message: 'Start a new passkey registration.' });
        // createSession:true makes this hook, credential insert, and session insert
        // one Better Auth/Kysely transaction on the same request-scoped client.
        const consumed = await sql.query<OnboardingRow>(
          'UPDATE auth_onboarding SET consumed_at = now() WHERE context_hash = $1 AND user_id = $2 AND consumed_at IS NULL AND expires_at > now() RETURNING user_id, name, expires_at',
          [await hashToken(context!), user.id]
        );
        if (consumed.rowCount !== 1) throw new APIError('BAD_REQUEST', { code: 'INVALID_ONBOARDING_CONTEXT', message: 'Start a new passkey registration.' });
        const created = await ctx.context.internalAdapter.createUser({
          id: user.id,
          name: onboarding.name,
          email: `${user.id}@accounts.invalid`,
          emailVerified: false
        }, { method: 'passkey' });
        return { userId: created.id };
      }
    },
    authentication: {
      afterVerification: async ({ verification }) => {
        if (!verification.authenticationInfo.userVerified) throw new APIError('FORBIDDEN', { code: 'USER_VERIFICATION_REQUIRED', message: 'Passkey user verification is required.' });
      }
    }
  });
  // The stock endpoint lacks freshness and last-passkey protection. Remove it
  // from the plugin entirely so neither its HTTP nor server API can bypass ours.
  const { deletePasskey: _unsafeDeletion, updatePasskey: _unusedRename, ...safePasskeyEndpoints } = plugin.endpoints;
  return betterAuth({
    appName: 'Burn Rate',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    database: { db: new Kysely({ dialect: new PostgresDialect({ pool: requestScopedPool(sql) }) }), type: 'postgres', transaction: true },
    trustedOrigins: config.trustedOrigins,
    emailAndPassword: { enabled: false },
    socialProviders: {},
    user: { modelName: 'auth_users', fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' } },
    session: {
      modelName: 'auth_sessions',
      fields: { userId: 'user_id', expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at', ipAddress: 'ip_address', userAgent: 'user_agent' },
      expiresIn: 7 * 24 * 60 * 60,
      freshAge: 5 * 60,
      cookieCache: { enabled: false },
      additionalFields: { passkeyVerifiedAt: { type: 'date', required: false, input: false, fieldName: 'passkey_verified_at' } }
    },
    account: { modelName: 'auth_accounts', fields: { accountId: 'account_id', providerId: 'provider_id', userId: 'user_id', accessToken: 'access_token', refreshToken: 'refresh_token', idToken: 'id_token', accessTokenExpiresAt: 'access_token_expires_at', refreshTokenExpiresAt: 'refresh_token_expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    verification: { modelName: 'auth_verifications', fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' } },
    advanced: { useSecureCookies: config.secureCookies, defaultCookieAttributes: { httpOnly: true, secure: config.secureCookies, sameSite: config.sameSite } },
    databaseHooks: { session: { create: { before: async (session) => ({ data: { ...session, passkeyVerifiedAt: new Date() } }) } } },
    hooks: { before: createAuthMiddleware(async (ctx) => {
      if (ctx.path === '/passkey/verify-registration' && ctx.body?.createSession !== true) {
        throw new APIError('BAD_REQUEST', { code: 'SESSION_REQUIRED_AFTER_REGISTRATION', message: 'Pass createSession: true when registering a passkey.' });
      }
    }) },
    plugins: [{ ...plugin, endpoints: safePasskeyEndpoints }],
    // The application rate limiter uses atomic Postgres counters across Workers.
    rateLimit: { enabled: false },
    // Library errors may contain adapter parameters or credential data.
    logger: { disabled: true },
    telemetry: { enabled: false },
    disabledPaths: ['/sign-up/email', '/sign-in/email', '/sign-in/social', '/link-social', '/change-password', '/set-password', '/request-password-reset', '/reset-password', '/forget-password', '/send-verification-email', '/verify-email', '/change-email', '/delete-user']
  });
}

export async function getAuthSession(sql: Sql, env: AuthEnvironment, headers: Headers): Promise<AuthSession | null> {
  const result = await createAuth(sql, env).api.getSession({ headers, query: { disableCookieCache: true } });
  if (!result || new Date(result.session.expiresAt).getTime() <= Date.now()) return null;
  return result as AuthSession;
}

export async function createOnboardingContext(sql: Sql, name = 'Burn Rate user'): Promise<{ context: string; expiresAt: string }> {
  const context = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const expiresAt = new Date(Date.now() + ONBOARDING_TTL);
  // Bound expired/consumed context retention without creating incomplete users.
  await sql.query('DELETE FROM auth_onboarding WHERE expires_at < now()');
  await sql.query('INSERT INTO auth_onboarding (context_hash, user_id, name, expires_at) VALUES ($1, $2, $3, $4)', [await hashToken(context), crypto.randomUUID(), name, expiresAt]);
  return { context, expiresAt: expiresAt.toISOString() };
}

export async function removePasskey(sql: Sql, session: AuthSession, id: string): Promise<void> {
  requireFreshPasskey(session);
  await sql.query('BEGIN');
  try {
    // Serialize all key removals for this owner, including two simultaneous
    // requests targeting different keys. A row count alone is not sufficient.
    await sql.query('SELECT id FROM auth_users WHERE id = $1 FOR UPDATE', [session.user.id]);
    const keys = await sql.query<{ id: string }>('SELECT id FROM auth_passkeys WHERE user_id = $1', [session.user.id]);
    if (!keys.rows.some((key) => key.id === id)) throw new AuthError(404, 'PASSKEY_NOT_FOUND', 'Passkey not found.');
    if (keys.rows.length < 2) throw new AuthError(409, 'LAST_PASSKEY', 'Add another passkey before removing this one.');
    await sql.query('DELETE FROM auth_passkeys WHERE id = $1 AND user_id = $2', [id, session.user.id]);
    await sql.query('COMMIT');
  } catch (error) {
    await sql.query('ROLLBACK');
    throw error;
  }
}

const managedPaths = new Set(['/passkey/generate-register-options', '/passkey/generate-authenticate-options', '/passkey/verify-registration', '/passkey/verify-authentication', '/passkey/list-user-passkeys', '/get-session', '/sign-out', '/list-sessions', '/revoke-session', '/revoke-sessions', '/revoke-other-sessions']);

export async function handleAuthRequest(request: Request, sql: Sql, env: AuthEnvironment): Promise<Response> {
  const config = readAuthConfig(env);
  assertTrustedMutation(request, config);
  const path = new URL(request.url).pathname.slice('/api/auth'.length);
  if (path === '/onboarding/context' && request.method === 'POST') {
    const body = await request.json().catch(() => null) as { name?: unknown } | null;
    if (!body || (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 100))) throw new AuthError(400, 'INVALID_NAME', 'Provide a name between 1 and 100 characters.');
    return Response.json(await createOnboardingContext(sql, typeof body.name === 'string' ? body.name.trim() : undefined), { headers: { 'Cache-Control': 'no-store' } });
  }
  if (path === '/passkey/delete-passkey' && request.method === 'POST') {
    const session = await getAuthSession(sql, env, request.headers);
    if (!session) throw new AuthError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
    const body = await request.json().catch(() => null) as { id?: unknown } | null;
    if (!body || typeof body.id !== 'string' || body.id.length > 200) throw new AuthError(400, 'INVALID_PASSKEY_ID', 'Provide a passkey ID.');
    await removePasskey(sql, session, body.id);
    return Response.json({ status: true }, { headers: { 'Cache-Control': 'no-store' } });
  }
  if (!managedPaths.has(path)) return Response.json({ code: 'NOT_FOUND', message: 'Authentication endpoint not found.' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const response = await createAuth(sql, env).handler(request);
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-store');
  if (path === '/passkey/generate-authenticate-options' && response.ok) {
    const options = await response.json() as Record<string, unknown>;
    return Response.json({ ...options, userVerification: 'required' }, { status: response.status, headers });
  }
  return new Response(response.body, { status: response.status, headers });
}
