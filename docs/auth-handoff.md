# Passkey frontend handoff

The backend pins `better-auth` and `@better-auth/passkey` to **1.7.12**. The frontend should use those same versions and Better Auth's browser client with `passkeyClient` from `@better-auth/passkey/client`. WebAuthn browser calls belong to that client; the generated application SDK covers health reads and ingestion-token management.

Create the browser client with the configured API base URL and credentialed fetches. All application SDK requests also need `credentials: 'include'`. Use a new SDK client per SSR request and forward cookies only to the configured trusted API origin. Do not store caller cookies on a process-wide mutable client.

## New account

1. `POST /api/auth/onboarding/context` with JSON `{ "email": "reader@example.com", "name": "Display name" }`, an exact configured `Origin`, and credentials included. The dashboard collects email and optional name; the backend normalizes the email and chooses a default display name when omitted. The response is `{ context, expiresAt }`; the opaque server-issued context expires after five minutes. A failed request or response without context must stop signup before starting WebAuthn.
2. Call `authClient.passkey.addPasskey({ context, name: 'Primary passkey', createSession: true })`. The plugin transports context with the registration options and binds it to the stored ceremony. **`createSession: true` is required** so user, credential, and session persistence is transactional.
3. After success, obtain the public account from the generated `getCurrentUser` operation or Better Auth `getSession`.

The backend generates account identifiers and creates the account only after successful user-verified registration. Email/name in onboarding state do not create an account early. An existing email cannot claim an account through onboarding: verification follows create-only semantics. The submitted email remains unverified contact metadata and is not a recovery method. Backend clients that omit email receive a synthetic `@accounts.invalid` identifier, which is not a contact address. Client-authored unsigned JSON context is rejected. Abandoning or failing a ceremony creates no account/session. Context is single-use after successful verification. A failed ceremony consumes its challenge, so restart registration instead of retrying the same WebAuthn response.

The dashboard's `requestPasskeySignupContext` helper performs this credentialed
POST before calling `authClient.passkey.addPasskey`. Better Auth's client is
also configured with `fetchOptions: { credentials: 'include' }`. The login page
continues to show the authenticated account email.

## Sign-in, verification, and management

- Sign in with `authClient.signIn.passkey()`. Discoverable credentials and user verification are required. An existing session limits offered credentials to its owner; sign out before intentionally switching accounts.
- Sign out with Better Auth `signOut()`. Sessions are checked against Postgres on each protected request; there is no cookie-only session cache. Session expiry is seven days, subject to Better Auth renewal. Sign-out/revocation take effect immediately.
- List credentials with `authClient.passkey.listUserPasskeys()`. Add another with `addPasskey({ name, createSession: true })` while authenticated.
- Before deleting a passkey or creating an ingestion token, complete `signIn.passkey()` within the preceding **five minutes**. A long-lived cookie alone is insufficient. On `PASSKEY_VERIFICATION_REQUIRED`, perform sign-in and retry the intended action.
- Remove with `authClient.passkey.deletePasskey({ id })`. The backend replaces the stock deletion endpoint with owner-scoped transactional checks. `LAST_PASSKEY` (409) means add another credential first. Unknown/foreign IDs both return 404. Two simultaneous removals cannot remove all credentials.
- The only recovery method in this scope is another registered passkey. The UI should make that clear before removal and encourage a second passkey. No password, email, social login, or recovery flow is enabled.

Ingestion-token creation returns `{ token: { id, name, createdAt, revokedAt }, secret }`. Show `secret` once and let the user copy it to their exporter. Lists and subsequent reads cannot recover it. Revocation is idempotent for an owned token. A token authorizes exporter uploads only, never frontend reads or account management.

## Deployment configuration

Canonical API inputs are `BETTER_AUTH_URL`, `DASHBOARD_URL`, `PASSKEY_RP_ID`, `PASSKEY_RP_NAME`, and secret `BETTER_AUTH_SECRET` (at least 32 strong random characters, separate from encryption keys). `AUTH_BASE_URL`, JSON-array `DASHBOARD_ORIGINS`, and `AUTH_SECRET` remain compatibility aliases. The dashboard uses public `API_URL`. `AUTH_COOKIE_SAME_SITE` accepts `lax` (default), `strict`, or `none`; `none` requires HTTPS. Configure CORS with the same exact dashboard origins and credential support.

Production uses API Worker `api` at `https://api.burn-rate-app.workers.dev`, dashboard Worker `app` at `https://app.burn-rate-app.workers.dev`, RP ID `burn-rate-app.workers.dev`, and `lax` cookies. The two configured hosts share that account RP domain. Local development uses API `http://localhost:8787`, dashboard `http://localhost:5173`, and RP ID `localhost`. Existing credentials remain bound to their RP ID, so coordinate any domain change before enrolling users on the replacement host. Every dashboard origin must be HTTPS (localhost HTTP is permitted for development) and its hostname must equal or be beneath the configured RP ID.

Canonical Better Auth `user`, `session`, `account`, `verification`, and `passkey`
tables are shared through `@burn-rate/db`. The normal API migration runner
bootstraps or upgrades them and adds server-owned onboarding, session passkey
freshness, and ingestion-token storage. The database package's `db:migrate`
forwards to this same runner; historical Drizzle SQL is not a second deployment
history. The dashboard deploy job waits for successful API migration/deployment.

Cookies are HttpOnly and Secure for HTTPS deployments. All authenticated mutations, including onboarding and passkey operations, require an exact configured `Origin`. Personalized responses are `Cache-Control: no-store`. Handle 429 on onboarding/passkey/token routes with a retry message. Backend auth errors retain Better Auth's `{code,message}` contract; application routes use `{ error: { code,message,requestId } }`.

The backend compensates for the pinned plugin's permissive verifier setting by checking the signed authenticator `userVerified` bit in both verification hooks before allowing persistence/session creation. Authentication options also explicitly request `userVerification: 'required'`.

## Validation

`apps/api/test/auth.test.ts` applies the auth migration to an isolated PGlite database and exercises real signed WebAuthn ceremonies against the pinned Better Auth routes. It covers registration, failed/abandoned onboarding, replay/expiry/origin rejection, required user verification, session invalidation, additional passkeys, guarded removal, and token hash/ownership/revocation behavior. Deploy-time browser rehearsal must also verify the actual frontend origin, RP ID, HTTPS certificates, and cookie topology on supported browsers/devices.
