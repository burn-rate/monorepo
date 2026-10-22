# Authenticated encrypted API deployment

This change uses the existing request-scoped `pg.Client` and Hyperdrive binding in
`apps/api/src/db.ts`. Each request acquires at most one connection, lazily, and
closes it in a `finally` block. Better Auth uses a Kysely facade over that client;
it does not create another pool. Migrations use the same factory. The user
explicitly authorized supplying missing database tooling after updating main.
No database or Cloudflare resource is provisioned by this change.

On 2026-10-22, inspection found 127 plaintext `health_samples` rows, an empty
`health_daily` aggregate, and no encrypted sample table. The user confirmed the
127 records were disposable and authorized removal. A guarded transaction
rechecked those counts under lock, removed `public.health_daily` and
`public.health_samples` with `RESTRICT`, and committed. Both relations and their
two legacy policies are absent; the metric registry count was preserved and
the deployment preflight passed. R2 objects were unchanged. No encrypted
application migrations or Worker deployment ran as part of this cleanup.

Pause exporters until the encrypted Worker is deployed. Removing SQL storage
does not stop the old Worker from writing plaintext R2 dumps before its SQL
write fails. Ownership mapping/backfill remains optional for other actual
legacy data that must be preserved. CI continues to block deployment while
plaintext sample rows remain.

## Configuration

The Worker sets `keep_vars: true` so deployments preserve plaintext variables
managed in the Cloudflare dashboard. Secrets are managed separately.
Set the following through the existing Worker deployment/secrets process. Never
put real secrets in Wrangler JSON, frontend environment variables, or Git.

| Input | Meaning |
| --- | --- |
| `DATABASE_URL` / `DB_CONNECTION_STRING` | Private operator connection; `apps/api/.env` can supply either name |
| `DATABASE_CA_FILE` | Optional CA PEM path override; Timescale connections use the bundled public CA by default with full certificate and hostname verification |
| `BETTER_AUTH_SECRET` | Independent Better Auth Worker secret with at least 32 characters |
| `BETTER_AUTH_URL` | Exact API origin: `https://api.burn-rate-app.workers.dev` in production |
| `DASHBOARD_URL` | Exact trusted dashboard origin: `https://app.burn-rate-app.workers.dev` in production |
| `PASSKEY_RP_ID` | Production RP domain: `burn-rate-app.workers.dev` |
| `PASSKEY_RP_NAME` | Display name for browser ceremonies; `Burn Rate` |
| `AUTH_COOKIE_SAME_SITE` | `lax` default; `none` requires HTTPS |
| `ENCRYPTION_ENVIRONMENT` | Stable, distinct staging/production identity authenticated with ciphertext |
| `HEALTH_KEK_ID` | Active wrapping-key version ID |
| `HEALTH_KEKS` | Secret JSON map of retained KEK IDs to 32-byte base64url keys |
| `MAX_UPLOAD_BYTES` | Default 5242880, maximum 26214400 bytes |
| `UPLOADS_PER_MINUTE` | Default 60 per token owner, maximum 10000 |
| `AUTH_ATTEMPTS_PER_MINUTE` | Default 10 per Cloudflare client IP, maximum 1000 |
| `TOKENS_PER_MINUTE` | Default 10 per session owner, maximum 100 |

The production API Worker is `api` and the dashboard Worker is `app`, at the
origins above. Both hosts use the account's `burn-rate-app.workers.dev` RP ID
and a same-site cookie topology. Use distinct staging origins, environment
names, secrets, and databases. Changing an RP ID after enrollment can strand
existing credentials. Local development uses `http://localhost:8787`,
`http://localhost:5173`, and RP ID `localhost`.

`AUTH_SECRET` and `AUTH_BASE_URL` remain compatibility aliases for the canonical
Better Auth inputs. `DASHBOARD_ORIGINS` remains a JSON-array alias for exact
trusted origins; normal deployment uses `DASHBOARD_URL`. The dashboard's public
`API_URL` must match `BETTER_AUTH_URL`. `HEALTH_KEKS` remains a separately
provisioned secret; the public environment/active-key IDs in Wrangler do not
supply wrapping-key material.

Cookies are HttpOnly and Secure on HTTPS. Browser SDK requests use
`credentials: 'include'`. CORS permits only exact configured origins, with
`Vary: Origin`; mutations also require an allowed Origin. Unrelated origins
receive no credentialed CORS permission. Personalized responses are `no-store`.
Protected data routes cannot be accessed with an ingestion bearer token.

## Hyperdrive freshness

Disable query caching on the `TIMESERIES_DB` Hyperdrive configuration before
using it for authentication, sessions, ingestion credentials, or encryption
keys. Cached reads can otherwise outlive revocation or key rotation. This API
uses one request-scoped client, so its configured Hyperdrive must be uncached.

```sh
pnpm --filter @burn-rate/api exec wrangler hyperdrive update 2985aac84d524fbdb926e35d5cdf3eb2 --caching-disabled
```

