CREATE TABLE module_visibility_defaults (
 organization_id TEXT PRIMARY KEY,
 modules_json JSONB NOT NULL CHECK (jsonb_typeof(modules_json) = 'array'),
 version INTEGER NOT NULL CHECK (version > 0),
 updated_by TEXT NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY (updated_by, organization_id) REFERENCES users(id, organization_id) ON DELETE RESTRICT
);
ALTER TABLE user_module_visibility
 ADD COLUMN configuration_source TEXT NOT NULL DEFAULT 'personal'
 CHECK (configuration_source IN ('personal', 'new-user-default')),
 ADD COLUMN default_version INTEGER CHECK (default_version >= 0);
