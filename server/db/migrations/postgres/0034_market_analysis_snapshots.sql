CREATE TABLE market_analysis_studies (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  idempotency_key TEXT NOT NULL,
  scope_json JSONB NOT NULL CHECK (jsonb_typeof(scope_json) = 'object'),
  scope_hash TEXT NOT NULL CHECK (scope_hash ~ '^[a-f0-9]{64}$'),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, idempotency_key),
  CHECK ((scope_json->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((scope_json->>'researchId') IS NOT DISTINCT FROM id)
);

CREATE TABLE market_analysis_inputs (
  id TEXT PRIMARY KEY CHECK (id ~ '^market-input:[a-f0-9]{64}$'),
  organization_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  stored_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stored_at TIMESTAMPTZ NOT NULL,
  document_json JSONB NOT NULL CHECK (jsonb_typeof(document_json) = 'object'),
  document_hash TEXT NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (organization_id, study_id) REFERENCES market_analysis_studies(organization_id, id) ON DELETE RESTRICT,
  CHECK ((document_json->>'snapshotId') IS NOT DISTINCT FROM id),
  CHECK ((document_json->'scope'->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document_json->'scope'->>'researchId') IS NOT DISTINCT FROM study_id)
);

CREATE TABLE market_analysis_sources (
  id TEXT PRIMARY KEY CHECK (id ~ '^market-source:[a-f0-9]{64}$'),
  organization_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  stored_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stored_at TIMESTAMPTZ NOT NULL,
  document_json JSONB NOT NULL CHECK (jsonb_typeof(document_json) = 'object'),
  document_hash TEXT NOT NULL CHECK (document_hash ~ '^[a-f0-9]{64}$'),
  FOREIGN KEY (organization_id, study_id) REFERENCES market_analysis_studies(organization_id, id) ON DELETE RESTRICT,
  CHECK ((document_json->'scope'->>'organizationId') IS NOT DISTINCT FROM organization_id),
  CHECK ((document_json->'scope'->>'researchId') IS NOT DISTINCT FROM study_id)
);

CREATE INDEX market_analysis_studies_history ON market_analysis_studies(organization_id,created_at DESC,id);
CREATE INDEX market_analysis_inputs_history ON market_analysis_inputs(organization_id,study_id,stored_at DESC,id);
CREATE INDEX market_analysis_sources_history ON market_analysis_sources(organization_id,study_id,stored_at DESC,id);

CREATE FUNCTION validate_market_analysis_snapshot_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM market_analysis_studies s
    WHERE s.id = NEW.study_id AND s.organization_id = NEW.organization_id
      AND s.scope_json = NEW.document_json->'scope'
  ) THEN
    RAISE EXCEPTION 'Market analysis snapshot scope differs from frozen study scope';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER market_analysis_inputs_scope BEFORE INSERT ON market_analysis_inputs
FOR EACH ROW EXECUTE FUNCTION validate_market_analysis_snapshot_scope();
CREATE TRIGGER market_analysis_sources_scope BEFORE INSERT ON market_analysis_sources
FOR EACH ROW EXECUTE FUNCTION validate_market_analysis_snapshot_scope();

CREATE FUNCTION protect_market_analysis_snapshot() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Market analysis scope and source snapshots are immutable';
END;
$$;

CREATE TRIGGER market_analysis_studies_immutable BEFORE UPDATE OR DELETE ON market_analysis_studies
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
CREATE TRIGGER market_analysis_inputs_immutable BEFORE UPDATE OR DELETE ON market_analysis_inputs
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
CREATE TRIGGER market_analysis_sources_immutable BEFORE UPDATE OR DELETE ON market_analysis_sources
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
