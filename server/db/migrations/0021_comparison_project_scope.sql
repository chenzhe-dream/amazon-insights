CREATE TABLE project_creation_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    length(idempotency_key) BETWEEN 16 AND 128
    AND idempotency_key NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  canonical_payload TEXT NOT NULL CHECK (
    json_valid(canonical_payload) AND json_type(canonical_payload) = 'object'
  ),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
) STRICT;

CREATE UNIQUE INDEX project_creation_idempotency_project_idx
  ON project_creation_idempotency (project_id);

CREATE TABLE legacy_project_owner_bindings (
  legacy_project_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bound_at TEXT NOT NULL
) STRICT;

CREATE INDEX legacy_project_owner_bindings_org_owner_idx
  ON legacy_project_owner_bindings (organization_id, owner_user_id);
