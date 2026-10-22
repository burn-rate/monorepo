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

External timeseries data will be read by the API. `apps/api/.dev.vars.example` reserves optional connection settings; copy it to `.dev.vars` when needed. The database vendor, client, and queries are intentionally left for later. Keep credentials in Worker secrets for deployment, never in frontend environment variables.

The dashboard uses SvelteKit's automatic adapter until a hosting target is selected. The marketing site builds to static files. No cloud resources are provisioned by this scaffold.

Framework references: [Turborepo workspaces](https://turborepo.dev/docs/crafting-your-repository/structuring-a-repository), [SvelteKit project structure](https://svelte.dev/docs/kit/project-structure), [Astro setup](https://docs.astro.build/en/install-and-setup/), and [Wrangler configuration](https://developers.cloudflare.com/workers/wrangler/configuration/).
