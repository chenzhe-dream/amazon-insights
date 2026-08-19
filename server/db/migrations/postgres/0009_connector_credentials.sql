CREATE TABLE connector_credentials (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL CHECK (connector IN ('sif', 'sorftime', 'sellerSprite')),
  version INTEGER NOT NULL CHECK (version > 0),
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 200),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL,
  revoked_by TEXT REFERENCES users(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL) OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL)
  ),
  UNIQUE (organization_id, connector, version)
);

CREATE UNIQUE INDEX connector_credentials_active_idx
ON connector_credentials (organization_id, connector)
WHERE status = 'active';

CREATE INDEX connector_credentials_latest_idx
ON connector_credentials (organization_id, connector, version DESC);

CREATE FUNCTION enforce_connector_credential_versioning()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    OLD.status = 'active' AND
    NEW.status = 'revoked' AND
    NEW.id IS NOT DISTINCT FROM OLD.id AND
    NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id AND
    NEW.connector IS NOT DISTINCT FROM OLD.connector AND
    NEW.version IS NOT DISTINCT FROM OLD.version AND
    NEW.ciphertext IS NOT DISTINCT FROM OLD.ciphertext AND
    NEW.nonce IS NOT DISTINCT FROM OLD.nonce AND
    NEW.auth_tag IS NOT DISTINCT FROM OLD.auth_tag AND
    NEW.key_id IS NOT DISTINCT FROM OLD.key_id AND
    NEW.created_by IS NOT DISTINCT FROM OLD.created_by AND
    NEW.created_at IS NOT DISTINCT FROM OLD.created_at AND
    OLD.revoked_by IS NULL AND
    OLD.revoked_at IS NULL AND
    NEW.revoked_by IS NOT NULL AND
    NEW.revoked_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'connector credentials are versioned';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER connector_credentials_update_versioned
BEFORE UPDATE ON connector_credentials
FOR EACH ROW EXECUTE FUNCTION enforce_connector_credential_versioning();

CREATE FUNCTION prevent_connector_credential_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'connector credentials are immutable';
END;
$$;

CREATE TRIGGER connector_credentials_delete_immutable
BEFORE DELETE ON connector_credentials
FOR EACH ROW EXECUTE FUNCTION prevent_connector_credential_delete();

CREATE FUNCTION prevent_audit_event_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit events are immutable';
END;
$$;

CREATE TRIGGER audit_events_update_immutable
BEFORE UPDATE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();

CREATE TRIGGER audit_events_delete_immutable
BEFORE DELETE ON audit_events
FOR EACH ROW EXECUTE FUNCTION prevent_audit_event_mutation();
