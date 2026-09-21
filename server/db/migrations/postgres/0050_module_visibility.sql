CREATE TABLE user_module_visibility (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 organization_id TEXT NOT NULL,
 modules_json JSONB NOT NULL CHECK (jsonb_typeof(modules_json)='array'),
 version INTEGER NOT NULL CHECK(version>0),
 updated_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY (user_id,organization_id) REFERENCES users(id,organization_id) ON DELETE CASCADE
);
CREATE INDEX user_module_visibility_organization_idx ON user_module_visibility(organization_id);
