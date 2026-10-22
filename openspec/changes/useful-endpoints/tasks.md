## 1. Establish delegated implementation ownership

Implementation MUST use subagents as requested by the user. The lead integrates their work; it must not silently replace the delegated workstreams with one undivided implementation. Reuse or sequence agents to respect available concurrency slots. Give each shared file one writer, and wait for prerequisite interfaces before dependent edits.

- [x] 1.1 Lead: reread proposal, design, spec, and current source; publish an ownership map covering scoring/ingestion, persistence/transactions, API/SDK, shared crypto, and documentation. Verify every affected shared file has one named owner and the implementation scope still excludes automatic repayment.
- [x] 1.2 Lead: spawn a scoring/data-normalization subagent and a persistence/transactions subagent with explicit file boundaries and acceptance scenarios. Verify both return implementation summaries and focused test evidence for their assigned work.
- [x] 1.3 Lead: assign an API/SDK integration subagent, concurrently only where ownership and interfaces permit; freeze normalized summary, evidence-read, loaded-keyring, policy, and loan-service interfaces before dependent edits. Verify the agents acknowledge the same public payloads and interface contract.

## 2. Define shared public and internal boundaries

- [x] 2.1 API/SDK subagent: add runtime schemas for the timezone query, positive finite numeric amount, 1–30 integer day request, required idempotency header, nullable-score credit snapshot, flat loan shape, and approved/denied/error unions. Verify schema tests accept the handoff examples and reject invalid fields without adding an unrequested decimal-place restriction.
- [x] 2.2 Lead and designated contract owner: reconcile the draft `@burn-rate/api-schema/activity-credit` boundary with raw-calorie applications, nullable scores, server-owned requirements, and day-only API terms; preserve unrelated future catalog/allocation types deliberately. Verify workspace consumers type-check without parallel or conflicting definitions of public payloads.
- [x] 2.3 Scoring subagent: implement shared decimal/rational and calendar primitives, using the canonical decimal representation of validated JSON numbers and explicit IANA/DST disambiguation. Verify exact `0.1 * 1.5 = 0.15` accounting, tiny finite principals, six-place rate/limit rounding, score half-up rounding, and 23/25-hour calendar-day cases.

## 3. Add encrypted relational persistence

- [x] 3.1 Persistence subagent: add an additive checked SQL migration for owner coordination, whole ring-summary revisions, immutable loans, and owner-scoped idempotent decisions; register it in `apps/api/scripts/migrations.ts` without editing checksummed historical SQL. Verify fresh and repeated migration tests, uniqueness/ownership constraints, and that all application tables remain in the existing Postgres database without D1.
- [x] 3.2 Lead as exclusive crypto owner, coordinating with persistence: extend authenticated record kinds and owner-bound HMAC domains for summaries, loans, decisions, idempotency keys, and request fingerprints; extend retained-key inventory and rotation coverage. Verify owner/kind/identity tampering fails, old key versions still decrypt each record family, and sensitive values/terms/replay bodies are absent from plaintext storage and logs.
- [x] 3.3 Persistence subagent: implement encrypted whole-summary storage and atomic revision-tuple upserts using exporter creation time plus canonical content HMAC, independent of receipt order. Verify identical retries converge, an old batch cannot replace a newer correction, and paused/incomplete winning revisions invalidate old usable evidence.
- [x] 3.4 Persistence subagent: implement owner-bound, indexed evidence reads that fetch selected summary candidates and unpaid loan envelopes in one statement snapshot; inject a preloaded keyring into transaction helpers. Verify cross-owner isolation, successful empty-history reads, corrupt-record failures, and that key provisioning never opens or commits a nested loan transaction.

## 4. Preserve scoring evidence and calculate credit

