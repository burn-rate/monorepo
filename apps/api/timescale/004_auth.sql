-- Better Auth 1.7.12 canonical tables shared with @burn-rate/db.
-- This migration bootstraps fresh installations and upgrades the existing
-- historical Drizzle 0000 schema without rewriting that historical artifact.
CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  email_verified BOOLEAN NOT NULL DEFAULT false,
  image TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT user_email_unique UNIQUE (email)
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  expires_at TIMESTAMP NOT NULL,
  token TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  ip_address TEXT,
  user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  passkey_verified_at TIMESTAMPTZ,
  CONSTRAINT session_token_unique UNIQUE (token)
);
ALTER TABLE "session" ADD COLUMN IF NOT EXISTS passkey_verified_at TIMESTAMPTZ;
ALTER TABLE "session" ALTER COLUMN updated_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS "session_userId_idx" ON "session"(user_id);

-- Core account shape remains compatible; password/OAuth endpoints are disabled.
CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  access_token TEXT,
  refresh_token TEXT,
  id_token TEXT,
  access_token_expires_at TIMESTAMP,
  refresh_token_expires_at TIMESTAMP,
  scope TEXT,
  password TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
ALTER TABLE "account" ALTER COLUMN updated_at SET DEFAULT now();
CREATE INDEX IF NOT EXISTS "account_userId_idx" ON "account"(user_id);

CREATE TABLE IF NOT EXISTS "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS verification_identifier_idx ON "verification"(identifier);

CREATE TABLE IF NOT EXISTS "passkey" (
  id TEXT PRIMARY KEY,
  name TEXT,
  public_key TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  credential_id TEXT NOT NULL,
  counter DOUBLE PRECISION NOT NULL,
  device_type TEXT NOT NULL,
  backed_up BOOLEAN NOT NULL,
  transports TEXT,
  created_at TIMESTAMP,
  aaguid TEXT
);
-- WebAuthn signCount is uint32: float8 represents the full range exactly and
-- pg returns a JS number. Main's historical int4 cannot hold its upper half.
ALTER TABLE "passkey" ALTER COLUMN counter TYPE DOUBLE PRECISION USING counter::DOUBLE PRECISION;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_constraint
    WHERE conrelid = format('%I.passkey', current_schema())::regclass
      AND conname = 'passkey_counter_uint32'
  ) THEN
    ALTER TABLE "passkey" ADD CONSTRAINT passkey_counter_uint32
      CHECK (counter >= 0 AND counter <= 4294967295 AND counter = trunc(counter));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "passkey_userId_idx" ON "passkey"(user_id);
CREATE INDEX IF NOT EXISTS "passkey_credentialID_idx" ON "passkey"(credential_id);
-- Existing duplicate credentials must fail the upgrade, never be reassigned.
CREATE UNIQUE INDEX IF NOT EXISTS passkey_credential_id_unique ON "passkey"(credential_id);

-- Contexts cannot nominate an existing user. No FK is appropriate here: the
-- server-generated account identity is created only after WebAuthn verification.
CREATE TABLE IF NOT EXISTS auth_onboarding (
  context_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  email TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ
);
ALTER TABLE auth_onboarding ADD COLUMN IF NOT EXISTS email TEXT;
CREATE INDEX IF NOT EXISTS auth_onboarding_expiry ON auth_onboarding(expires_at);

CREATE TABLE IF NOT EXISTS ingestion_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ingestion_tokens_owner ON ingestion_tokens(user_id);
