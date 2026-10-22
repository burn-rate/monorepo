## Context

See `proposal.md` for the motivation and product scope. The API already has session-bound Hono/OpenAPI routes, shared Zod schemas, offline SDK generation, Hyperdrive access to TimescaleDB/Postgres, and per-owner encrypted health storage. It has no implemented credit policy, lending tables, or repayment service.

`apps/api/src/ingest/health-exporter.ts` currently expands an activity summary into separate metric rows. It retains values and goals but discards the source local date, time zone, Move mode, pause state, and explicit summary identity needed for scoring. The encrypted sample identity deduplicates a metric/source/interval; it does not establish authority between daily totals and detailed samples. Existing rows therefore cannot be assumed to be complete scoring evidence.

`apps/api/src/crypto.ts` authenticates owner, record kind, identity, and query metadata, but currently recognizes only sample/dump records and a small set of HMAC domains. Its first-use key provisioning starts and commits its own transaction. Browser/session/CORS handling in `apps/api/src/index.ts` currently recognizes `/api/*` and `/timeseries/health`, so root credit paths require explicit integration.

This design is needed because the change crosses health normalization, encrypted persistence, concurrent loan accounting, browser security, and generated contracts. TimescaleDB/Postgres remains the only application database. D1 is prohibited.

## Goals / Non-Goals

**Goals:**

- Make a score read and loan decision reproducible from a single owner-bound set of evidence, a named policy version, and deterministic decimal/time rules.
- Prevent concurrent requests, retries, or a changed score from duplicating a loan or overspending available principal.
- Preserve whole authoritative summary revisions and protect new sensitive metadata, terms, and replay bodies with the existing encryption boundary.
- Produce one shared runtime contract for handlers, OpenAPI, the SDK, tests, and frontend examples.
- Give implementation subagents explicit ownership and integration boundaries so concurrency does not create competing schemas or transaction implementations.

**Non-Goals:**

- Deriving repayment credit from imported activity, reconciling corrections into repayment allocations, or building automatic repayment/overdue processing.
- Reconstructing source metadata by guessing from old samples or reinterpreting a daily total in a different calendar zone.
- Adding a treat catalog dependency, frontend screens, another database, or live infrastructure provisioning.
- Exposing a public mutation that marks a loan repaid. New loans have zero progress until a later authoritative completion mechanism exists.

## Decisions

### 1. Share a credit snapshot between reads and decisions

Keep the proposed handoff paths: session-protected `GET /score?timeZone=<IANA-zone>` plus `GET /loans` and `POST /loans`. The POST body is `{ amountKcal, durationDays, timeZone }` and requires `Idempotency-Key`. Account identity comes only from the authenticated session; payloads cannot select an owner.

`GET /loans` returns `200` with `{ loans: Loan[] }`, containing all retained loans owned by the authenticated session, ordered by approval time descending and opaque ID descending. It requires no query or idempotency key. Use a single owner-filtered SQL read and an already loaded keyring; decrypt and validate every returned envelope before releasing any response. Include active, overdue and authoritatively repaid fixtures, with full principal outstanding until fully repaid and zero thereafter. Preserve authoritative stored progress/status; listing never fabricates repayment or changes a loan. Empty history returns `{ loans: [] }`; authentication, storage and decryption errors retain the existing envelope. Stable operation IDs are `getScore`, `listLoans` and `createLoan`; the old singular POST path is removed.

Define a shared runtime credit snapshot with `score`, `creditLimitKcal`, `outstandingKcal`, `availableKcal`, `repaymentMultiplier`, `historyDays`, `timeZone`, `calculatedAt`, and `policyVersion`. The GET response is that flat snapshot. POST approval returns `{ outcome: 'approved', loan, credit }` with HTTP 201; insufficient available credit returns `{ outcome: 'denied', loan: null, reason: 'insufficient-credit', message, credit }` with HTTP 200 and creates no loan. Both use the same snapshot schema. Keep the handed-off loan shape flat: `id`, `status`, `principalKcal`, `outstandingKcal`, `repaymentMetric: 'move_kcal'`, `repaymentMultiplier`, `repaymentTargetKcal`, `repaymentProgressKcal`, `durationDays`, `timeZone`, `startsAt`, `dueAt`, and `policyVersion`. Approval starts with `status: 'active'`, `repaymentProgressKcal: 0`, and the entire principal outstanding.