- [x] 4.1 Scoring subagent: extend HealthExporter normalization to retain indivisible summary revisions with source local date/zone, interval, export revision, source identity, Move mode, pause state, ring values, and historical goals. Verify the existing fixture retains its metadata, existing metric ingestion still works, and incomplete revisions are represented without invented values.
- [x] 4.2 Scoring subagent: select deterministic authoritative sources/revisions before usability validation, then validate complete matching-zone days, supported units, positive goals, explicit Move mode, and pause state. Verify no daily/detail double counting, no mixing revisions, no fallback to stale usable sources, and no inferred scoring from ambiguous legacy or metrics-v1 rows.
- [x] 4.3 Scoring subagent: implement `ring-consistency-v1` over the latest seven completed local dates, averaging capped partial progress equally across three rings and usable days. Verify the 300/575/850 examples, 250/1125/2000 limits, 1.5/1.275/1.05 multipliers, one-day eligibility, null-score starter behavior, and exclusion of today, paused days, and out-of-window data.
- [x] 4.4 Scoring subagent: implement the shared score/budget service using authoritative evidence and exact unpaid principal, without allocating activity or releasing debt. Verify negative available credit remains visible, partial/overdue loan fixtures retain full principal, fully repaid fixtures contribute zero, and missing data never hides database or decryption failures.

## 5. Implement atomic loan decisions

- [x] 5.1 Persistence subagent: provision/load keys before `BEGIN`, acquire the per-owner coordination row before authoritative reads in `READ COMMITTED`, and calculate eligibility from a fresh statement snapshot. Verify focused transaction tests cover lock order, rollback on failure, unchanged balances on denial, and no parallel queries on the transaction client.
- [x] 5.2 Persistence subagent: create fixed loan terms from current policy, immediate approval time, 1–30 calendar days, and Move-kcal repayment target; atomically persist full principal and the encrypted original decision before responding. Verify the 200 kcal / 1.275× / 255 kcal example, post-approval credit of 925 from 1125, initial zero progress, and immutable terms after score changes.
- [x] 5.3 Persistence subagent: implement owner-scoped idempotency with a unique key digest and canonical payload fingerprint for approvals and denials. Verify original status/body/loan/timestamps replay after history or balance changes, equivalent property order/numeric spelling replays, changed input returns 409, and another account cannot access a decision through the same key.
- [x] 5.4 Persistence subagent: preserve the full-principal lifecycle boundary without an automatic allocator, completion endpoint, deadline forgiveness, or overdue processor. Verify imported activity and elapsed time do not fabricate progress or release credit, and authoritative completed-loan fixtures release principal only once.

## 6. Integrate root routes and frontend tooling

- [x] 6.1 API/SDK subagent: extend browser middleware to `/score` and `/loans`, including session ownership, trusted mutation origins, no-store responses, request IDs, connection cleanup, and credentialed preflights allowing `Idempotency-Key`. Verify trusted/hostile origins, absent sessions, header casing, auth-before-business-validation, error responses, and no regression to existing routes.
- [x] 6.2 API/SDK subagent: register lazy credit services and OpenAPI routes with stable `getScore` and `createLoan` operation IDs, 200 score/denial, 201 approval, and documented structured errors. Verify runtime contract-response validation, no-storage-side-effect validation failures, no-owner-spoofing behavior, and configuration-free offline export.
- [x] 6.3 API/SDK subagent: regenerate `openapi/openapi.json` and SDK output through the existing commands, expose both operations, and add an independent generated-client consumer covering query encoding, cookies, JSON, idempotency header, nullable scores, and the denial union. Verify generated files are not manually edited and consumer type/runtime checks pass.
- [x] 6.4 API/SDK subagent and designated documentation owner: publish copyable known/unknown score, approval, denial, and error examples; reconcile README, activity-credit contract/plan, SDK handoff, and encryption operations with the implemented scope. Verify examples match the runtime schemas and explicitly explain full-principal reservation, server-owned arithmetic/deadlines, negative available credit, retry keys, and deferred automatic repayment.

## 7. Prove concurrency and cross-cutting behavior

