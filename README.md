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

## Activity credit planning

The [activity credit contract](docs/activity-credit-contract.md) defines ring-based
treat loans, calorie credit limits, activity repayment, and exclusive allocation
to the eligible loan due soonest. The [PR and implementation plan](docs/activity-credit-plan.md)
separates this planning scaffold from future feature work.

Draft type-only boundaries are exported from `@burn-rate/api-schema/activity-credit`.
The versioned [treat catalog](data/treats.json) is an empty scaffold pending sourced
entries and will seed the runtime catalog in TimescaleDB/Postgres. All application
data will use that single database. Scoring, ingestion, lending, and repayment
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

The current scaffold still declares a D1 binding as `env.DB` and reserves generic
`TIMESERIES_DB_URL` / `TIMESERIES_DB_TOKEN` placeholders in
`apps/api/.dev.vars.example`. Replacing that binding and choosing the Postgres
client, connection settings, hosting, and migration workflow are follow-up work
in the [implementation plan](docs/activity-credit-plan.md). This planning PR does
not wire either database into the activity-credit feature. Keep credentials in
Worker secrets for deployment, never in frontend environment variables.

The dashboard uses SvelteKit's automatic adapter until a hosting target is selected. The marketing site builds to static files. No cloud resources are provisioned by this scaffold.

Framework references: [Turborepo workspaces](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure), [Astro setup](https://docs.astro.build/en/install-and-setup/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