Use the existing API error envelope for invalid input (400), missing session (401), untrusted origin/preflight (403), conflicting idempotency payload (409), applicable existing rate limits (429), and unavailable storage/encryption (503). No-history starter behavior is a successful credit calculation; a query/decryption failure must never be converted into starter credit. Preserve `Cache-Control: no-store`, request IDs, safe error text, and connection cleanup.

These HTTP/field choices are proposed technical defaults from the frontend handoff, not additional user-confirmed product policy. Implementation makes them concrete in Zod/OpenAPI and examples together. Reuse `credentials: 'include'` for browser calls and allow `Idempotency-Key` in trusted preflight handling for the root paths.

Rationale: a common snapshot avoids divergent approval and dashboard arithmetic and gives a remote frontend a complete contract. Alternatives considered: a score-only GET would require another balance/rate read; an `/api` prefix would change the handoff paths; using an HTTP error for a valid denial would mix business outcomes with transport failures.

### 2. Score complete source summaries without synthesizing missing evidence

Add a normalized ring-summary boundary alongside existing metric samples. Preserve the export's top-level `createdAt` as the source revision timestamp, separately from server receipt time. A usable day requires one complete authoritative HealthExporter activity summary containing all three rings' nonnegative actuals, positive goals for the selected Move mode and the other rings, explicit Move mode, source local date, valid source IANA time zone, explicit pause state, source identity, source record identity, interval bounds, and valid revision provenance. The selected Move metric may be kcal or minutes for scoring. An actual value of zero is known evidence; an absent value or goal is unknown. `paused: true` excludes the day. Unknown required metadata makes the day unusable.

Use the seven completed local calendar dates preceding the evaluation date in the requested zone, and include only summaries whose original source zone/calendar boundaries match that zone. Match canonical equivalent IANA zone identifiers; do not shift a total from one source day to a different requested day. Current-day activity is excluded. A usable summary is a whole revision: never combine an actual from one revision with a goal from another, and never add detailed observations, cumulative samples, or another source's total to it.

Proposed authority default: rank recognized Apple Fitness source identity first (`com.apple.Fitness`, with normalized `Apple Fitness` name as the fallback identity), then rank other source identities lexically. Within one owner/source/local-date/source-zone identity, order whole revisions by exporter `createdAt`, then by a stable owner-bound HMAC of canonical summary content. Select the source and latest whole revision before testing usability. A retry of an old batch retains its older source timestamp and cannot replace a newer correction merely because it arrived later; equal-timestamp/content retries converge. Atomic upserts must compare this revision tuple rather than unconditionally overwrite on receipt.

Persist a newer paused or incomplete summary as a whole revision or internal invalidation record even when it cannot contribute a score. An unusable winning revision makes the day unknown/excluded; do not resurrect an older usable revision or switch to a lower-priority source to fill its fields. Missing or invalid revision provenance is retained as an unknown/quarantined summary for its identifiable logical day, never promoted into scoring evidence. An omitted record in a later incremental batch is not a deletion. The current exporter defines no deletion event, so this change does not invent a public tombstone payload or inferred deletion semantics. This authority rule and preservation of invalidations are implementation defaults for source correction safety; repayment reconciliation remains outside scope.

For each usable day, calculate `min(actual / goal, 1)` for Move, Exercise, and Stand and average the three equally. Average the resulting daily values across usable days in the window. `historyDays` is their count, from 0 through 7. Fewer than seven usable days does not prevent borrowing. With none, consistency and displayed score are unknown. Repayment history, detailed samples, and excess progress above a ring goal never affect consistency.

Rationale: source summaries provide paired daily goals and ring totals, while capping preserves partial effort without allowing one exceptional day to offset inactivity elsewhere. Alternatives considered: binary ring closure discards partial progress; all-rings-closed days add a harsher bottleneck; summing imported samples and summaries double counts; treating absent days as zero invents evidence.

### 3. Use deterministic policy arithmetic with exact internal decimal accounting

For known consistency `c` in `[0, 1]`, use:

```text
score                 = round half up to an integer of 300 + 550 * c
creditLimitKcal       = floor to 6 decimal places of 250 + 1750 * c
repaymentMultiplier   = round half up to 6 decimal places of 1.5 - 0.45 * c
availableKcal         = creditLimitKcal - outstandingKcal
```

