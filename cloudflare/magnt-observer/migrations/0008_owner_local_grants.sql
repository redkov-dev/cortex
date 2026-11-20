-- Owner local OAuth grants. Additive and isolated from visitor dialogue access.
CREATE TABLE IF NOT EXISTS owner_local_grants (
  grant_id TEXT PRIMARY KEY,
  owner_subject TEXT NOT NULL,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  epoch TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  activated_at INTEGER,
  revoked_at INTEGER,
  CHECK (expires_at > issued_at),
  CHECK (expires_at - issued_at <= 7776000),
  CHECK (activated_at IS NULL OR activated_at >= issued_at),
  CHECK (revoked_at IS NULL OR revoked_at >= issued_at)
);
CREATE INDEX IF NOT EXISTS owner_local_grants_owner_client ON owner_local_grants (owner_subject, client_id, issued_at DESC);
CREATE INDEX IF NOT EXISTS owner_local_grants_expires ON owner_local_grants (expires_at);
