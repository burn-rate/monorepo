CREATE TABLE IF NOT EXISTS api_rate_limits (
  scope text NOT NULL,
  identity_digest text NOT NULL,
  window_start timestamptz NOT NULL,
  hits integer NOT NULL CHECK (hits > 0),
  PRIMARY KEY (scope, identity_digest, window_start)
);
CREATE INDEX IF NOT EXISTS api_rate_limits_expiry ON api_rate_limits (window_start);
-- Periodic maintenance: DELETE FROM api_rate_limits WHERE window_start < now() - interval '1 day';
