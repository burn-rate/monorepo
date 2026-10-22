# burn-rate

Minimal TypeScript monorepo using pnpm workspaces and Turborepo.

```text
apps/
  api/          Cloudflare Worker API, with TimescaleDB ingestion
  dashboard/    SvelteKit dashboard
  marketing/    Static Astro marketing site
packages/
  api-schema/   Shared Zod schemas and inferred TypeScript API types
  db/           Shared Drizzle schema (auth + health tables) and migrations
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
pnpm build  # Build frontends and bundle the Worker without deploying
```

## API and databases

The Worker exposes `GET /health` as a starter route. Its response schema and TypeScript type live in `@burn-rate/api-schema`, which both the API and dashboard can import directly. Workspace source is bundled by the consuming app, so the shared package needs no separate build step.

TimescaleDB/Postgres is the planned single application database. Activity
observations use Timescale hypertables; users, treats, loans, decisions, balances,
and repayment allocations use regular Postgres tables in the same database.
Postgres transactions and constraints will enforce lending and repayment integrity.

External timeseries data is normalized and stored in TimescaleDB (Tiger Cloud service `ckjasrhdwa`, DEV). The Worker connects through a Hyperdrive binding (`TIMESERIES_DB`).

D1 is not used — TimescaleDB/Postgres is the single application database, and
the former D1 binding has been removed from the Worker configuration.

## Authentication

Auth is **passkey-only** (WebAuthn, no passwords), powered by [Better Auth](https://better-auth.com) with the `@better-auth/passkey` plugin. The auth server lives in the API and mounts Better Auth at `/api/auth/*`; the dashboard talks to it cross-origin with `createAuthClient` from `better-auth/svelte`.

- **Sign-up**: passkey-first — the client forwards an unsigned `{ email, name }` context and the server creates the account only if the email is new (an existing email can never gain a passkey from an unsigned context), then the WebAuthn ceremony runs and a session cookie is set.
- **Sign-in**: `authClient.signIn.passkey()` against the same account.
- **Storage**: Better Auth tables (`user`, `session`, `account`, `verification`, `passkey`) live in the same TimescaleDB/Postgres instance, migrated with drizzle-kit from `packages/db`.

Schema for auth tables is generated into `packages/db/src/schema/auth.ts` (do not hand-edit; regenerate after changing plugins) and migrated with:

```sh
set -a; source .env; set +a
DATABASE_URL="$DB_CONNECTION_STRING" pnpm --filter @burn-rate/db db:migrate
```

To regenerate the auth schema after changing the Better Auth config:

```sh
pnpm dlx auth@latest generate --adapter drizzle --dialect postgresql \
  --config apps/api/auth.generate.ts --output packages/db/src/schema/auth.ts -y
```

Required env vars: `BETTER_AUTH_SECRET` (Worker secret / `.dev.vars`, see `apps/api/.dev.vars.example`) and `API_URL` on the dashboard (see `apps/dashboard/.env.example`). In production, set `DASHBOARD_URL` on the Worker to the dashboard origin — it drives both CORS and Better Auth's `trustedOrigins`. The WebAuthn RP ID defaults to `localhost` in dev; production must serve the API and dashboard from the same registrable domain (e.g. `api.example.com` + `app.example.com`, RP ID `example.com`).

## Timeseries database

Schema lives in `apps/api/timescale/`. Apply the init script with psql:

```sh
psql "$TIMESERIES_DB_URL" -f apps/api/timescale/001_init.sql
```

It creates the `metrics` registry, the `health_samples` hypertable (dedup key: `user_id, metric, time, ended_at, source_name`), columnstore policies, and the `health_daily` continuous aggregate.

The development Hyperdrive ID is configured in `apps/api/wrangler.jsonc`. For a
new environment, create a Hyperdrive config pointed at its origin database and
update the `TIMESERIES_DB` binding's `id` with the ID returned by:

```sh
pnpm --filter @burn-rate/api exec wrangler hyperdrive create burn-rate-timeseries --connection-string="$TIMESERIES_DB_URL"
```

For local development, copy `.dev.vars.example` to `.dev.vars` and set `CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_TIMESERIES_DB` to the origin connection string; `wrangler dev` then connects directly, no Hyperdrive needed. Keep credentials in `.dev.vars` / Worker secrets, never in frontend environment variables.

## Ingest pipeline

`POST /hook` accepts health payloads in either known shape — `health-exporter.v1` batches (`{schemaVersion, samples: [...]}`) or metrics exports (`{data: {metrics: [...]}}`). The pipeline dumps the raw payload to R2 (lineage), detects the format, maps it to the normalized sample schema in `@burn-rate/api-schema` (unknown metrics are dropped and logged), and upserts into `health_samples`. Run the mapping tests with:

```sh
pnpm --filter @burn-rate/api exec vitest run
```

The dashboard uses SvelteKit's automatic adapter until a hosting target is selected. The marketing site builds to static files. Cloud resources are configured separately from the local build.

## Deployment

Both apps deploy to Cloudflare Workers in the `Burn Rate` account (`888e…`) on push to `main` via `.github/workflows/deploy.yml`:

| App | Worker | URL |
| --- | --- | --- |
| API | `api` | https://api.burn-rate-app.workers.dev |
| Dashboard | `app` | https://app.burn-rate-app.workers.dev |

The WebAuthn RP ID is `burn-rate-app.workers.dev` (the account's workers.dev subdomain), which covers both hosts — required for the cross-origin passkey + session-cookie flow. Cross-origin config lives in each app's `wrangler.jsonc` `vars`: the API carries `DASHBOARD_URL`, `BETTER_AUTH_URL`, and `PASSKEY_RP_ID`; the dashboard carries `API_URL`. `BETTER_AUTH_SECRET` is a Worker secret (rotate with `wrangler secret put BETTER_AUTH_SECRET`).

Note: workers.dev subdomains are effectively immutable — they can be deleted and re-claimed (`DELETE`/`PUT` on the Cloudflare `workers/subdomain` API), which breaks all existing URLs. Migrating to custom domains later means updating those vars and the RP ID together.

Framework references: [Turborepo workspaces](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure), [Astro setup](https://docs.astro.build/en/install-and-setup/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
