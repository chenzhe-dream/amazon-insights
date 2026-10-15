CREATE TABLE market_project_favorite_groups (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL, created_by TEXT NOT NULL,
 name TEXT NOT NULL CHECK(char_length(name) BETWEEN 1 AND 60),
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(organization_id,id), UNIQUE(name),
 FOREIGN KEY(created_by,organization_id) REFERENCES users(id,organization_id) ON DELETE RESTRICT
);
CREATE TABLE market_project_favorites (
 id UUID PRIMARY KEY, organization_id TEXT NOT NULL, created_by TEXT NOT NULL,
 title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 120), group_id UUID,
 note TEXT NOT NULL DEFAULT '', tag TEXT NOT NULL DEFAULT '',
 context_json JSONB NOT NULL, fingerprint TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,
 created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(fingerprint),
 FOREIGN KEY(created_by,organization_id) REFERENCES users(id,organization_id) ON DELETE RESTRICT,
 FOREIGN KEY(group_id) REFERENCES market_project_favorite_groups(id) ON DELETE RESTRICT
);
CREATE INDEX market_project_favorites_org_updated ON market_project_favorites(organization_id,updated_at DESC,id DESC);