- [x] 7.1 Persistence subagent: add real independent-connection PostgreSQL tests following `auth-postgres.test.ts`, using only explicit disposable `TEST_DATABASE_URL` configuration and a unique isolated test schema. Verify two valid competing 200 kcal requests against 250 kcal are demonstrably contending, one approves, the other receives an insufficient-credit denial, and one 200 kcal reservation remains; do not count skipped tests or PGlite lock stubs as concurrency evidence.
- [x] 7.2 Persistence subagent: use that real database harness to verify concurrent identical keys produce one decision/loan, differing payloads conflict, separate owners remain independent, and rollback/retry preserves accounting under commit-path failures. Verify teardown drops only the schema created by the test and report actual pass/skip status.
- [x] 7.3 Lead: integrate the agents' branches/files and run focused API, encryption, migration, policy, and SDK tests, then the required `pnpm check`, `pnpm test`, `pnpm build`, and `pnpm check:generated` checks. Verify results are recorded accurately and missing real-Postgres evidence is reported rather than represented as passing.
- [x] 7.4 Lead: spawn an independent reviewer subagent after integration, separate from implementation owners, to inspect policy fidelity, privacy, source correction ordering, transaction freshness, middleware coverage, generated-contract parity, and test evidence. Verify a written review is delivered, address material findings, and rerun checks affected by fixes.

## 8. Finish the implementation handoff

- [x] 8.1 Lead: document migration-before-Worker rollout, non-production smoke scenarios, and a rollback that retains encrypted decisions, keys, loans, and principal reservations. Verify the runbook covers score, approval, denial, replay, conflicting key, and browser preflight without requesting a destructive backfill or dropping tables.
- [x] 8.2 Lead: review the final diff against all capability scenarios and delegated deliverables; update task completion only for work actually done and present the changed behavior, validation evidence, and remaining automatic-repayment limitation. Verify no live deployment, merge, or other unrequested release action was silently performed.

## 9. Apply plural resource paths and add loan listing

- [x] 9.1 Lead: reconcile proposal, design, capability spec, tasks and operations documentation with the user-requested `POST /loans` rename and `GET /loans` payload; remove loan listing from deferred scope while keeping automatic repayment deferred.
- [x] 9.2 Persistence subagent: implement owner-scoped encrypted loan listing, newest approval first, including authoritative repaid records; verify empty lists, cross-owner isolation, fixed terms, full unpaid principal, deterministic ordering and fail-closed corruption.
- [x] 9.3 API/SDK subagent: register authenticated `GET /loans` and plural `POST /loans`, publish `{ loans: Loan[] }` runtime/OpenAPI/SDK contracts and copyable examples, and verify browser security, absent singular route, generated-client requests and schema parity.
- [x] 9.4 Lead and independent reviewer: review the added listing and route rename, rerun affected focused and workspace checks, verify deterministic generated output, and report actual validation results.

## Implementation validation (2026-10-22)

Ownership: `scoring` implemented policy, exact decimal/calendar primitives and
HealthExporter normalization; `persistence` implemented SQL, encrypted credit
records, loan services and transaction tests; `api_sdk` implemented runtime
contracts, routes, SDK generation and frontend examples; the lead owned shared
crypto, encryption/rollout operations, integration and task tracking. A separate
`reviewer` inspected the integrated change and the plural-route/listing update.

- Final endpoints: `GET /score`, `GET /loans` returning `{ loans: Loan[] }`, and
  idempotent `POST /loans`. The singular POST route is absent.
- `pnpm check`: passed, all 9 tasks.
- `pnpm test`: passed, 146 API + 3 SDK + 3 dashboard tests. Six opt-in external
  database cases were skipped in that ordinary run.
- `credit-postgres.test.ts`: separately passed all 4 cases against a freshly
  provisioned disposable local PostgreSQL 18.4 cluster, using independent
  connections and unique schemas. Verified observed lock contention, fresh
  reservations, identical-key replay, conflicting payloads, owner independence
  and real deferred-COMMIT failure rollback/retry. The test server was stopped
  afterward. Skipped cases were not counted as concurrency evidence.
- `pnpm build`: passed, all 5 tasks, including Worker dry-run. An initial parallel
  check/build generator collision was resolved by sequential regeneration and
  a successful sequential build; no product source workaround was introduced.
- Two sequential forced generations produced identical SHA-256 hashes for all
  OpenAPI and SDK artifacts. `pnpm check:generated` ran and reports the four
  intentionally modified generated files as uncommitted relative to Git.
  Generated output was produced through the existing commands.
- Independent review: no unresolved findings. Timestamp representation and
  nanosecond correction-order issues were fixed and covered by regressions.
- Strict OpenSpec validation and `git diff --check` passed. No deployment, live
  application migration, merge or archive was performed. Automatic repayment
  remains deferred; full unpaid principal stays reserved. D1 was not used.
