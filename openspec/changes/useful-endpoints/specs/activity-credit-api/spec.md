## Purpose

Provide an authenticated, reproducible activity-credit score and borrowing budget, and create calorie loans with immutable repayment terms through a frontend-ready API. Preserve trustworthy ring evidence, prevent duplicate or concurrent overspending, and leave automated repayment allocation to a separate change.

## ADDED Requirements

### Requirement: Authenticated root paths and browser protection

The system SHALL expose `GET /score`, `GET /loans` and `POST /loans` at those exact paths, without an `/api` prefix. All endpoints SHALL identify the account exclusively from its valid application session cookie; an ingestion token or supplied account identifier SHALL NOT authorize them. Browser clients SHALL use `credentials: 'include'`.

Both paths SHALL apply the existing trusted-origin credentialed CORS policy, `Vary: Origin`, request identifiers, and `Cache-Control: no-store` to successes and errors. A mutation SHALL require an exact configured trusted `Origin`. Trusted preflights SHALL allow the endpoint method and the `Content-Type` and `Idempotency-Key` headers; untrusted preflights SHALL be rejected without invoking credit services. The system SHALL use the existing structured error envelope rather than exposing storage, encryption, or driver details.

#### Scenario: A session is required before business processing

- **WHEN** an otherwise permitted request with a valid trusted origin where required calls any of these endpoints without a valid application session, including with only an ingestion bearer token
- **THEN** the response is `401`, and no score evidence is returned or loan decision created

#### Scenario: Frontend preflight permits the loan request

- **WHEN** a trusted dashboard origin preflights `POST /loans` with `Content-Type` and `Idempotency-Key`
- **THEN** the response is `204` with the trusted origin, credentials enabled, and the requested supported headers permitted

#### Scenario: An untrusted origin cannot borrow

- **WHEN** a caller submits `POST /loans` with an absent or untrusted `Origin`
- **THEN** the response is `403`, with no decision or principal reservation created

### Requirement: Trustworthy daily ring evidence

Scoring SHALL use only complete, authoritative HealthExporter daily activity summaries, with one whole selected summary revision per account and local date. A usable summary SHALL contain valid local date, source timezone, matching UTC calendar-day interval, explicit activity Move mode, known pause state, and nonnegative actual values with positive goals and recognized units for all three rings. Move SHALL use its declared energy or time mode; Exercise SHALL use minutes and Stand SHALL use qualifying hours rather than stand minutes or event counts.

The system SHALL exclude explicitly paused summaries. Missing, incomplete, ambiguous, unsupported, or timezone-incompatible summaries SHALL remain unknown rather than becoming recorded inactivity. Source metadata discarded by older ingestion SHALL NOT be reconstructed by guessing from generic samples. Only summaries whose source calendar boundaries match the requested timezone's local day SHALL contribute; a daily total SHALL NOT be redistributed into a different timezone or fabricated into finer observations.

The system SHALL replace corrections as complete summary revisions, select duplicate or competing sources by a deterministic authority rule, and never choose whichever revision gives the highest score. It SHALL select the authoritative revision before deciding whether that revision is usable; a newer paused or incomplete correction SHALL NOT resurrect an older usable revision. It SHALL NOT add detailed quantity samples to a summary, sum duplicate sources, or combine ring values or goals across revisions. It SHALL preserve the sensitive source metadata needed to reproduce that selection.

#### Scenario: Complete summary and detailed samples coexist

- **WHEN** a completed local day has a usable authoritative summary plus detailed Move samples and repeated deliveries of that summary
- **THEN** the selected summary contributes once and the detailed samples do not increase its daily ring totals

#### Scenario: Missing data differs from recorded zero

- **WHEN** one summary lacks an Exercise goal and another complete summary explicitly records zero progress for all three rings
- **THEN** the incomplete day is excluded as unknown and the complete zero-progress day contributes zero consistency

#### Scenario: Corrections do not mix revisions

- **WHEN** an authoritative daily summary is corrected
- **THEN** scoring uses the selected complete corrected revision, without retaining individual ring values from its earlier revision

#### Scenario: An unusable correction does not restore stale progress