For unknown consistency return `score: null`, `creditLimitKcal: 250`, `repaymentMultiplier: 1.5`, and `historyDays: 0`. Calculate limit and multiplier from underlying consistency, not the rounded displayed score. Keep negative available credit visible if a later score reduction lowers the limit below outstanding principal. A new request is approved only when its entire principal fits available credit.

Accept any positive finite JSON number for `amountKcal`, with no additional decimal-place restriction. Its principal is the canonical decimal representation of the validated parsed JavaScript number, including exponent notation when needed; this does not promise preservation of arbitrary precision in the original JSON token. Use decimal/rational arithmetic internally for ratios, rounding, stored principal, balance sums, and comparisons. Avoid binary floating-point accounting and fixed-scale principal columns. The approved repayment target is the exact finite decimal product of principal and the stored six-place multiplier, without another target rounding step.

Store the policy version and immutable approved multiplier/target. Continue numeric wire fields for the frontend contract; clients display server-returned terms/balances and must not reconstruct authoritative accounting from rounded scores or JavaScript arithmetic. Tests cover tiny finite inputs, fractional principals, rounding boundaries, equality with available credit, and maximum-limit cases. The precision rules above are proposed implementation defaults that make the accepted linear policy deterministic.

Rationale: rounded score display is intentionally playful; actual principal reservation must remain exact and repeatable. Alternatives considered: deriving rates from rounded score introduces display-dependent jumps; rounding principal to whole/two-place kcal adds an unrequested input restriction; binary arithmetic can approve or reject an exact boundary incorrectly.

### 4. Fix calendar terms at approval

Validate integer `durationDays` in `[1, 30]` and a real IANA zone, canonicalize the zone, and capture a single approval instant after acquiring the owner's accounting lock. Set `startsAt` to that instant. Add the requested number of local calendar days at the approval's local clock time to obtain `dueAt`, using compatible DST disambiguation: move a nonexistent local clock time forward across the gap and select the earlier occurrence for an ambiguous clock time. Store UTC instants together with duration and zone. Use a Workers-compatible Temporal implementation/polyfill if the runtime cannot supply these operations reliably.

Term eligibility is start-inclusive and deadline-exclusive for later repayment work. Duration does not enter consistency, the limit formula, or the multiplier. A replay returns the original term rather than restarting its clock. Calendar behavior is a proposed technical default, not a new product gate.

Rationale: calendar days match the local-day scoring vocabulary and preserve a clear repayment deadline across DST. Alternatives considered: adding `durationDays * 24h` changes the local clock at DST; delegating date arithmetic to a client allows inconsistent or manipulated approved terms.

### 5. Add regular Postgres records and extend the encryption boundary

Use additive regular Postgres tables in the existing database for ring-summary identities/revisions, owner accounting coordination, idempotent loan decisions, and immutable loans. These are relational records with owner/global uniqueness requirements, not Timescale hypertables. Keep existing encrypted metric ingestion and its hypertable intact. Add deployment DDL through a new checked SQL migration and the existing `apps/api/scripts/migrations.ts` runner; add Drizzle metadata only where useful for queries.

Persist minimal query metadata such as owner IDs, opaque record IDs, authenticated timestamps, deterministic identity digests, and envelope versions outside encryption. Encrypt summary values/goals and sensitive mode/date/zone/pause/source metadata. Encrypt decision evidence, approved terms/principal, and persisted replay payloads as well. Authenticate readable query metadata in AAD and validate decrypted content against runtime schemas before calculation or output. Derived score/policy snapshots stored with decisions receive the same protection as their source evidence.

Extend `RecordContext.kind` with distinct summary, loan, and decision/replay contexts and extend owner-bound HMAC domains for summary identities, idempotency keys, and canonical request fingerprints. Do not reuse sample/cursor domains for these records. Retain one stable index key per owner and existing active/retired data-key behavior. Extend retained-key inventory and operational documentation to count all new encrypted record families so key retirement cannot strand loans or replay bodies. Do not emit terms, amounts, metadata, idempotency secrets, decrypted bodies, or database errors into logs.

Provision/load the request's user keyring before beginning the loan transaction. `createUserKeyring` may run `BEGIN`/`COMMIT` internally on first use; calling it inside a loan transaction could commit the caller's reservation early. Pass an already-loaded keyring to all transaction helpers. Encryption/schema failure aborts the operation and produces 503; it must not create a partial loan or downgrade to a denial/starter response.

