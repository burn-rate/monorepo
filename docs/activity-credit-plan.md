# Activity credit implementation and follow-up plan

The `useful-endpoints` change implements the first score and borrowing API:
`GET /score?timeZone=...`, `GET /loans`, and idempotent `POST /loans`. The
[contract](activity-credit-contract.md) records its runtime payloads and policy;
[OpenSpec tasks](../openspec/changes/useful-endpoints/tasks.md) track acceptance
and actual validation progress. This is source implementation, not a record of
live migration or deployment.

## Delivered scope

- Session-owned loan listing of all retained loans, newest first, with an empty
  array for accounts without loans and no required timezone query.
- Shared runtime schemas and offline OpenAPI/generated SDK operations, with
  nullable scores, raw-calorie requests and approved/denied response unions.
- Complete HealthExporter ring-summary revisions and deterministic authority,
  correction, calendar-zone and seven-completed-day selection.
- Exact decimal policy arithmetic, starter credit and visible negative credit.
- Encrypted summaries, immutable loan terms and durable original decisions in
  regular tables of the existing TimescaleDB/Postgres database.
- Per-owner serialized principal reservation, request idempotency and calendar
  deadlines; full principal stays reserved until authoritative full completion.
- Root-path browser sessions, trusted origins, credentialed idempotency-header
  preflights, safe errors, request IDs and connection cleanup.

The existing treat seed and future observation/allocation types are preserved.
They do not add catalog fields, week/month terms or selectable repayment metrics
to these endpoints. Move-kcal repayment is fixed by the server.

## Validation and rollout

The implementation has focused schema, mapping/policy, encrypted-persistence,
transaction, runtime-route and generated-consumer tests. Run the workspace
checks before release:

```sh
pnpm check
pnpm test
pnpm build
pnpm check:generated
```

Real PostgreSQL concurrency tests require an explicit disposable
`TEST_DATABASE_URL` and isolate their own schema. A skipped database test is not
concurrency evidence; consult the change's final test report for actual results.
Generation requires no live database, server, Worker bindings or secrets.

Apply checked migrations before the Worker update. Keep encrypted summaries,
loans, decisions, keys and full-principal reservations during rollback. Follow
the [operations runbook](encryption-operations.md) for migration, non-production
score/approval/denial/replay/conflict/preflight smoke tests and rollback. No new
database, destructive backfill, live infrastructure provisioning or automatic
repayment is authorized by this implementation change.

## Follow-up work

Automatic repayment is deferred. Before building it, establish canonical activity
units and exclusive allocation across overlapping Move/Exercise observations;
precise occurrence boundaries for coarse summaries; deterministic eligible-loan
priority; correction/reallocation and late-sync finalization rules; and an
authoritative fully-repaid transition. Partial progress must continue to release
no credit, and overdue principal must remain outstanding.

Dashboard UI, catalog population/nutrition sourcing,
user-entered treat helpers and operational product choices are separate work.
A catalog must remain optional for raw-calorie applications and must never
rewrite already approved terms.