- **WHEN** the selected newer revision marks a previously usable day paused or leaves a required goal unknown
- **THEN** that day is excluded, without falling back to the older usable revision

#### Scenario: Source calendar boundaries cannot be shifted

- **WHEN** an imported summary's timezone or interval cannot be matched to a requested local day, or its pause or Move-mode metadata is missing
- **THEN** that summary does not contribute to the score or `historyDays`

### Requirement: Seven-day ring-consistency policy

The system SHALL capture the calculation instant and consider the last seven completed calendar days in the requested IANA timezone, excluding the current unfinished local day. It SHALL calculate each ring's completion as `min(actual / goal, 1)`, average the three ring fractions equally for daily consistency, and average the usable days equally for consistency `c`. Additional activity beyond a ring goal SHALL NOT offset another ring or another day's shortfall. `historyDays` SHALL equal the number of usable selected days, from zero through seven; fewer than seven days SHALL qualify without a waiting period.

For at least one usable day, the policy SHALL calculate from unrounded `c`:

- `score = roundHalfUp(300 + 550 * c)` to a whole integer from 300 through 850.
- `creditLimitKcal = floorToSixDecimalPlaces(250 + 1750 * c)`.
- `repaymentMultiplier = roundHalfUpToSixDecimalPlaces(1.5 - 0.45 * c)`.

With no usable days, it SHALL return `score: null`, `historyDays: 0`, `creditLimitKcal: 250`, and `repaymentMultiplier: 1.5`. A known zero-progress score SHALL be `300`, distinct from `null`. Repayment history, requested duration, and non-ring metrics SHALL NOT affect the score or multiplier. These rules SHALL be identified by `policyVersion: "ring-consistency-v1"`.

#### Scenario: Partial ring progress contributes equally

- **WHEN** the usable days average 50 percent ring consistency
- **THEN** the score is `575`, the credit limit is `1125` kcal, and the repayment multiplier is `1.275`

#### Scenario: Lowest and highest known consistency

- **WHEN** usable history has respectively zero or full consistency
- **THEN** zero consistency yields score `300`, limit `250`, and multiplier `1.5`, while full consistency yields score `850`, limit `2000`, and multiplier `1.05`

#### Scenario: Borrowing starts with limited or absent history

- **WHEN** an account has only one usable completed day, or no usable days
- **THEN** one day is sufficient for a known score, while no days yields the unknown-score starter policy without blocking borrowing

#### Scenario: Today and out-of-window history do not affect the score

- **WHEN** usable summaries exist for today, the seven previous completed local days, and an earlier day
- **THEN** only usable summaries within those seven completed days contribute, including across daylight-saving transitions

### Requirement: Score and budget response

`GET /score` SHALL require a valid IANA `timeZone` query parameter and return `200` with the credit snapshot shape below. `outstandingKcal` SHALL sum full principal reserved by the account's unpaid loans, including overdue loans. `availableKcal` SHALL equal `creditLimitKcal - outstandingKcal` without clamping a negative result. The snapshot SHALL represent consistent account evidence and balances at its calculation instant. A score read SHALL NOT create a loan, allocate activity, or release principal.

The same credit snapshot shape SHALL appear under `credit` in loan decisions. Numeric fields SHALL remain JSON numbers, `score` SHALL be an integer or `null`, `historyDays` SHALL be an integer, and timestamps SHALL be UTC ISO timestamps. Clients SHALL use server-returned terms and balances rather than recomputing financial values with binary floating-point arithmetic.

```http
GET /score?timeZone=America%2FLos_Angeles
```

```json
{
  "score": 575,
  "creditLimitKcal": 1125,
  "outstandingKcal": 0,
  "availableKcal": 1125,
  "repaymentMultiplier": 1.275,
  "historyDays": 4,
  "timeZone": "America/Los_Angeles",
  "calculatedAt": "2026-10-22T21:00:00Z",
  "policyVersion": "ring-consistency-v1"
}
```

#### Scenario: A known score returns its supporting history

- **WHEN** an authenticated account has four usable days averaging 50 percent consistency and no unpaid principal
- **THEN** `GET /score` returns the example field shape with score `575`, limit and available credit `1125`, multiplier `1.275`, and `historyDays: 4`

