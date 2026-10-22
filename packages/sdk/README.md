# Burn Rate SDK

Run `pnpm generate` from the repository root after editing the source Zod schemas
or Hono route contracts. Commit `openapi/openapi.json` and every file in
`packages/sdk/src/generated`; generated files must never be edited directly.
`pnpm check:generated` regenerates offline and rejects tracked changes and new
untracked generated files. No Worker bindings, database, server, or secrets are
needed. Tool versions are pinned in the root/API package manifests and lockfile.

```ts
import { createClient, createConfig, listHealthSamples } from '@burn-rate/sdk';

const client = createClient(createConfig({
  baseUrl: 'https://api.burn-rate-app.workers.dev',
  credentials: 'include',
  fetch: globalThis.fetch,
}));
const { data, error, response } = await listHealthSamples({
  client,
  query: {
    metric: 'heart_rate',
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-02T00:00:00Z',
    limit: 100,
  },
});
```

The browser must use the configured trusted dashboard origin. Protected application
operations require the Better Auth session cookie. Configure API origin, RP ID,
cookie topology, and Better Auth trusted origins together before registering
production passkeys. Browser WebAuthn onboarding, sign-in, and credential
management use Better Auth's `passkeyClient`, not this generated SDK. There is
no password or email recovery path. The dashboard posts `{ email, name }` to
`/api/auth/onboarding/context` with credentials included and supplies the
returned opaque context to `addPasskey({ context, createSession: true })`.
Email is persisted only after verified registration; unsigned JSON context is
rejected. Production uses dashboard `https://app.burn-rate-app.workers.dev`,
API `https://api.burn-rate-app.workers.dev`, and RP ID
`burn-rate-app.workers.dev`. Canonical API settings are `BETTER_AUTH_URL`,
`DASHBOARD_URL`, and secret `BETTER_AUTH_SECRET`; the dashboard's public
`API_URL` points to the API origin. Token creation and passkey removal require
passkey verification within five minutes; keep at least one usable passkey.

For SSR, construct a new client for each incoming request. Configure a fixed,
trusted API base URL and forward only that request's relevant session cookie in
the client's `headers`. Never copy cookies to an arbitrary caller-supplied URL
or call `setConfig` on a shared singleton with a user's session. Supplying the
client on every SDK operation keeps concurrent users' session context isolated.

Sample queries require a supported metric and offset-qualified `from` and `to`
timestamps. The interval is `[from,to)` and at most 31 days. The default page
size is 100, with a maximum of 500. Responses contain `{ items, nextCursor }`;
an empty history has `items: []` and `nextCursor: null`. Pass the next cursor
with the same filters for continuation. Cursors are opaque and owner-bound;
concurrent imports do not provide snapshot isolation. Values are domain values,
and dates remain ISO timestamp strings. Responses never include key envelopes
or dump locations.

Application errors have `{ error: { code, message, requestId } }`. Handle 400
for invalid parameters/cursors, 401 for missing/expired sessions, 403 for origin
or verification requirements, 404 for missing credentials, 429 for throttling,
and 503 for retryable service failure. Better Auth has its own error contract.
Token creation returns `{ token, secret }`; the secret appears only once.
Credential lists contain lifecycle metadata and no secret. Revocation is
idempotent for an owned credential and returns `{ revoked: true }`.

Exporter `POST /hook` is documented in OpenAPI under separate bearer security
and intentionally omitted from the dashboard package's exported operations.
An ingestion token grants upload access only; browser cookies do not authorize
uploads. Existing exporters must switch to POST and their user-bound token.