Rationale: one Postgres transaction can enforce reservation and idempotency while application encryption preserves the existing health-data boundary. Alternatives considered: plaintext summary or replay storage leaks sensitive derived data; JSON/R2 as another authoritative ledger splits transaction boundaries; hypertable partition uniqueness is unsuitable for owner/idempotency and loan ownership constraints.

### 6. Serialize owner accounting and persist original outcomes

Use a per-owner coordination row locked with `SELECT ... FOR UPDATE` in a `READ COMMITTED` transaction, creating it with conflict-safe insertion if necessary. Every loan approval, reservation change, and future authoritative completion follows the same order: provision/load keys outside the transaction; begin; create/lock the owner coordination row; read/check existing idempotency state; read authoritative evidence; write decision/loans; commit. Acquire the owner lock before reading the evidence used for a new decision. After the lock, fetch candidate summary envelopes and authoritative outstanding-loan envelopes in one SQL statement so they share one MVCC snapshot. A score GET can use the same single-statement evidence read without reserving credit.

Summary ingestion independently writes an entire revision atomically and does not acquire the accounting owner lock or modify reservations. A decision therefore sees either the previous or new committed summary revision at its statement snapshot, never half of each. Do not introduce a path that first locks summary/loans rows and later requests the owner coordination lock. All writers that can change outstanding principal must acquire the owner lock before those rows.

Do not start a repeatable-read snapshot before waiting on a lock: it could retain a view that excludes the previous lock holder's committed loan. Owner serialization followed by a fresh statement snapshot prevents this stale-read overspend while keeping imports independent. Use one SQL client for the transaction and always roll back on errors; do not issue parallel queries on that client during the transaction.

Scope idempotency to `(ownerId, idempotencyKeyDigest)` with a database unique constraint. Canonicalize the semantic payload using the validated principal decimal, duration, and canonical zone before hashing; JSON property order and equivalent numeric formatting do not create mismatches. Reusing a key with a different semantic payload returns 409. Reusing it with the same payload returns the persisted original HTTP status and body, including the original terms and credit snapshot: 201 for approval or 200 for denial, even if policy, activity, balance, or time has since changed. Replays create no second decision, loan, or reservation. API failures are not durable business decisions.

For a new key, compute credit from the locked evidence, deny without debt if insufficient, or insert the immutable loan and derive the response credit after reserving its full principal. Store the decision, its fingerprint, encrypted original response, and any approved loan atomically, then commit before returning. A timeout or disconnection before commit leaves no partial debt; an uncertain client retries with its original key.

Rationale: database locking and uniqueness work across Worker instances; persisted outcomes support reliable frontend retries. Alternatives considered: an in-memory lock protects only one instance; a check-then-insert without owner locking overspends under concurrency; recalculating a replay can produce a different decision or extend a term.

### 7. Keep the full-principal lifecycle boundary explicit

Outstanding credit is the exact sum of original principal for loans without an authoritative full-completion record. New loan progress is zero. Partial progress, passage of the due date, or new imported activity does not reduce this amount. A future authoritative completion may release the entire principal once; its implementation must share the owner lock and transaction boundary. Retain immutable approved terms when deriving current status/balance, and do not use an independently incremented balance counter as a second source of truth.

This change provides no activity allocator, automatic completion path, public completion endpoint, or inference that raw imports repay a loan. Consequently, newly created loans remain reserved in this first API until a later authoritative repayment implementation handles them. Document that limitation in the frontend handoff and reconcile older draft types/docs that imply immediately available broader repayment features.

Rationale: this delivers real loan creation without inventing unsupported activity attribution. Alternatives considered: proportional release contradicts the confirmed policy; treating elapsed time or raw Move totals as repayment bypasses exclusive allocation and correction rules.

### 8. Verify real transactions and delegate implementation with an integration lead

Use focused pure tests for score/decimal/calendar rules, existing runtime route tests for auth/CORS/error behavior, contract/export/SDK consumer tests for the shared boundary, migration/encryption tests for new record families, and real PostgreSQL multi-client tests for concurrency. In particular, prove that simultaneous approvals cannot exceed credit, duplicate keys reserve once, changed payloads conflict, denials reserve nothing, replay survives changed policy/history, and transaction failure leaves no partial loan. PGlite and driver stubs are useful for fast coverage but do not establish PostgreSQL locking/isolation behavior.

