## Why

The frontend has authentication and health-data reads but no API for its core activity-credit experience. Define and deliver a consistent score/budget read and an idempotent calorie-loan decision so frontend work on another machine can use a concrete, generated contract.

## What Changes

- Add session-protected `GET /score?timeZone=<IANA-zone>` plus `GET /loans` and `POST /loans`, retaining these root paths rather than adding an `/api` prefix.
- Calculate ring consistency from partial daily goal completion, capped per ring and weighted equally across Move, Exercise, and Stand, within the last seven completed local calendar days. Use available usable days; missing history is unknown, not zero.
- Map consistency directly to a displayed score of 300–850, a linear 250–2,000 kcal credit limit, and an inverse linear 1.5×–1.05× repayment multiplier. An unknown score remains `null` with a 250 kcal limit and 1.5× multiplier. Repayment history does not affect the score.
- Accept a raw positive calorie amount, an integer `durationDays` from 1 through 30, and an IANA `timeZone`. Start approved loans immediately, fix their terms at approval, and express repayment targets in Move kcal. Duration does not change the multiplier.
- List all retained loans belonging to the signed-in account as `{ "loans": [...] }`, newest first, using the flat loan contract and without changing progress or status.
- Persist owner-bound approval/denial decisions and immutable loan terms in TimescaleDB/Postgres. Serialize approval with current outstanding principal and enforce request idempotency. Reserve the full principal until full repayment; partial progress releases no credit.
- Preserve the ring-summary metadata needed for trustworthy scoring and select authoritative summaries without adding detailed samples or duplicate sources to their totals. Keep health values and newly retained sensitive ring metadata encrypted.
- Extend existing session/origin/CORS handling to both root paths, including the `Idempotency-Key` preflight header. Publish shared runtime schemas, OpenAPI, generated SDK operations, and copyable frontend examples.
- Require subagents during implementation: delegate scoring/data normalization, loan persistence/transactions, API/SDK integration, and independent review in dependency order with explicit file ownership and an integrating lead.

This change covers score calculation, loan creation and owner-scoped listing, and the balance/lifecycle boundary. Automated activity allocation, repayment reconciliation, catalog features, and frontend UI are follow-up work. New loans begin with zero progress; this change must not fabricate repayment from raw imports or expose an unsecured repayment mutation.

## Capabilities

### New Capabilities

- `activity-credit-api`: Ring-derived score and budget reads, authenticated and idempotent calorie-loan decisions, fixed approved terms, full-principal reservation, and a generated frontend contract.

### Modified Capabilities

None. This repository has no existing OpenSpec capabilities. During implementation, reconcile the older draft activity-credit documentation and type-only boundaries with this narrower first API: raw calories replace a required treat, Move kcal are the offered repayment metric, terms are 1–30 days, and the policy choices above are settled.

## Impact

- API routing/security: `apps/api/src/routes.ts`, `apps/api/src/index.ts`, and new credit services, with existing session, error-envelope, connection-cleanup, and no-store conventions preserved.
- Health ingestion/storage: `apps/api/src/ingest/health-exporter.ts`, encrypted storage, and additive migrations through `apps/api/scripts/migrations.ts`; existing stored samples lack reliable scoring metadata and must not silently be assumed complete summaries.
- Persistence: new regular Postgres tables in the existing TimescaleDB database for ring-summary identity/metadata, loan decisions, approved terms, and concurrency coordination. No D1 or second application database.
- Contracts/tooling: `packages/api-schema`, `packages/db` metadata if needed for new relational queries, `openapi/openapi.json`, generated `packages/sdk` output, backend/SDK tests, and frontend handoff documentation. Reuse the offline generation pipeline and checked migration runner.
- `docs/activity-credit-contract.md` and its companion plan contain stale storage-transition text; reconcile those documents during implementation without changing live infrastructure in this planning change.
