# Health-data encryption operations

This implementation encrypts sample values/ranges, unit, source/device names,
external IDs, attributes, dump lineage, and complete retained raw dumps before
durable writes. Metric IDs, ownership IDs, interval/ingestion times, opaque IDs,
key/nonce metadata, and keyed source digests remain readable. This is
server-managed encryption: a Worker with access to its wrapping secrets can
decrypt authorized records. Database/R2 encryption alone is not the boundary.
Observation timestamps have millisecond precision, enforced by storage checks.
Query bounds retain their accepted decimal precision: `[from,to)` is evaluated
exactly against those observations, including sub-millisecond bounds.

Inspection found 127 plaintext SQL sample rows on 2026-10-22. The user confirmed
they were disposable and authorized removal; the committed cleanup removed the
legacy sample table and empty daily aggregate. Initialize encrypted storage
directly from that cleaned SQL state. No owner mapping or backfill is needed
for the removed disposable rows. R2 objects were unchanged, and actual retained
objects/backups have separate retention and encryption status. The optional
legacy procedures below apply when actual legacy data must be preserved.

## Configuration and custody

Set `ENCRYPTION_ENVIRONMENT` to a stable deployment identifier, such as
`production`. Changing it invalidates authenticated metadata. Set
`HEALTH_KEK_ID` to the current wrapping-key ID, and set the **secret**
`HEALTH_KEKS` to a JSON map of retained wrapping IDs to independently generated
32-byte, base64url-encoded random keys. Example shape only:

```json
{"production-2026-10":"<32-random-bytes-as-base64url>"}
```

Provision through the existing secret manager/Worker secret workflow. Do not
commit the real JSON, pass it as a command-line argument, or paste it into task
notes/logs. `AUTH_SECRET` must be independent of every health key.
Back up wrapping versions in the approved secret store separately from database
exports. Database rows contain only wrapped per-user data/index keys. The
independent index key remains stable during routine DEK/KEK rotation.

