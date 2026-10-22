# burn-rate

Minimal TypeScript monorepo using pnpm workspaces and Turborepo.

```text
apps/
  api/          Cloudflare Worker API, with a D1 binding
  dashboard/    SvelteKit dashboard
  marketing/    Static Astro marketing site
packages/
  api-schema/   Shared Zod schemas and inferred TypeScript API types
```

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

D1 is the primary database, available as `env.DB`. Wrangler uses a local database during development. Before deploying, create a real database and replace the all-zero `database_id` in `apps/api/wrangler.jsonc` with the ID returned by:

```sh
pnpm --filter @burn-rate/api exec wrangler d1 create burn-rate
```

Add SQL migrations to `apps/api/migrations/` as the data model takes shape, then apply them locally with:

```sh
pnpm --filter @burn-rate/api exec wrangler d1 migrations apply DB --local
```

External timeseries data is normalized and stored in TimescaleDB (Tiger Cloud service `ckjasrhdwa`, DEV). The Worker connects through a Hyperdrive binding (`TIMESERIES_DB`).

## Timeseries database

Schema lives in `apps/api/timescale/`. Apply the init script with psql:

```sh
psql "$TIMESERIES_DB_URL" -f apps/api/timescale/001_init.sql
```

It creates the `metrics` registry, the `health_samples` hypertable (dedup key: `user_id, metric, time, ended_at, source_name`), columnstore policies, and the `health_daily` continuous aggregate.

Before deploying, create a Hyperdrive config pointed at the origin database and replace the all-zero `id` in `apps/api/wrangler.jsonc` with the ID returned by:

```sh
pnpm --filter @burn-rate/api exec wrangler hyperdrive create burn-rate-timeseries --connection-string="$TIMESERIES_DB_URL"
```

For local development, copy `.dev.vars.example` to `.dev.vars` and set `WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_TIMESERIES_DB` to the origin connection string; `wrangler dev` then connects directly, no Hyperdrive needed. Keep credentials in `.dev.vars` / Worker secrets, never in frontend environment variables.

## Ingest pipeline

`POST /hook` accepts health payloads in either known shape — `health-exporter.v1` batches (`{schemaVersion, samples: [...]}`) or metrics exports (`{data: {metrics: [...]}}`). The pipeline dumps the raw payload to R2 (lineage), detects the format, maps it to the normalized sample schema in `@burn-rate/api-schema` (unknown metrics are dropped and logged), and upserts into `health_samples`. Run the mapping tests with:

```sh
pnpm --filter @burn-rate/api test
```

The dashboard uses SvelteKit's automatic adapter until a hosting target is selected. The marketing site builds to static files. No cloud resources are provisioned by this scaffold.

Framework references: [Turborepo workspaces](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure), [Astro setup](https://docs.astro.build/en/install-and-setup/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
