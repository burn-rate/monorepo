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

The source API also exposes `getScore`, `listLoans` and `createLoan` at the root paths
`/score` and `/loans`. Deploy the checked migrations and Worker before using
these operations in an environment. This example works with the client above:

```ts
import { getScore, listLoans, createLoan } from '@burn-rate/sdk';

const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const score = await getScore({ client, query: { timeZone } });
if (score.error) throw new Error(score.error.error.message);
// score.data?.score is number | null. Show unknown history separately from 300.
console.log(score.data?.score, score.data?.availableKcal);

const history = await listLoans({ client });
if (history.error) throw new Error(history.error.error.message);
console.log(history.data?.loans); // [] when no loans are retained.

// Persist the key and body with the UI's pending application before sending.
// Reuse both after a network failure; create a fresh key for a new application.
const applicationKey = crypto.randomUUID();
const application = { amountKcal: 200, durationDays: 7, timeZone };
const decision = await createLoan({
  client,
  headers: { 'idempotency-key': applicationKey },
  body: application,
});
if (decision.error) throw new Error(decision.error.error.message);
if (decision.data?.outcome === 'denied') {
  console.log(decision.data.message, decision.data.credit.availableKcal);
} else if (decision.data?.outcome === 'approved') {
  console.log(decision.data.loan.repaymentTargetKcal, decision.data.loan.dueAt);
}
```

`getScore` requires an IANA zone and returns the flat credit snapshot. Known
50% consistency gives score 575, limit 1125 and multiplier 1.275. No usable
history gives `score: null`, limit 250 and multiplier 1.5. The complete known,
unknown, approval, denial and error JSON examples are in the
[activity credit contract](../../docs/activity-credit-contract.md).

`listLoans` sends `GET /loans` with no required query or idempotency header. It
returns `{ loans }` containing every retained session-owned loan, newest first
by creation time then ID descending, using the approval loan shape.

`createLoan` accepts a positive finite `amountKcal`, integer `durationDays` from
1 through 30, and IANA `timeZone`. No owner, treat or client-selected terms belong
in the body. Its `Idempotency-Key` header is required; the generated options use
the lowercase spelling shown above, which HTTP treats case-insensitively.
Approval returns `201` with `{ outcome: 'approved', loan, credit }`; a new
200-kcal loan at 1.275 has target 255 Move kcal, progress zero and full 200-kcal
principal outstanding. Insufficient credit returns `200` with
`{ outcome: 'denied', loan: null, reason: 'insufficient-credit', message, credit }`.
Inspect `outcome` rather than treating every successful status as approval.

A same-owner key with the same validated body replays the original status,
loan, timestamps and credit snapshot, including a denial after credit improves.
A changed body under an existing key returns `409`. A new intended application
needs a new key. Display server-returned terms, balances and deadlines: accounting
uses exact decimals, and deadlines use local calendar days across DST. Do not
recalculate them from the displayed rounded score or JavaScript arithmetic.

Full unpaid principal remains reserved until authoritative full repayment;
partial progress releases none, and available credit can be negative after a
limit reduction. Automatic repayment, activity allocation, overdue processing
and completion mutations are deferred. Imports and elapsed time do not fabricate
progress or release the reservation.

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
or verification requirements, 404 for missing credentials, 409 for a changed idempotency payload, 429 for throttling,
and 503 for retryable service failure. Better Auth has its own error contract.
Token creation returns `{ token, secret }`; the secret appears only once.
Credential lists contain lifecycle metadata and no secret. Revocation is
idempotent for an owned credential and returns `{ revoked: true }`.

Exporter `POST /hook` is documented in OpenAPI under separate bearer security
and intentionally omitted from the dashboard package's exported operations.
An ingestion token grants upload access only; browser cookies do not authorize
uploads. Existing exporters must switch to POST and their user-bound token.