#### Scenario: A falling limit can leave negative available credit

- **WHEN** a known or unknown account has a `250` kcal limit and `300` kcal of unpaid principal
- **THEN** the response contains `outstandingKcal: 300` and `availableKcal: -50`, without changing existing loan terms

### Requirement: Owner-scoped loan listing

`GET /loans` SHALL require an application session and return `200` with `{ "loans": [...] }`. Each item SHALL use the same flat loan schema as an approved decision. The list SHALL contain every retained loan belonging to the authenticated account, ordered by approval instant descending and opaque loan ID descending. The endpoint SHALL require neither a timezone query nor an idempotency key. The old singular `POST /loan` route SHALL NOT remain registered.

The list SHALL include authoritative active, overdue and repaid loan records without changing their immutable terms, status or progress. Unpaid loans SHALL expose their full principal as `outstandingKcal`, while authoritatively fully repaid loans SHALL expose zero. Listing SHALL NOT infer repayment, mark loans overdue, release principal or create a new loan. The system SHALL authenticate and validate every returned encrypted envelope before sending any list response; corruption SHALL produce a safe `503`, not a partial or empty success.

#### Scenario: A new account has an empty loan list

- **WHEN** an authenticated account has no retained loans
- **THEN** `GET /loans` returns `200` with `{ "loans": [] }`

#### Scenario: Listing isolates accounts and retains fixed loan terms

- **WHEN** an account with active, overdue and fully repaid loans requests its list
- **THEN** only that account's loans are returned, newest first, using their fixed terms and authoritative progress, with full unpaid principal and zero fully repaid principal

#### Scenario: A corrupt loan does not produce a partial list

- **WHEN** a retained loan selected for an account fails authenticated decryption or schema validation
- **THEN** `GET /loans` returns the structured `503` error and no partial loan payload

### Requirement: Validated loan request and fixed repayment terms

`POST /loans` SHALL accept the following JSON body and require a nonempty `Idempotency-Key` header:

```http
POST /loans
Content-Type: application/json
Idempotency-Key: 303650eb-101a-4013-81ab-4f452794ab4e
```

```json
{
  "amountKcal": 200,
  "durationDays": 7,
  "timeZone": "America/Los_Angeles"
}
```

`amountKcal` SHALL be a positive finite JSON number with no additional decimal-place restriction. `durationDays` SHALL be an integer from 1 through 30 inclusive. `timeZone` SHALL be a valid IANA timezone. The request SHALL NOT require a treat-catalog identifier or a client-selected score, repayment multiplier, or activity requirement.

For accounting, principal SHALL equal the canonical decimal representation of the validated JSON numeric value, rather than the spelling of the original JSON token. The system SHALL preserve principal and perform balance and target calculations using decimal arithmetic, without rounding principal or accumulating binary floating-point drift. The repayment target SHALL be the exact decimal product of principal and the stored six-decimal repayment multiplier. Wire fields SHALL retain their numeric types; this SHALL NOT be a guarantee of arbitrary-precision arithmetic in JavaScript clients.

Approval SHALL start the loan at its approval instant and freeze principal, score-policy snapshot, multiplier, repayment target, `durationDays`, timezone, start, and deadline. Repayment metric SHALL be `move_kcal`. The deadline SHALL add the requested number of calendar days to the approval wall clock in the selected timezone. For a nonexistent destination wall clock, it SHALL move forward by the timezone transition gap; for a repeated wall clock, it SHALL select the earlier instant. The term SHALL use a start-inclusive and deadline-exclusive interval. Duration SHALL change the deadline but not the multiplier.

#### Scenario: Loan inputs have bounded whole-day duration

- **WHEN** a request has a zero, negative, non-finite, or nonnumeric amount; a duration outside 1 through 30 or a fractional duration; a missing or invalid timezone; or a missing idempotency key
- **THEN** it receives `400` and creates neither a decision nor a loan

#### Scenario: Decimal amount preserves the agreed principal

- **WHEN** a valid loan requests `0.1` kcal at a multiplier of `1.5`
- **THEN** its accounting principal is exactly decimal `0.1` and its repayment target is exactly decimal `0.15`, without silently rounding the principal to an integer

