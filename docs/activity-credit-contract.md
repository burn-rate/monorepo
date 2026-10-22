# Activity credit contract

Status: draft product contract. This PR captures the agreed behavior and shared
data boundaries. It does not deliver a working lending system. Open decisions
below must be resolved before their dependent implementation.

## Purpose and scope

Users request a playful loan for a treat, such as a donut. The loan is denominated
in food kilocalories (kcal), has a term, and is repaid by meeting an activity
requirement within that term. A request can be approved or denied.

The game is an optional treat budget. Its approval is not a nutritional assessment
or a restriction on the user's ability to eat.

Only Apple Fitness ring-related data informs activity credit:

| Metric | Unit | Meaning |
| --- | --- | --- |
| Move energy | kcal | Active energy contributing to Move |
| Move time | minutes | Move value for accounts using time-based Move mode |
| Exercise | minutes | Qualifying Exercise time; not a count of walks |
| Stand | hours | Hours with at least one qualifying minute of standing and movement |

The data contract accommodates either Move mode; lending uses kcal in both modes.
Preserve daily goals, activity mode, local date, time zone, and pause status when
available. Heart rate, sleep, steps, and workout-specific walking data are outside
the agreed ring-only input scope. Stand hours must not be described as a count of
stand-up events or a minute-by-minute sitting timeline.

## Vocabulary

- **Credit score:** activity-based borrowing eligibility. Its formula and scale
  are not yet selected.
- **Credit limit:** maximum outstanding borrowed kcal permitted by the credit
  policy. The score-to-limit mapping is not yet selected.
- **Principal:** approved treat calories, preserved at approval.
- **Outstanding balance:** borrowed kcal that remain outstanding under the
  repayment accounting policy.
- **Available credit:** credit limit minus outstanding balance. Keep a negative
  result visible if a later limit reduction puts the account over its limit.
- **Term:** a positive whole number of days, weeks, or months, with an explicit
  start, deadline, and time zone.
- **Requirement:** a positive target for one ring metric over the term.
- **Allocation:** the record assigning qualifying activity exclusively to one loan.

## Treat catalog and approval

`data/treats.json` is a versioned seed/import scaffold for the catalog stored in
TimescaleDB/Postgres. Each entry identifies a treat, serving, calories in kcal, and
whether the amount is an estimate. Preserve a source URL where available. Catalog
population, import, and nutrition-source selection are future work; the initial
seed file is intentionally empty. Runtime catalog reads and writes use Postgres.

An application identifies the treat, term, and activity requirement. The future
approval policy evaluates the request against borrowing eligibility and available
credit. Approval creates one loan and reserves its principal against the limit.
Denial records a reason and creates no loan or debt. A repeated delivery of the
same request must not create another loan or reserve principal twice.

Approval preserves the treat name, serving, calories, term, requirement, decision
time, and credit-policy snapshot. Later edits to the catalog or lending policy
must not silently rewrite those terms.

Illustrative arithmetic, not a default policy or sourced nutrition value:

```text
Limit: 800 kcal; outstanding: 600 kcal; available: 200 kcal.
A request for 250 kcal exceeds available credit by 50 kcal.
```

## Repayment and loan priority

Meeting the agreed activity requirement within the term repays the loan. Food
calories and repayment activity are separate units: a 250 kcal treat does not
implicitly require burning 250 kcal. Terms can require Stand hours, Exercise
minutes, or the applicable Move metric. Walking counts only through the ring
metrics it contributes to; the system cannot identify walks from ring summaries.

For qualifying activity, select the unpaid eligible loan with the earliest
deadline. Eligibility requires that the activity satisfies the required metric
and occurred within the loan's term. An earlier-due Stand loan does not block
Exercise minutes from another eligible loan. For equal deadlines, prioritize the
oldest approval; use a stable loan ID if approval times also match.

Activity allocated to a loan is unavailable to every other loan. This applies
across overlapping ring metrics as well as repeated source records: the same
underlying activity must not repay one loan as Move and another as Exercise.
Ingestion must establish a canonical activity unit before allocation. Its exact
granularity and handling of partial units remain open decisions.

The repayment ledger must enforce exclusivity transactionally. Retrying a sync,
allocation, or progress calculation must preserve prior assignments and must not
create additional repayment credit. Progress is derived from valid allocations,
not an independently incremented counter that can drift from the ledger.

