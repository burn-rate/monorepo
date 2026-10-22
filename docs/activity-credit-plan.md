# Activity credit PR plan

## This PR

Capture the contract before implementing the game:

- [x] Document ring-only inputs, calorie-denominated borrowing, and activity-based
  repayment over day/week/month terms.
- [x] Document exclusive activity allocation and earliest-due eligible loan priority.
- [x] Define time-series provenance, interval semantics, deduplication, and late-data
  requirements.
- [x] Select one TimescaleDB/Postgres database for all application data, using
  hypertables for time-series data and regular tables for relational records.
- [x] Reuse `@burn-rate/api-schema` for a type-only contract subpath. A second shared
  package is unnecessary for these initial data boundaries.
- [x] Scaffold a versioned JSON treat catalog seed/import file without unsourced
  nutrition entries; the runtime catalog will live in Postgres.
- [x] Link the contract and plan from the repository README.

Scope excludes scoring algorithms, runtime validators, ingestion, migrations,
database clients, approval/repayment services, endpoints, UI, and infrastructure.

## Follow-up implementation sequence

### 1. Resolve policy and source questions

- [ ] Resolve the open decisions in the contract, especially partial balance
  release, allocation units across metrics, term boundaries, and late corrections.
- [ ] Inspect real ring-export payloads for source identity, resolution, corrections,
  and whether overlapping metrics can be attributed to exclusive activity units.
- [ ] Choose TimescaleDB hosting/version, Worker-to-Postgres connection method,
  migration tooling, partitioning, and retention. The database choice is settled.
- [ ] Choose catalog nutrition sources and seed common treats with explicit servings
  through the JSON import artifact into Postgres.

Exit condition: precise rules and source capabilities support every offered loan
requirement. Keep unsupported metrics or resolutions unavailable for repayment.

### 2. Formalize validation and persistence

- [ ] Add runtime schemas once validation rules are settled, preserving the draft
  shared package boundary where practical.
- [ ] Define observation identities, revisions/deletions, canonical activity units,
  and interval normalization.
- [ ] Add Postgres migrations for relational tables and Timescale hypertables in
  the same database, including transactional constraints for decisions, balances,
  exclusive allocations, and idempotency. Enforce globally unique activity ownership
  in regular tables independently of hypertable partition keys.
- [ ] Replace the scaffold's D1 binding/storage path and generic time-series
  placeholders with the chosen Postgres connection and development workflow.
- [ ] Define historical policy versions and immutable approved-term snapshots.

Exit condition: persistence can reject duplicate spending and reproduce a decision
or progress total from its stored evidence.

### 3. Implement ingestion and credit calculation

- [ ] Normalize ring observations into Timescale hypertables and persist historical
  goals in the same Postgres database.
- [ ] Implement deduplication, source precedence, corrections, and reconciliation.
- [ ] Implement versioned score calculation and kcal credit limits.
- [ ] Verify daily/finer aggregates do not double count and missing data stays unknown.

### 4. Implement lending and repayment

- [ ] Implement request decisions and atomic principal reservation.
- [ ] Allocate eligible activity by earliest deadline, then oldest approval, then ID.
- [ ] Enforce exclusivity across all overlapping ring metrics.
- [ ] Implement progress, repayment, overdue handling, and approved correction rules.
- [ ] Add user-facing loan requests, explanations, progress, and history after the
  accounting rules are verified.

## Review and validation

For this PR: review the contract against agreed decisions, parse the catalog as
JSON, and run the shared package check plus repository checks/build if dependencies
are available. The scaffold intentionally contains no production behavior to test.

Validation completed for this scaffold:

- `pnpm check` passed across all four workspace packages.
- `pnpm build` passed for the API and both frontends.
- The JSON catalog parses, the shared export resolves to an existing file, and
  the README documentation targets exist.

Required behavioral scenarios for subsequent implementation:

- Replaying an approved request reserves principal once; denial reserves none.
- Later catalog/goal changes do not mutate approved loan terms.
- Activity picks the earliest-due eligible loan and uses deterministic tie-breaks.
- A metric mismatch does not block another eligible loan.
- Concurrent allocation and repeated imports cannot credit a unit twice, including
  across Move and Exercise observations of the same activity.
- Concurrent approvals and allocations preserve balances and unique activity
  ownership within Postgres transactions, including across hypertable time chunks.
- Pre-term and post-deadline activity do not repay a loan; boundary cases follow
  the agreed calendar policy.
- Activity uploaded after the deadline is evaluated by occurrence time under the
  agreed finalization policy.
- Coarse summaries, overlapping aggregates, deletions, corrections, and unknown data
  cannot create unsupported repayment credit.

These scenarios are a plan for future tests, not implemented capabilities.
