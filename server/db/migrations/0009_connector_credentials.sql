CREATE TABLE connector_credentials (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('sif', 'sorftime', 'sellerSprite')),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  ciphertext BLOB NOT NULL CHECK (length(ciphertext) > 0),
  nonce BLOB NOT NULL CHECK (length(nonce) = 12),
  auth_tag BLOB NOT NULL CHECK (length(auth_tag) = 16),
  key_id TEXT NOT NULL CHECK (length(key_id) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  revoked_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TEXT,
  CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  UNIQUE (organization_id, connector, version)
) STRICT;

CREATE UNIQUE INDEX connector_credentials_active_idx
ON connector_credentials (organization_id, connector)
WHERE status = 'active';

CREATE INDEX connector_credentials_latest_idx
ON connector_credentials (organization_id, connector, version DESC);

CREATE TRIGGER connector_credentials_update_versioned
BEFORE UPDATE ON connector_credentials
WHEN NOT (
  OLD.status = 'active' AND
  NEW.status = 'revoked' AND
  NEW.id IS OLD.id AND
  NEW.organization_id IS OLD.organization_id AND
  NEW.connector IS OLD.connector AND
  NEW.version IS OLD.version AND
  NEW.ciphertext IS OLD.ciphertext AND
  NEW.nonce IS OLD.nonce AND
  NEW.auth_tag IS OLD.auth_tag AND
  NEW.key_id IS OLD.key_id AND
  NEW.created_by IS OLD.created_by AND
  NEW.created_at IS OLD.created_at AND
  OLD.revoked_by IS NULL AND
  OLD.revoked_at IS NULL AND
  NEW.revoked_by IS NOT NULL AND
  NEW.revoked_at IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'connector credentials are versioned');
END;

CREATE TRIGGER connector_credentials_delete_immutable
BEFORE DELETE ON connector_credentials
BEGIN
  SELECT RAISE(ABORT, 'connector credentials are immutable');
END;

CREATE TRIGGER audit_events_update_immutable
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;

CREATE TRIGGER audit_events_delete_immutable
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'audit events are immutable');
END;