The Node operator tool consumes these same three encryption variables plus
`DATABASE_URL` or `DB_CONNECTION_STRING`, using the existing `getSql` lifecycle.
It can load the private connection from `apps/api/.env`. For a database using a
private Timescale CA, the tool automatically uses the
[bundled certificate](../apps/api/certs/README.md); `DATABASE_CA_FILE` can override
it for another CA. Server certificate and hostname verification remain enabled.
For R2 work also set
`R2_ENDPOINT` (the intended account's S3 endpoint), `R2_BUCKET`,
`R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`. Use a bucket-scoped credential and
private environment loading; never place credentials directly in an example
command. The S3 adapter uses [AWS SDK object commands](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/javascript_s3_code_examples.html).
The tool emits counts/status/key identifiers, never captured health values,
request credentials, SQL parameters, or serialized SDK/driver exceptions.

## Fresh encrypted initialization and rehearsal

1. Keep exporters paused until the encrypted Worker is deployed: the old Worker
   can still write plaintext R2 dumps before failing on the removed SQL table.
   Inspect the intended database's safe schema/count state; the current target's
   authorized disposable SQL cleanup is recorded below. Load `DATABASE_URL` or
   `DB_CONNECTION_STRING` privately;
   the supplied `apps/api/.env` is an operator input and must not be printed,
   committed, or exposed to browser code. Keep synthetic validation data in a
   disposable database or isolated test schema.
2. Run `pnpm db:migrate` for the selected target. The checksummed runner applies
   `000_metrics.sql`, `002_encrypted.sql`, `004_auth.sql`, and `005_limits.sql`,
   bootstrapping the registry and creating encrypted sample/key, auth/token,
   and rate-limit storage directly. Do not run historical `001_init.sql` on a
   fresh target: it creates plaintext samples and a daily aggregate. Fresh
   initialization must create neither, and requires no `db:cutover` step.
   Production GitHub Actions runs the same normal migration list before Worker
   deployment using the `DB_CONNECTION_STRING` repository secret and the bundled
   Timescale CA. `DATABASE_CA_PEM` is an optional override for another CA. See
   [CI configuration](api-deployment.md#github-actions-migrations).
   Failed migrations block deployment; successful files stay applied and are
   skipped by checksum on retry, including after a Worker deployment failure.
3. Verify Timescale hypertable uniqueness includes `time`, owner/metric paging
   indexes exist, and columnstore segmentation exposes no source identity.
   Validate supported insert/correction behavior with compressed chunks on the
   deployed Timescale version. Verify migration re-execution is safe, and
   inspect the tested target for plaintext health tables or aggregate views.
4. Create two staging accounts through valid passkey ceremonies, issue an
   ingestion token for each, POST each exporter fixture and an unknown non-JSON
   body, and verify independent SDK reads. Revoke a token and confirm uploads
   stop before retention. Check 413/429 and injected R2/database failures, and
   inspect the resulting database/R2 representation for protected plaintext.
5. Rehearse data-key rotation, KEK rewrap, and restore using retained versions.
   Verify invalid/missing keys and corrupt ciphertext fail closed. Compare
   before/after logical identities and domain values. Use staging keys.

The initial empty-data assumption was contradicted by a 2026-10-22 inspection
that found 127 plaintext sample rows and zero daily aggregate rows. The user
confirmed those samples were disposable and authorized cleanup. The transaction
took the shared migration advisory lock and exclusive relation locks, rechecked
the counts, dropped `public.health_daily` then `public.health_samples` with
`RESTRICT`, verified both were absent and their two policies were removed,
checked the metric registry count was unchanged, and passed the deployment
preflight before committing. Encrypted application migrations and Worker
deployment were not part of that operation. R2 objects were unchanged; SQL
removal does not stop the old Worker retaining new plaintext raw dumps, so keep
exporters paused until encrypted ingestion is deployed. CI retains its
plaintext-row deployment guard. Fresh initialization and encryption/compression
checks passed in isolated temporary schemas on TimescaleDB 2.31.0.

## Optional legacy migration preparation

This section applies only to a target with existing legacy samples/dumps.
Preserve historical `001_init.sql`; do not reapply it to an existing database.
The normal migration runner adds encrypted storage and conditionally prepares
legacy checkpoint columns without running destructive `003_cutover.sql`.
Pause legacy writers before backfill and review any actual backup dependencies.

The legacy migration adds a nullable checkpoint UUID without a volatile default,
which compressed hypertables reject. Backfill initializes UUIDs in bounded,
resumable updates using the original unique sample identity. It changes no
owner, value, or lineage; NULL checkpoints remain unverified and prevent
cutover. Rehearse on representative compressed chunks when this optional path
is needed. Timescale [schema-change support](https://github.com/timescale/docs/blob/latest/use-timescale/compression/modify-a-schema.md)
depends on the installed version. Operator jobs disable their statement timeout;
normal request clients retain the bounded timeout.

## Optional verified owner mapping and resumable backfill

Only when retained legacy records exist, pause legacy ingestion and any legacy
database writers. Keep that data quarantined from authenticated reads. Registration never claims `default` data.
An operator must verify ownership outside the application and prepare a private
mapping file, for example `/private/tmp/burn-rate-verified-owners.json`:

```json
{
  "sampleOwners": {
    "default": {
      "ownerId": "existing-account-id",
      "verifiedBy": "operator-id",
      "verifiedAt": "2026-10-22T00:00:00Z",
      "evidence": "restricted-ownership-inventory-reference"
    }
  },
  "dumps": {
    "hook/original-opaque-object-key.json": {
      "ownerId": "existing-account-id",
      "verifiedBy": "operator-id",
      "verifiedAt": "2026-10-22T00:00:00Z",
      "evidence": "restricted-ownership-inventory-reference"
    }
  }
}
```

Every mapped target must already be an account. Each raw object is mapped
explicitly; no prefix or first-user inference assigns ownership. An absent or
invalid mapping leaves data in quarantine and is reported as incomplete.
Mappings reference accounts/opaque lineage, not health values or credential
secrets. Keep the mapping and ownership evidence in the operator's restricted
records, outside the repository.

From the repository root, with the intended environment loaded privately:

```sh
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts inventory --mappings /private/tmp/burn-rate-verified-owners.json
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts backfill --mappings /private/tmp/burn-rate-verified-owners.json
```

`inventory` scans all live bucket objects, authenticates encrypted objects, and
reports total/verified/unowned/plaintext counts. It also verifies each migrated
sample against its legacy protected fields in bounded batches. A zero success
count from one job is not evidence of complete coverage. An oversized legacy
object (>16 MiB) requires an explicit larger-object migration plan; the tool
does not silently skip it.

Sample upserts preserve a stable ID derived from the independent per-user HMAC
index key. A checkpoint is written only after authenticated decrypt/field
verification. If interrupted before checkpointing, restarting rewrites the same
observation with a fresh nonce. Assigned raw dumps are replaced atomically at
the same original opaque key, with an encrypted envelope and the metadata
`encrypted=1`/`ownerId`. Old header/query maps are removed before encryption to
discard captured credentials. A restart recognizes and authenticates an already
encrypted object rather than encrypting its envelope as a new body. Plaintext
retry files or shadow tables are never created.

Unassigned data prevents complete cutover. Do not delete it to make the counts
pass. Resolve ownership through verified evidence; deletion requires separate
authorization.

## Optional legacy cutover and actual backup retention

No ownership mapping or backfill is needed for the disposable SQL rows already
removed under the user's authorization. That cleanup does not modify R2
objects or externally retained backups. Record retention and encryption status
for any actual copies; no expiry proof is needed for nonexistent backups.
As encrypted records and recoverable backups are created, maintain
normal retention and required key-version custody. For an optional legacy
cutover, inventory every actual database snapshot, R2 export/version, replica,
downloaded dump, and recoverable backup before verification. For each copy,
record its location/reference, responsible owner, capture time, whether it is
plaintext, applicable KEK/DEK/index versions, retention/expiry time, and verified
destruction/migration date. Updating live tables does not encrypt old backups.
Do not claim all retained data is encrypted while readable recoverable copies
remain. This repository cannot inspect externally managed snapshots or infer
their expiry.

For a target with actual legacy data only, while its writers remain paused, run:

```sh
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts verify-cutover --mappings /private/tmp/burn-rate-verified-owners.json --verified-by operator-id --backup-inventory restricted-backup-ledger-reference
pnpm --filter @burn-rate/api db:cutover
```

Verification writes a live-data attestation only after all samples and live
objects have authenticated coverage and no unowned/plaintext live objects
remain. A backup-ledger reference records responsibility; it does not attest
that every external plaintext backup expired. The manual cutover transaction
independently refuses missing/incomplete sample checkpoints or missing
attestations, then removes `health_daily` (including its refresh policy) and
the old `health_samples` hypertable. Its old compression policies disappear
with the table. Retain the new encrypted table/index/policy. Privately scan
live storage, SQL views, object versions, and any diagnostic copies for protected
plaintext before declaring live cutover complete, and track external backup
completion separately.

Deploy/resume only encrypted writers and authorized encrypted readers. Exporters
must use POST plus their per-user `Authorization: Bearer <token>` credential;
browser session cookies do not authorize ingestion. Replay retained encrypted
dumps through controlled operator code after owner authorization; retries must
converge on existing sample IDs.

## Encrypted-only rollback

Rollback only to an envelope-aware application version. Preserve encrypted
records and all required keys; pause ingestion if repair is needed. Never
restore the old plaintext writer, a `default` read path, readable daily rollups,
or a plaintext retry queue. A staging backup restore must reproduce isolated
authorized sample/dump reads using the retained key versions before production
rotation/cutover is considered rehearsed.

## Rotation and retained-key inventory

```sh
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts key-inventory
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts rotate-dek --owner existing-account-id
pnpm --filter @burn-rate/api exec node --import tsx scripts/legacy-data.ts rewrap-kek --owner existing-account-id
```

DEK rotation retires the old version and activates a fresh per-user DEK. It
does not rewrite payloads or rotate the index key. Existing records remain
readable; replay/correction writes use the active DEK and preserve logical IDs.
Use the inventory to track old versions; no key-deletion operation is provided.

For KEK rotation, first distribute a secret map containing both old and new
KEKs and select the new `HEALTH_KEK_ID`. Run rewrap for every account. Both active
and retired DEKs and the stable index key are rewrapped under the new KEK;
payload ciphertext remains unchanged. Confirm the SQL key inventory reports
the new wrapping ID, authenticate sample/R2 reads, and restore a staging copy
with the intended retained versions. Keep old KEKs for snapshots containing
old wraps until those snapshots are migrated or expire. Live sample counts
alone do not establish that a key is dispensable: `key-inventory` also checks
live R2 DEK references, and the external backup ledger supplies recoverable
backup dependencies. Normal rotation never changes the index key; changing it
requires a separate full-index migration.

## Verification delivered with this change

`apps/api/test/encrypted-store.test.ts` exercises actual PostgreSQL
DDL/constraints/transactions using PGlite, with only Timescale calls omitted and
the advisory-lock call stubbed because the test process has one client. It
covers ciphertext binding/tamper/key loss, nonce freshness, correction/replay,
partial-batch retry, tenant isolation, bounded cursor pagination, DEK/KEK
rotation, retained-key restore, and restarted owner-mapped sample/R2 backfill.
Those embedded tests do not prove Timescale compression/policy behavior, real
concurrent locks, or deployment origins. Record representative database and
independent-connection checks separately when executed. Actual legacy backup
expiry and live cutover coverage apply only to a target containing legacy data.
For the independent-connection deletion race, set `TEST_DATABASE_URL` to an
explicitly disposable PostgreSQL database and run the opt-in
`apps/api/test/auth-postgres.test.ts`. It creates and removes only its own
random test schema. Without that input the test is reported as skipped.
Browser/device staging checks remain distinct from automated cryptographic
fixtures. The authorized disposable SQL cleanup does not claim those ceremonies
have run and does not establish R2 or backup status. Record configured-database
inspection, that committed cleanup, and isolated
Timescale verification separately from operational deployment.