#### Scenario: Calendar days retain local deadline semantics

- **WHEN** a one-day loan is approved at noon on the local day before a daylight-saving transition
- **THEN** its deadline is noon the next local calendar day, even when the elapsed interval is 23 or 25 hours

#### Scenario: Later changes do not rewrite an approved loan

- **WHEN** a user's score, goals, borrowing policy, or available credit changes after approval
- **THEN** the loan retains its original multiplier, repayment target, principal, and deadline

### Requirement: Atomic approval and explicit denial

The system SHALL evaluate loan eligibility from current authoritative ring evidence and unpaid principal within an account-serialized atomic reservation operation. It SHALL approve only when the positive requested principal is no greater than available credit, and commit exactly one loan, full-principal reservation, and durable decision together. A failure SHALL NOT leave partial debt or an approval response without its committed loan.

An approval SHALL return `201` with `outcome: "approved"`, a newly created `loan`, and the post-reservation `credit` snapshot. A new loan SHALL have `status: "active"`, `outstandingKcal` equal to its full principal, and `repaymentProgressKcal: 0`. Its response shape SHALL be:

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

Insufficient credit SHALL return a durable `200` business decision with `outcome: "denied"`, `loan: null`, `reason: "insufficient-credit"`, a human-readable `message`, and the unchanged credit snapshot. Denial SHALL NOT create debt or reserve principal. Clients SHALL inspect `outcome` rather than treating every successful HTTP status as approval.

#### Scenario: Approved principal consumes available credit

- **WHEN** a score of `575` provides `1125` kcal of available credit and the user requests `200` kcal for seven days
- **THEN** the approved response has principal `200`, multiplier `1.275`, target `255`, progress `0`, and post-reservation available credit `925`

#### Scenario: Business denial is distinct from a request error

- **WHEN** a valid request exceeds an account's `925` kcal of remaining credit
- **THEN** the response is `200` with `outcome: "denied"`, `loan: null`, `reason: "insufficient-credit"`, a message, and the unchanged `credit` shape

#### Scenario: Concurrent loans cannot spend the same remaining budget

- **WHEN** two independent concurrent requests with different keys each request `200` kcal from an account with `250` kcal available
- **THEN** at most one is approved, the other is denied after observing the reservation, and unpaid principal totals only `200`

### Requirement: Owner-scoped durable request idempotency

The system SHALL scope each idempotency key to the authenticated account and loan operation. Repeating a key with identical normalized validated amount, duration, and timezone SHALL replay the original committed status and response body, including its original loan identifier, terms, credit snapshot, and timestamps. Equivalent JSON property order or numeric token spellings SHALL NOT create a different request. Changed validated input under an existing key SHALL return `409` without changing the original decision.

Both approved and denied outcomes SHALL be retained for retry. Concurrent delivery of the same request SHALL produce one durable decision and at most one loan and reservation. Another account's use of the same key SHALL neither reveal nor replay the first account's decision. A failed operation with no committed decision SHALL be safely retryable.

#### Scenario: Approval retry does not reserve principal twice

- **WHEN** an approved request is retried after a network failure or later score change using the same account, key, and validated input
- **THEN** it replays the original `201` response body and loan identifier with no additional debt

#### Scenario: Denied request stays the same on retry

- **WHEN** a denied request is retried with its original key after the user's credit improves
- **THEN** it replays the original `200` denial, and a new intended application requires a new key

#### Scenario: A changed request cannot reuse an existing key

- **WHEN** the same account reuses a committed loan key with a changed amount, duration, or timezone
- **THEN** the response is `409` and the prior decision and balances remain unchanged

#### Scenario: Keys do not cross account boundaries

- **WHEN** two authenticated accounts use the same idempotency key
- **THEN** each evaluates only its own request, credit evidence, decision, and loans

### Requirement: Full-principal repayment boundary

The system SHALL retain each unpaid loan's full principal as outstanding until authoritative accounting marks the loan fully repaid. Partial progress SHALL release no principal; an overdue unpaid loan SHALL continue consuming its full principal, and reaching a deadline SHALL NOT forgive debt. A fully repaid loan SHALL contribute zero outstanding principal.