Inspect the configuration afterward and confirm caching is disabled. This
setting is managed on Hyperdrive, not by the Worker binding's ID. See
[Cloudflare's freshness guidance](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).

`wrangler dev --remote` can exercise Cloudflare's deployed Hyperdrive connection
without requiring the direct database CA on this machine. Use a dedicated
verification entry that touches only its own temporary schema. Hyperdrive uses
transaction pooling: set schema/timeout with `SET LOCAL` inside each explicit
transaction, or qualify all relations. The direct-Postgres test runner's
session-level `SET search_path` must not be reused unchanged through Hyperdrive.
The application liveness/diagnostic endpoints do not run migrations.

## GitHub Actions migrations

The deploy workflow runs `pnpm db:migrate:ci` from `apps/api` after checks/build
and the stale-main guard, immediately before `wrangler deploy`. Configure the
GitHub Actions database secret before merging; the CA override is optional:

| Secret | Meaning |
| --- | --- |
| `DB_CONNECTION_STRING` | Direct PostgreSQL connection to the same origin database used by the Worker's Hyperdrive binding; the account needs schema/Timescale migration permissions |
| `DATABASE_CA_PEM` | Optional trusted CA override as raw multiline PEM; the Timescale public CA is bundled in the repo |

CI does not read the local API `.env`, accept an ambient `DATABASE_URL`, or use
Hyperdrive for schema migrations. The local env file does not populate GitHub
secrets. Connections to `tsdb.cloud.timescale.com` and its subdomains use
[`certs/timescale-ca.pem`](../apps/api/certs/timescale-ca.pem) automatically.
The public CA and its fingerprint are committed alongside the code; there is
no support request or separate CA secret needed for the current service. See
[certificate provenance and rotation](../apps/api/certs/README.md).

For an alternate CA, set `DATABASE_CA_PEM` to raw PEM; neither a path on this
machine nor base64 text is a PEM secret. For example:

```sh
gh secret set DB_CONNECTION_STRING < /private/path/database-url.txt
# Optional override for another CA:
gh secret set DATABASE_CA_PEM < /private/path/database-ca.pem
```

The CI runner enforces server certificate and hostname verification. It writes
the optional CA to a temporary file with mode `0600` and removes it on success
or failure. Connection attempts and advisory-lock waits are bounded; the
migration step has a ten-minute timeout. Existing plaintext health sample rows,
missing configuration, connection failure, a changed applied-file checksum, or
any failed SQL stop the job before
Worker deployment. Connection strings and driver error details are not logged.

Only `000_metrics.sql`, `002_encrypted.sql`, `004_auth.sql`, and `005_limits.sql`
run automatically. `004` bootstraps or upgrades canonical `user`, `session`,
`account`, `verification`, and `passkey` tables, then adds server-owned
onboarding, passkey freshness, and ingestion credentials. Existing main auth
records use those same canonical tables; no parallel `auth_*` account store is
introduced. `packages/db` forwards its `db:migrate` command to this API runner;
its historical Drizzle baseline is retained unchanged, and `db:generate` is
offline metadata generation for review. A session advisory lock serializes migration clients, and
each file's SQL and checksum ledger entry commit in one transaction. Successful
files remain applied if a later migration or Worker deployment fails; rerunning
the job skips those files. Do not edit an applied file or automatically reverse
successful migrations. Add future schema changes in a new forward migration
and register it in `DEFAULT_MIGRATIONS`. Historical `001_init.sql` and destructive
`003_cutover.sql` are excluded from CI. The dashboard deploy job waits for the
API job to finish successfully, preserving migration-before-release ordering
for both Workers.

## Database ordering and rollout

1. Keep exporters paused until the encrypted Worker is deployed. Confirm the
   intended database's safe schema/count state; the current target's authorized
   disposable SQL records have already been removed as recorded above.
   The private connection in `apps/api/.env`
   is an operator input, not a frontend variable or committed artifact. Load it
   privately and never print credentials. If unexpected retained health data
   is discovered, stop the fresh-install path and use the optional legacy
   procedure in `encryption-operations.md`.
2. For local initialization or staging rehearsal, set `DATABASE_URL` or `DB_CONNECTION_STRING` for that target, or load it from
   `apps/api/.env`, and run `pnpm db:migrate`. Timescale uses the bundled CA;
   set `DATABASE_CA_FILE` only to override it with another trusted PEM file.
   The checksummed runner applies `000_metrics.sql`,
   `002_encrypted.sql`, `004_auth.sql`, and `005_limits.sql` in that order,
   creating the registry, encrypted sample/key tables, auth/token tables, and
   rate-limit storage.
   It must not create plaintext `health_samples` or `health_daily` on a fresh
   target. Do not run historical `001_init.sql` as a prerequisite. The normal
   runner does not execute destructive legacy cutover. Verify fresh
   initialization against the intended Timescale version before deployment.
3. Configure all auth/encryption variables and secrets. Keep required KEKs
   available. Database provisioning and Hyperdrive configuration are unchanged.
4. Rehearse the sequence below in staging. A fresh target needs no legacy
   ownership file or backfill job. Keep any old plaintext-writing Worker
   disabled before admitting new uploads.
5. Verify schema, policies, authenticated encryption, and isolated reads on the
   initialized target. Confirm the fresh path creates no readable health table
   or aggregate. Keep keys for encrypted records and backups created after
   launch; nonexistent legacy backups require no expiry evidence.
6. Skip `pnpm db:cutover` on a fresh target. It is a destructive, separately gated
   legacy command. If legacy data is found in another target, require verified
   owner mapping, resumable backfill, decryptability/coverage checks, and a
   reviewed removal operation before activating encrypted reads there.
7. Configure the GitHub Actions database secrets above and all required Worker
   settings before merging for deployment. The pipeline applies pending normal
   migrations and deploys the Worker only after they succeed. Complete migration
   verification and staging rehearsal, update exporters, and enable ingestion.
8. Schedule daily cleanup of `api_rate_limits` rows older than one day. Counters
   are stored in Postgres so quotas hold across concurrent Worker instances.

## Database verification

Run `pnpm test:database` to load the API `.env` privately and execute the real
Timescale migration/storage and independent-connection passkey locking checks.
The command accepts `DATABASE_URL` or `DB_CONNECTION_STRING`. Timescale uses the
bundled CA certificate; `DATABASE_CA_FILE` can override it with another trusted
PEM path. It never prints the
connection string. Tests create uniquely named temporary schemas, use synthetic
records, and remove only their own schemas/jobs. They do not migrate or modify
existing application tables. Ordinary `pnpm test` skips these two explicit
external checks when `TEST_DATABASE_URL` is absent.

## Staging rehearsal checklist

- Configure exact API/dashboard origins and RP ID; deny an unrelated origin.
- Complete passkey signup, sign-out, sign-in, and a second-passkey ceremony.
- Reject replayed, stale, unverified, or foreign-origin ceremonies. Concurrent
  removals must leave at least one usable credential.
- Obtain an ingestion token immediately after passkey verification; confirm its
  secret appears once. List metadata, revoke it, and reject subsequent uploads.
- Upload both existing exporter fixtures and an unknown/non-JSON payload.
  Inspect stored envelopes: no health values, source/device identities,
  credentials, or raw body may be readable in database/R2 exports.
- Use independent generated SDK clients for two accounts. Read only each
  account's observations, follow pagination, and reject mismatched cursors.
- Inject dump/sample failures: no false success; a retained encrypted dump
  permits retry; replay must converge without duplicate observations.
- Rotate a DEK and then a KEK; restore a retained backup with retained key
  versions and verify old/new records. Keep retired keys until both live data
  and recoverable backups no longer depend on them.
- Verify fresh initialization creates encrypted storage directly with no
  plaintext table/aggregate. For an environment with actual legacy data only,
  also resume interrupted backfill, resolve operator mappings, verify coverage,
  retire aggregates, and track actual legacy backup expiry separately.

## Exporter migration

`/hook` now accepts only `POST` with `Authorization: Bearer <ingestion-secret>`.
A browser session cannot upload. Obtain one credential per account through the
API after recent passkey verification; store it privately in the exporter.
Ownership supplied in body/query/other headers is ignored. Existing mappings
and interval/value semantics remain unchanged. A 401 requires replacing a
missing/revoked token; 413 requires a smaller payload; 429 includes
`Retry-After: 60`. A 502 means retry: an encrypted dump may already be retained
and sample batches are idempotent. Request headers/query credentials are never
retained, even inside encrypted raw dumps.

## Rollback

Rollback only to a release that understands encrypted envelopes and the same
key versions. Pause ingestion if needed. Never re-enable default-owner reads,
restore plaintext writing, drop wrapped keys, or discard failed encrypted dumps.
Restoring a snapshot containing legacy plaintext requires the owner-mapped
backfill and cutover gates before serving it. A fresh encrypted deployment has
no legacy snapshot to migrate. Keep any actual retained backups and their key
dependencies accounted for separately. This implementation performed the
authorized disposable SQL cleanup described above, without a Worker deployment.

## Verification boundary

Automated tests use embedded Postgres (PGlite), Web Crypto, real Better Auth,
and local HTTP requests. They do not emulate Timescale compression/partition
policies or execute Cloudflare staging ceremonies. Actual database inspection,
representative Timescale initialization, and real-device staging rehearsal
must be recorded separately from those automated checks. Legacy inventory,
ownership mapping, backfill, and expiry evidence apply when actual retained
legacy data must be preserved. The current target's 127 observed plaintext
rows were confirmed disposable by the user and removed in the committed
guarded cleanup; its legacy table and empty aggregate are absent. R2 objects
were unchanged, so SQL cleanup alone does not establish their encryption or
retention status. Exporters must remain paused until encrypted ingestion is
deployed.
The bundled CA removes the private-CA setup dependency for the current Timescale
service. A successful verified connection and live database tests are recorded
separately from local embedded-database checks.

On 2026-10-22, a verified direct connection succeeded against PostgreSQL 18.6
and TimescaleDB 2.31.0. The isolated-schema Timescale migration/compression/
rotation test and independent-connection passkey locking test both passed and
removed their temporary schemas/jobs. The desktop runtime's Electron child
launcher could not run the normal `pnpm test:database` subprocess, so these same
tests ran through Vitest's API in the current Node process. No application
tables or records were changed by verification.
