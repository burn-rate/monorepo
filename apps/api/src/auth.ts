import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { passkey } from '@better-auth/passkey';
import {
  encodePasskeySignupContext,
  passkeySignupContextSchema,
  schema,
  createDb
} from '@burn-rate/db';

/** The drizzle instance better-auth persists through. */
type Db = ReturnType<typeof createDb>['db'];

export interface AuthEnv {
  BETTER_AUTH_SECRET: string;
  /** Public URL of this API. Defaults to the local dev address. */
  BETTER_AUTH_URL?: string;
  /** Dashboard origin — trusted for CORS + auth redirects. Defaults to local dev. */
  DASHBOARD_URL?: string;
  /** WebAuthn Relying Party ID. Must cover both API and dashboard hostnames in prod (same registrable domain). */
  PASSKEY_RP_ID?: string;
  PASSKEY_RP_NAME?: string;
}

const DEFAULT_API_URL = 'http://localhost:8787';
const DEFAULT_DASHBOARD_URL = 'http://localhost:5173';

/**
 * Better Auth instance, created per request (Workers don't keep process-level
 * singletons cheaply and the db pool is request-scoped — see src/index.ts).
 *
 * Passkey-only auth: there is no credential/password. Sign-up is passkey-first
 * (registration.requireSession: false) — the client forwards an unsigned
 * context { email, name } and resolveUser creates the account if the email is
 * not taken, then the WebAuthn ceremony runs and createSession logs the user
 * in. Existing accounts can only attach passkeys while signed in
 * (requireSession path), never via a fresh context.
 */
export function createAuth(db: Db, env: AuthEnv) {
  const dashboardUrl = env.DASHBOARD_URL ?? DEFAULT_DASHBOARD_URL;

  return betterAuth({
    baseURL: env.BETTER_AUTH_URL ?? DEFAULT_API_URL,
    secret: env.BETTER_AUTH_SECRET,
    trustedOrigins: [dashboardUrl],
    database: drizzleAdapter(db, {
      provider: 'pg',
      schema
    }),
    plugins: [
      passkey({
        rpID: env.PASSKEY_RP_ID ?? 'localhost',
        rpName: env.PASSKEY_RP_NAME ?? 'Burn Rate',
        // The origin where the WebAuthn ceremony runs — the dashboard, not
        // this API. rpID 'localhost' covers both local dev ports.
        origin: dashboardUrl,
        registration: {
          requireSession: false,
          resolveUser: async ({ ctx, context: rawContext }) => {
            if (!rawContext) {
              throw new APIError('BAD_REQUEST', {
                message: 'sign-up context is required for passkey registration'
              });
            }

            let parsedJson: unknown;
            try {
              parsedJson = JSON.parse(rawContext);
            } catch {
              throw new APIError('BAD_REQUEST', { message: 'invalid sign-up context' });
            }

            const parsed = passkeySignupContextSchema.safeParse(parsedJson);
            if (!parsed.success) {
              throw new APIError('BAD_REQUEST', { message: 'invalid sign-up context' });
            }

            const { email, name } = parsed.data;

            // Create-only: an existing email must never gain a passkey from an
            // unsigned context (account takeover). Attachments to existing
            // accounts go through the authenticated addPasskey path.
            const existing = await db.query.user.findFirst({ where: (u, { eq }) => eq(u.email, email) });
            if (existing) {
              throw new APIError('BAD_REQUEST', {
                message: 'account already exists — sign in with your passkey'
              });
            }

            const displayName = name ?? email.split('@')[0]!;
            const [created] = await db
              .insert(schema.user)
              .values({
                id: crypto.randomUUID(),
                email,
                name: displayName,
                emailVerified: false,
                createdAt: new Date(),
                updatedAt: new Date()
              })
              .returning();

            if (!created) {
              throw new APIError('INTERNAL_SERVER_ERROR', { message: 'failed to create account' });
            }

            return { id: created.id, name: created.name, displayName: created.name };
          }
        }
      })
    ]
  });
}

// Re-exported so the dashboard (or tests) can build contexts from one source.
export { encodePasskeySignupContext };