This change SHALL create loans with zero progress and SHALL NOT infer repayment, allocate activity, automatically change repayment or overdue status, or expose a repayment mutation. Future repayment allocation and reconciliation SHALL establish authoritative progress before any fully repaid transition. The response and balance model SHALL preserve this boundary without claiming that an automated repayment engine is delivered here.

#### Scenario: Partial repayment releases no credit

- **WHEN** a `200` kcal loan with a `300` Move kcal target has authoritative progress of `150` Move kcal
- **THEN** the loan still contributes the full `200` kcal of principal to outstanding credit

#### Scenario: Full repayment releases principal once

- **WHEN** authoritative accounting marks that loan fully repaid
- **THEN** it contributes zero outstanding principal, and subsequent reads do not release another `200` kcal

#### Scenario: Imports and time passage do not fabricate repayment

- **WHEN** new activity is ingested or a new loan's deadline passes under this change alone
- **THEN** neither operation invents repayment progress or removes the loan's principal reservation

### Requirement: Encrypted persistence and fail-closed errors

The system SHALL use only the existing TimescaleDB/Postgres application database and SHALL NOT use D1. Retained ring values, sensitive summary metadata, credit evidence, approved sensitive terms, and idempotent request/response payloads SHALL be encrypted before durable writes. Readable ownership, opaque coordination identities, timestamps, or necessary lifecycle/index metadata SHALL NOT include raw health values or plaintext replay bodies. Logs and errors SHALL NOT contain health data, credentials, SQL parameters, or serialized internal exceptions.

Encryption, storage, or authenticating-decryption failures SHALL produce `503` through the structured application error envelope, never substitute the unknown-score starter policy, and never falsely acknowledge an uncommitted decision. Malformed inputs SHALL produce `400`, missing sessions `401`, origin failures `403`, changed-key conflicts `409`, and enforced rate-limit failures `429` with the established retry behavior. The shared error shape SHALL remain:

```json
{
  "error": {
    "code": "invalid-request",
    "message": "Invalid request parameters.",
    "requestId": "req_example_001"
  }
}
```

#### Scenario: Invalid ciphertext is not an unknown score

- **WHEN** a selected retained summary or required decision record fails authenticated decryption
- **THEN** the request returns `503` without health details and without granting starter-policy credit or creating a replacement loan

#### Scenario: A commit failure cannot become an approval

- **WHEN** persistence fails before a decision and reservation commit together
- **THEN** no `201` approval is returned, no partial loan or debt remains, and retrying can evaluate an uncommitted request safely

#### Scenario: Durable replay remains protected

- **WHEN** stored loan decisions and their replay payloads are inspected without the account's encryption keys
- **THEN** their retained sensitive credit and repayment data is unavailable as plaintext, while authorized retries still reproduce the original response

### Requirement: Generated frontend contract

The system SHALL publish shared runtime request/response schemas, an offline-generated OpenAPI contract, generated SDK operations, and copyable frontend examples for both exact root paths. The schemas and generated client SHALL express nullable scores, the shared `credit` response, approved/denied outcomes, the `{ loans: Loan[] }` list, `Idempotency-Key`, session-cookie security, numeric kcal fields, and documented status codes. Contract generation SHALL work without live database access or secrets.

The older draft type-only activity-credit boundary and documentation SHALL be reconciled with this API: raw calories replace a required treat, the offered repayment metric is Move kcal, terms are 1 through 30 days, and automated repayment remains deferred. Frontend handoff examples SHALL distinguish proposed behavior before implementation from implemented behavior after the implementation checks pass.

#### Scenario: A frontend can generate the same API offline

- **WHEN** the repository contract-generation commands run without a database connection or deployment secrets
- **THEN** they produce stable operations and schemas for `GET /score`, `GET /loans` and `POST /loans` with the documented session, header, payload, response, and error contracts

#### Scenario: Shared clients distinguish unknown scores and denials

- **WHEN** a frontend consumes an unknown-score snapshot or an insufficient-credit decision through the generated client
- **THEN** its contract permits `score: null` and identifies the denial through `outcome: "denied"` despite HTTP `200`
