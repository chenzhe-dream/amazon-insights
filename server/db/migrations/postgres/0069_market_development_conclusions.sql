CREATE TABLE market_development_conclusions (
 organization_id TEXT NOT NULL,
 created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 basis_hash TEXT NOT NULL CHECK (basis_hash ~ '^[a-f0-9]{64}$'),
 content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
 basis_json JSONB NOT NULL,
 conclusion_json JSONB NOT NULL,
 inputs_json JSONB NOT NULL,
 saved_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (organization_id,created_by,basis_hash,content_hash)
);
CREATE TRIGGER market_development_conclusion_immutable BEFORE UPDATE OR DELETE ON market_development_conclusions
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
