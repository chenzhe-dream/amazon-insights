CREATE TABLE project_creation_idempotency (
  organization_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (
    idempotency_key ~ '^[A-Za-z0-9._:-]{16,128}$'
  ),
  canonical_payload JSONB NOT NULL CHECK (
    jsonb_typeof(canonical_payload) = 'object'
  ),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, idempotency_key)
);

CREATE UNIQUE INDEX project_creation_idempotency_project_idx
  ON project_creation_idempotency (project_id);

CREATE TABLE legacy_project_owner_bindings (
  legacy_project_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  operator_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  bound_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX legacy_project_owner_bindings_org_owner_idx
  ON legacy_project_owner_bindings (organization_id, owner_user_id);
