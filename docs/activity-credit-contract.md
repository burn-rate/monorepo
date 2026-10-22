# Activity credit contract

The API provides session-protected `GET /score`, `GET /loans` and `POST /loans`
at these exact root paths. Runtime schemas live in `@burn-rate/api-schema/activity-credit` and
are also exported from the package root. OpenAPI and the SDK are generated from
the same route contracts. This document describes implemented source behavior;
deployment still requires the checked migrations and Worker rollout.

Activity credit is an optional, playful calorie budget, not a nutritional
assessment. Applications accept raw kcal and do not require a treat catalog.
The empty `data/treats.json` scaffold and future observation/allocation types
remain available for later work.

## Sessions and browser requests

Use the Better Auth session cookie and `credentials: 'include'`. The account
comes only from the session; request bodies and queries cannot choose an owner.
Mutations require an exact configured trusted `Origin`. Trusted browser
preflights permit GET and POST on `/loans`, with `Content-Type` and, for POST,
`Idempotency-Key` allowed. Header names are compared case-insensitively. Responses include `Cache-Control: no-store`
and an `X-Request-Id`, including validation and service failures. Authenticate
before validating business input. See the [SDK handoff](../packages/sdk/README.md)
for request-scoped browser and SSR clients.

## Ring consistency and server arithmetic

Only complete authoritative HealthExporter activity summaries inform the score.
Each requires source identity, local date, IANA zone, matching day boundaries,
export revision, explicit pause state and Move mode, all three ring actuals,
and positive historical goals. A selected paused or incomplete correction makes
that day unknown. Legacy samples and metrics-v1 observations cannot supply
missing metadata. A recorded zero is evidence; missing data is unknown.

The server uses the seven completed local calendar dates preceding today in the
requested zone. It excludes today and timezone-incompatible summaries. It
selects authoritative whole revisions before checking usability: recognized
Apple Fitness sources have priority, then stable lexical source order; within
a logical source day, exporter revision time and a canonical content digest
order revisions. Retrying an older batch cannot replace a newer correction.
Detailed observations and duplicate sources never add to a selected summary.

For each usable day, cap each ring's `actual / goal` at one, average Move,
Exercise and Stand equally, then average those days equally. Move may use kcal
or minutes according to the recorded mode; Stand is hours with qualifying
standing/movement, not minutes or stand-up event counts. Fewer than seven days
can still produce a known score. Repayment history does not change the score.

For consistency `c`, policy `ring-consistency-v1` uses:

```text
score               = roundHalfUp(300 + 550 * c)
creditLimitKcal     = floorToSixDecimalPlaces(250 + 1750 * c)
repaymentMultiplier = roundHalfUpToSixDecimalPlaces(1.5 - 0.45 * c)
availableKcal       = creditLimitKcal - outstandingKcal
```

No usable days produces `score: null`, limit 250 kcal and multiplier 1.5.
Known zero progress produces score 300; full consistency produces 850, limit
2000 and multiplier 1.05. Limit and rate use underlying consistency rather
than the rounded displayed score.

The server uses exact decimal/rational accounting from the canonical decimal
representation of the validated JavaScript numeric input. JSON numbers remain
numbers on the wire; arbitrary precision in the original JSON token or client
arithmetic is not promised. Display the returned balances, multiplier, target
and deadline. Clients must not reconstruct authoritative values from the score
or binary floating-point calculations.

## Read score and budget

```http
GET /score?timeZone=America%2FLos_Angeles
```

`timeZone` is required and must be a real IANA zone. Equivalent named aliases
are canonicalized. A known response (`200`) is:

```json
{
  "score": 575,
  "creditLimitKcal": 1125,
  "outstandingKcal": 0,
  "availableKcal": 1125,
  "repaymentMultiplier": 1.275,
  "historyDays": 4,
  "timeZone": "America/Los_Angeles",
  "calculatedAt": "2026-10-22T21:05:00Z",
  "policyVersion": "ring-consistency-v1"
}
```

An unknown-history response is successful (`200`):

```json
{
  "score": null,
  "creditLimitKcal": 250,
  "outstandingKcal": 0,
  "availableKcal": 250,
  "repaymentMultiplier": 1.5,
  "historyDays": 0,
  "timeZone": "America/Los_Angeles",
  "calculatedAt": "2026-10-22T21:05:00Z",
  "policyVersion": "ring-consistency-v1"
}
```

`outstandingKcal` sums full principal of every unpaid loan, including overdue
ones. Partial progress releases no principal. A fully repaid loan contributes
zero. If a falling limit is 250 while unpaid principal is 300, the response
keeps `availableKcal: -50`; it does not clamp to zero or alter approved terms.
A score read never creates loans or allocates activity. A database or decryption
failure is `503`, never an unknown-history fallback.

## List loans

```http
GET /loans
```

The session selects the account. No timezone query, idempotency header or
pagination is required. The `200` response contains every retained owner loan,
ordered newest first by creation time, then ID descending. It uses the same
flat loan schema as approvals. An empty account returns:

```json
{
  "loans": []
}
```

A populated account returns:

```json
{
  "loans": [
    {
      "id": "loan_example_001",
      "status": "active",
      "principalKcal": 200,
      "outstandingKcal": 200,
      "repaymentMetric": "move_kcal",
      "repaymentMultiplier": 1.275,
      "repaymentTargetKcal": 255,
      "repaymentProgressKcal": 0,
      "durationDays": 7,
      "timeZone": "America/Los_Angeles",
      "startsAt": "2026-10-22T21:05:00Z",
      "dueAt": "2026-10-29T21:05:00Z",
      "policyVersion": "ring-consistency-v1"
    }
  ]
}
```

The old singular `POST /loan` path is removed. Loan listing does not allocate
activity, fabricate repayment progress or release reserved principal.

## Create a loan decision

```http
POST /loans
Content-Type: application/json
Idempotency-Key: 303650eb-101a-4013-81ab-4f452794ab4e
Origin: https://app.burn-rate-app.workers.dev
```

```json
{
  "amountKcal": 200,
  "durationDays": 7,
  "timeZone": "America/Los_Angeles"
}
```

`amountKcal` is any positive finite JSON number, without an additional
precision restriction. `durationDays` is an integer from 1 through 30. A real
IANA `timeZone` and a nonempty `Idempotency-Key` header are required. Other
body fields, including owner IDs, client-selected scores/rates/requirements
and treat identifiers, are rejected.

Approval begins immediately and freezes principal, multiplier, exact decimal
repayment target, policy evidence, duration, zone and UTC start/deadline. The
metric is always `move_kcal`. Duration changes the deadline, not the multiplier.
The server adds local calendar days at the approval wall clock; DST can produce
23/25-hour days. A nonexistent destination clock advances by the transition
gap; a repeated clock chooses its earlier occurrence. Future activity eligibility
uses start-inclusive, deadline-exclusive boundaries.

An approved decision is `201`; its `credit` is the post-reservation snapshot:

```json
{
  "outcome": "approved",
  "loan": {
    "id": "loan_example_001",
    "status": "active",
    "principalKcal": 200,
    "outstandingKcal": 200,
    "repaymentMetric": "move_kcal",
    "repaymentMultiplier": 1.275,
    "repaymentTargetKcal": 255,
    "repaymentProgressKcal": 0,
    "durationDays": 7,
    "timeZone": "America/Los_Angeles",
    "startsAt": "2026-10-22T21:05:00Z",
    "dueAt": "2026-10-29T21:05:00Z",
    "policyVersion": "ring-consistency-v1"
  },
  "credit": {
    "score": 575,
    "creditLimitKcal": 1125,
    "outstandingKcal": 200,
    "availableKcal": 925,
    "repaymentMultiplier": 1.275,
    "historyDays": 4,
    "timeZone": "America/Los_Angeles",
    "calculatedAt": "2026-10-22T21:05:00Z",
    "policyVersion": "ring-consistency-v1"
  }
}
```

Insufficient available credit is a durable `200` business decision and creates
no loan or debt. Inspect `outcome`, even when the HTTP request succeeds:

```json
{
  "outcome": "denied",
  "loan": null,
  "reason": "insufficient-credit",
  "message": "The requested calories exceed available credit.",
  "credit": {
    "score": 575,
    "creditLimitKcal": 1125,
    "outstandingKcal": 200,
    "availableKcal": 925,
    "repaymentMultiplier": 1.275,
    "historyDays": 4,
    "timeZone": "America/Los_Angeles",
    "calculatedAt": "2026-10-22T21:05:00Z",
    "policyVersion": "ring-consistency-v1"
  }
}
```

Keep the same key and validated amount/duration/zone after a network error or
retryable service failure. A committed retry returns its original status and
body, including timestamps and the original credit snapshot, even after credit
changes. Denials replay too: use a new key for a new intended application.
Changed validated input under a committed key returns `409`. JSON property
order and equivalent numeric spelling do not change the request. Keys are
scoped to the authenticated owner and never expose another owner's decision.
Concurrent approvals serialize per owner and reserve full principal atomically
with their encrypted decision; failures roll back without partial debt.

## Errors, persistence and future work

Errors retain the existing envelope:

```json
{
  "error": {
    "code": "invalid-request",
    "message": "Invalid request parameters.",
    "requestId": "req_example_001"
  }
}
```

| Status | Meaning |
| --- | --- |
| 400 | Invalid query, JSON body, duration, amount, zone or idempotency header |
| 401 | Missing or expired session |
| 403 | Untrusted mutation origin or preflight |
| 409 | Existing key with changed validated input |
| 429 | Applicable rate limit; honor `Retry-After` |
| 503 | Storage/encryption failure; retry safely with the same application key |

TimescaleDB/Postgres is the single application database; D1 is not used.
Ring summaries, sensitive source metadata, approved terms and decision/replay
payloads are encrypted. Minimal owner/index/coordination metadata remains
readable and authenticated. Owner locks, immutable terms and idempotency records
use regular Postgres tables; existing encrypted samples retain their hypertable.
See the [encryption operations runbook](encryption-operations.md) for retained
keys, migrations, rollout and rollback.

Automatic repayment allocation, reconciliation, overdue processing, completion
mutations, catalog population and frontend UI are
**deferred**. New loans start with zero progress. Imports and passing a deadline
do not fabricate progress or forgive debt. A later authoritative repayment
mechanism must establish full completion before principal is released. Future
allocation still needs exclusive canonical activity ownership across overlapping
ring metrics and a policy for corrections and late uploads; this API does not
claim those mechanisms are delivered.