The intended statuses are active, repaid, and overdue. Overdue consequences,
correction-driven status transitions, and partial balance release are unresolved.

## Time-series contract

Store observations with user, metric, interval start/end, interval value, source
identity, resolution, and received time. Values represent amounts within an
interval, not repeatedly sampled cumulative totals. Importing cumulative payloads
requires normalization before repayment queries.

Preserve the actual source resolution. Daily summaries are a valid time series,
but do not establish exact activity timing within the day. Do not manufacture
minute-level readings from daily summaries. Daily and finer-resolution records
must not both contribute to the same total.

Activity occurrence time determines term eligibility, rather than upload time.
Use UTC instants for storage and retain the loan time zone for calendar terms.
Proposed boundary convention: start inclusive and deadline exclusive. Calendar
month arithmetic, daylight-saving behavior, and activity spanning a boundary must
be specified before implementing term evaluation.

Sync must support deduplication, corrections, deletions, and reconciliation of
affected allocations. Delayed activity within a term remains eligible for
evaluation; the finalization policy decides how late it may change a loan's
outcome. Missing data is unknown and must not automatically be treated as zero.

## Storage and shared boundaries

TimescaleDB is the single application database. It is Postgres with time-series
capabilities, so activity history and relational lending data share the same
database and transaction boundary.

- **Timescale hypertables:** interval activity observations and time-series
  histories such as credit snapshots, where time partitioning is appropriate.
  Exact partition keys, chunk intervals, and retention remain schema decisions.
- **Regular Postgres tables in the same database:** users, treat catalog, ring-goal
  metadata, loan requests, decisions, immutable approved terms, balances, canonical
  activity identities, and the authoritative exclusive-allocation ledger.
- **Postgres transactions and constraints:** enforce request idempotency, principal
  reservation, and exclusive allocation. Keep globally unique activity ownership
  in regular tables; hypertable uniqueness constraints include partition keys and
  must not weaken the rule that an activity unit belongs to only one loan.
- **JSON seed/import artifact:** `data/treats.json` initializes the Postgres catalog.
  Approved loans retain their own treat snapshots. The file is not a second runtime
  catalog or database.
- **`@burn-rate/api-schema/activity-credit`:** draft TypeScript data boundaries
  shared by future producers and consumers. These are type-only scaffolding;
  runtime validation and public endpoints are future work.

The existing Worker scaffold still declares a D1 binding and generic
`TIMESERIES_DB_URL` / `TIMESERIES_DB_TOKEN` placeholders. A later implementation
will replace the D1 storage path with a Postgres connection and define its actual
connection settings. This PR selects TimescaleDB and documents that transition;
it does not add a client, change bindings, run migrations, or provision a database.
Hosting, supported TimescaleDB version, Worker connection method, and retention
remain open implementation choices.

## Open decisions

1. Score inputs, weighting, scale, history window, cold-start behavior, and mapping
   from score to kcal limit. Sustained consistency is the proposed basis.
2. How treat size and credit history determine the offered activity target and term.
3. Whether partial repayment releases proportional credit or the principal remains
   outstanding until the full requirement is met.
4. Canonical allocation-unit granularity, whether a session can be split into
   distinct units, and excess activity after a requirement is satisfied. No design
   may credit the same unit to multiple loans.
5. Source/export format, overlapping metrics, source precedence, and the minimum
   resolution needed for precise loan boundaries. Coarse data must not be used to
   claim timing precision that it does not contain.
6. Calendar boundaries, late-sync finalization, correction/reallocation policy,
   and consequences of becoming overdue.
7. Missing/paused days, changed goals, cancellation, overrides, catalog sources,
   and user-entered treats.

## Reference documentation

- [Apple activity summaries](https://developer.apple.com/documentation/healthkit/hkactivitysummary)
- [Stand hours](https://developer.apple.com/documentation/healthkit/hkactivitysummary/applestandhours)
- [Time-interval quantity statistics](https://developer.apple.com/documentation/healthkit/hkstatisticscollectionquery)
- [Timescale hypertables alongside regular Postgres tables](https://www.timescale.com/learn/best-practices-for-postgresql-data-analysis)
- [Timescale hypertables and unique indexes](https://github.com/timescale/docs/blob/latest/use-timescale/hypertables/hypertables-and-unique-indexes.md)