Implementation must use subagents with explicit non-overlapping ownership, in dependency order:

1. A scoring/data-normalization agent owns pure policy calculations and ring-summary normalization modules/tests after shared boundary names are fixed.
2. A persistence agent owns the credit SQL migration, encrypted credit store, transaction helpers, and real-Postgres accounting tests. It coordinates required crypto changes with the integrating lead rather than editing shared files concurrently.
3. An API/SDK integration agent owns root-route security registration, public runtime schemas, OpenAPI/SDK generation, consumer tests, and frontend examples once the service interfaces are agreed. A single designated owner edits each shared contracts/router/crypto file.
4. An independent reviewer, separate from implementation owners, checks the final diff for product-policy drift, ownership/isolation errors, sensitive-data leaks, generated-contract mismatch, and missing concurrency evidence.

The integration lead assigns file ownership before work starts, supplies a shared interface contract, resolves cross-cutting edits sequentially, runs repository-required checks, and incorporates review findings. Parallelize independent modules, not mutations of the same schema or router. Reconcile `docs/activity-credit-contract.md`, its companion plan, and `@burn-rate/api-schema/activity-credit` with raw-calorie requests, Move-kcal repayment targets, 1–30 day terms, settled score policy, current Postgres storage, and deferred automatic repayment.

Rationale: independent review and bounded ownership improve correctness across encryption, contracts, and concurrent state. Alternatives considered: one undivided implementation loses useful independent checks; unrestricted parallel editing creates incompatible contracts and transaction code.

## Risks / Trade-offs

- Incomplete or old imported samples cannot support scoring -> treat missing metadata as unknown and serve the explicit starter policy only after successful evidence reads; preserve new summary metadata going forward.
- A small number of usable days may produce a high score -> return `historyDays` visibly; the accepted policy permits borrowing without seven days, and this change adds no hidden history penalty.
- Source revisions and multiple exporters can disagree -> choose a deterministic whole-summary authority, match source calendar identity, and never merge values/goals across revisions or sources.
- Decryption and decimal work consume Worker time -> query the seven-day candidate window using owner-bound indexes, decrypt only required evidence, and measure transaction duration without logging sensitive values. Keep application keys request-scoped.
- Encryption during a transaction increases lock duration -> provision keys first, keep the locked section bounded, and rely on safe retry/idempotency after timeout rather than returning a partial outcome.
- A lowered limit can make an account over its limit -> expose negative available credit and deny additional borrowing without rewriting previous loan terms.
- Loans cannot automatically clear in this first API -> return honest zero progress/full reservation and document the deferred authoritative repayment dependency.
- New encrypted record families depend on retained keys -> extend inventory before rollout and preserve retired keys and replay payloads during rollback.

## Migration Plan

1. Finalize shared runtime schemas and pure-policy interfaces, then assign implementation file ownership. Add an additive credit migration to the checked runner without editing checksummed historical SQL, changing live infrastructure, or introducing D1.
2. Add encrypted summary/loans/decision support, new AAD/HMAC contexts, retained-key inventory coverage, and keyring injection into transaction helpers. Verify fresh initialization, repeat migration, owner isolation, envelope authentication, and absence of plaintext sensitive fields.
3. Deploy metadata-preserving ingestion before relying on newly collected summaries. Do not automatically relabel historical metric rows as complete summaries or run an inferred backfill. Existing retained encrypted dumps may be reprocessed only through a separately explicit, tested source-preserving procedure; no backfill is required to return honest no-history starter credit.
4. Integrate the credit services and root routes with session/origin/CORS handling, regenerate OpenAPI/SDK output offline, and update frontend examples and older draft documentation as one contract change. Run real PostgreSQL concurrency tests, relevant API/encryption/migration/SDK checks, then repository-required checks and independent review.
5. Enable the endpoints only after the additive migration and compatible encryption reader are deployed. Verify a score read, an approval, an insufficient-credit denial, same-key replay, changed-payload conflict, and trusted-origin preflight in a non-production environment before normal release.
6. For rollback, disable or revert the new credit routes while retaining additive tables, encrypted loan/decision records, keys, and principal reservations. Do not drop the new tables, clear idempotency outcomes, or roll back to a writer that misreads encrypted records. Redeployment resumes the original decisions; repayment remains a later change rather than a rollback side effect.
