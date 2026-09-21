CREATE TABLE market_favorites (
 id TEXT PRIMARY KEY,
 organization_id TEXT NOT NULL,
 created_by TEXT NOT NULL,
 title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
 module TEXT NOT NULL CHECK (module IN ('overview','shapes','keywords','themes')),
 query_json JSONB NOT NULL CHECK (jsonb_typeof(query_json) = 'object'),
 keyword_input_json JSONB CHECK (jsonb_typeof(keyword_input_json) = 'object'),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 FOREIGN KEY(created_by,organization_id) REFERENCES users(id,organization_id) ON DELETE RESTRICT
);
CREATE INDEX market_favorites_organization_created ON market_favorites(organization_id,created_at DESC,id DESC);
CREATE INDEX market_favorites_organization_module_created ON market_favorites(organization_id,module,created_at DESC,id DESC);
