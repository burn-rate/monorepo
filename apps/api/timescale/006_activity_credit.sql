-- Regular Postgres records, deliberately outside the metric hypertable.
-- Health values, source/calendar metadata, terms and replay bodies stay encrypted.
CREATE TABLE IF NOT EXISTS calorie_credit_owners (
  owner_id TEXT PRIMARY KEY REFERENCES "user"(id),
  CHECK (owner_id <> '' AND owner_id <> 'default')
);

CREATE TABLE IF NOT EXISTS activity_ring_summaries (
  owner_id TEXT NOT NULL REFERENCES "user"(id),
  id TEXT NOT NULL,
  day_digest TEXT NOT NULL,
  -- Preserve exporter precision beyond pg/JavaScript millisecond timestamps.
  revision_at TEXT,
  revision_order NUMERIC,
  content_digest TEXT NOT NULL,
  envelope JSONB NOT NULL CHECK (envelope->>'version' = '1'),
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (owner_id, id),
  CHECK (owner_id <> '' AND owner_id <> 'default'),
  CHECK ((revision_at IS NULL) = (revision_order IS NULL)),
  CHECK (revision_order IS NULL OR revision_order = trunc(revision_order))
);
CREATE INDEX IF NOT EXISTS activity_ring_summaries_owner_day
  ON activity_ring_summaries (owner_id, day_digest);

CREATE TABLE IF NOT EXISTS calorie_loans (
  owner_id TEXT NOT NULL REFERENCES calorie_credit_owners(owner_id),
  id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  fully_repaid BOOLEAN NOT NULL DEFAULT FALSE,
  envelope JSONB NOT NULL CHECK (envelope->>'version' = '1'),
  PRIMARY KEY (owner_id, id),
  CHECK (created_at = date_trunc('milliseconds', created_at))
);
CREATE INDEX IF NOT EXISTS calorie_loans_owner_unpaid
  ON calorie_loans (owner_id, id) WHERE NOT fully_repaid;
CREATE INDEX IF NOT EXISTS calorie_loans_owner_created
  ON calorie_loans (owner_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS calorie_loan_decisions (
  owner_id TEXT NOT NULL REFERENCES calorie_credit_owners(owner_id),
  id TEXT NOT NULL,
  idempotency_digest TEXT NOT NULL,
  request_digest TEXT NOT NULL,
  http_status INTEGER NOT NULL CHECK (http_status IN (200, 201)),
  loan_id TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  envelope JSONB NOT NULL CHECK (envelope->>'version' = '1'),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, idempotency_digest),
  FOREIGN KEY (owner_id, loan_id) REFERENCES calorie_loans(owner_id, id),
  CHECK ((http_status = 201 AND loan_id IS NOT NULL) OR (http_status = 200 AND loan_id IS NULL)),
  CHECK (created_at = date_trunc('milliseconds', created_at))
);
