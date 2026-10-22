# burn-rate

Minimal TypeScript monorepo using pnpm workspaces and Turborepo.

```text
apps/
  api/          Cloudflare Worker API, with TimescaleDB ingestion
  dashboard/    SvelteKit dashboard
  marketing/    Static Astro marketing site
packages/
  api-schema/   Shared Zod schemas and inferred TypeScript API types
  sdk/          Generated Hey API client and request-scoped Fetch helpers
  design-tokens/ Simpsons donut theme: CSS custom properties and TS tokens
```

## Activity credit planning

The [activity credit contract](docs/activity-credit-contract.md) defines ring-based
treat loans, calorie credit limits, activity repayment, and exclusive allocation
to the eligible loan due soonest. The [PR and implementation plan](docs/activity-credit-plan.md)
separates the lending scaffold from future feature work.

Draft type-only boundaries are exported from `@burn-rate/api-schema/activity-credit`.
The versioned [treat catalog](data/treats.json) is an empty scaffold pending sourced
entries and will seed the runtime catalog in TimescaleDB/Postgres. All application
data will use that single database. Scoring, lending, and repayment
behavior are not implemented.

## Development

Use Node.js 24 LTS and pnpm 12.11.2 (pinned in `package.json`).

```sh
pnpm install
pnpm dev
```

| App | Local URL |
| --- | --- |
| API | http://localhost:8787/health |
| Dashboard | http://localhost:5173 |
| Marketing | http://localhost:4321 |

Run an individual app with `pnpm --filter @burn-rate/api dev` (or `@burn-rate/dashboard` / `@burn-rate/marketing`).

```sh
pnpm check  # Type checking across the workspace
pnpm test   # Mapping, auth, crypto, persistence, route, and SDK checks
pnpm build  # Build frontends and bundle the Worker without deploying
pnpm generate  # Offline OpenAPI export and generated SDK
pnpm check:generated  # Detect tracked and untracked generated output drift
```

## API and databases

The Hono Worker exposes public `GET /health` and `/openapi.json`, Better Auth passkey endpoints under `/api/auth/*`, session-protected account/metric/sample reads, and ingestion-token management. Runtime Zod contracts live in `@burn-rate/api-schema`; `@burn-rate/sdk` is generated offline from those route contracts. See the [frontend SDK handoff](packages/sdk/README.md), [passkey contract](docs/auth-handoff.md), and [deployment instructions](docs/api-deployment.md).

TimescaleDB/Postgres is the planned single application database. Activity
observations use Timescale hypertables; users, treats, loans, decisions, balances,
and repayment allocations use regular Postgres tables in the same database.
Postgres transactions and constraints will enforce lending and repayment integrity.

External timeseries data is normalized and stored in TimescaleDB (Tiger Cloud service `ckjasrhdwa`, DEV). The Worker connects through a Hyperdrive binding (`TIMESERIES_DB`).

D1 is not used — TimescaleDB/Postgres is the single application database, and
the former D1 binding has been removed from the Worker configuration.

## Timeseries database

Schema lives in `apps/api/timescale/`. Fresh initialization creates the metric
registry, encrypted health storage, auth, and token tables directly with the
checksummed migration runner:

```sh
pnpm db:migrate
```

Load the intended `DATABASE_URL` or `DB_CONNECTION_STRING` privately;
`apps/api/.env` can supply the local operator connection and must never be
committed or exposed to the frontend. Timescale connections automatically use
the [bundled public CA](apps/api/certs/README.md) with certificate and hostname
verification. `DATABASE_CA_FILE` can override it for a different database CA.
Fresh initialization creates no plaintext sample table or daily aggregate.
Historical `001_init.sql` is not a fresh-install prerequisite. No legacy
ownership mapping, backfill, or destructive cutover is needed when no legacy
data exists. On 2026-10-22, inspection found 127 plaintext sample rows; the user
confirmed they were disposable and authorized their removal. The guarded
cleanup committed removal of `public.health_samples` and the empty
`public.health_daily` aggregate, removed their two legacy policies, preserved
the metric registry, and passed the deployment preflight. R2 objects were
unchanged. Pause exporters until the encrypted Worker is deployed: the old
Worker can still retain a plaintext R2 dump before its SQL write fails.
Encrypted application migrations and Worker deployment have not run as part of
this cleanup. The optional `pnpm db:cutover` applies only to an environment with
actual legacy data after verified owner-mapped encryption backfill. Follow the
[encryption operations runbook](docs/encryption-operations.md); migrations and
deployment run in order through the GitHub Actions deploy workflow on `main`.
Configure its `DB_CONNECTION_STRING` secret before merging; the Timescale CA is
included in the repo. `DATABASE_CA_PEM` is an optional override. A migration
failure blocks Worker deployment; successful files are recorded and skipped
on retry.

The development Hyperdrive ID is configured in `apps/api/wrangler.jsonc`. For a
new environment, create a Hyperdrive config pointed at its origin database and
update the `TIMESERIES_DB` binding's `id` with the ID returned by:

```sh
pnpm --filter @burn-rate/api exec wrangler hyperdrive create burn-rate-timeseries --connection-string="$TIMESERIES_DB_URL"
```

For local development, copy `.dev.vars.example` to `.dev.vars` and set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_TIMESERIES_DB` to the origin connection string; `wrangler dev` then connects directly, no Hyperdrive needed. Keep credentials in `.dev.vars` / Worker secrets, never in frontend environment variables.

## Ingest pipeline

`POST /hook` requires a user-bound ingestion bearer token and accepts the existing `health-exporter.v1` and metrics-export payloads. It authenticates before retention, applies payload/rate limits, redacts request credentials, and durably encrypts raw R2 dumps before mapping and encrypted sample upserts. Unknown formats receive the same encryption. Owner identity comes only from the token; explicit owner IDs are required throughout mapping. Retry/correction preserves logical sample IDs. Protected sample values and source/device identities are encrypted; metric/time metadata remains readable.

Use `pnpm --filter @burn-rate/api test` for the mapping and backend integration suite. The tests use embedded Postgres and cryptographic WebAuthn fixtures; real-device staging and representative Timescale migration/policy checks remain part of rollout.

The dashboard uses SvelteKit's automatic adapter until a hosting target is selected. The marketing site builds to static files. Cloud resources are configured separately from the local build.

Framework references: [Turborepo workspaces](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure), [Astro setup](https://docs.astro.build/en/install-and-setup/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
