-- Immutable lineage from a saved A2 manual revision to each explicit model configuration run.
CREATE TABLE market_shape_explanation_runs (
  organization_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  parent_run_id UUID NOT NULL,
  revision_id TEXT NOT NULL CHECK (revision_id ~ '^market-shape-revision:[a-f0-9]{64}$'),
  explanation_catalog_id TEXT NOT NULL CHECK (explanation_catalog_id ~ '^market-shape-explanation:[a-f0-9]{64}$'),
  configuration_version TEXT NOT NULL CHECK (length(configuration_version) BETWEEN 1 AND 240),
  child_run_id UUID NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,parent_run_id,revision_id,configuration_version),
  UNIQUE (organization_id,child_run_id),
  FOREIGN KEY (organization_id,parent_run_id,revision_id)
    REFERENCES market_shape_price_revisions(organization_id,run_id,revision_id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,study_id,parent_run_id)
    REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,study_id,child_run_id)
    REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT
);

CREATE FUNCTION validate_market_shape_explanation_run() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM market_shape_price_revisions p
    WHERE p.organization_id=NEW.organization_id AND p.study_id=NEW.study_id
      AND p.run_id=NEW.parent_run_id AND p.revision_id=NEW.revision_id
  ) THEN RAISE EXCEPTION 'Shape explanation parent revision differs'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM market_analysis_module_runs r
    WHERE r.organization_id=NEW.organization_id AND r.study_id=NEW.study_id
      AND r.id=NEW.child_run_id AND r.created_by=NEW.created_by
      AND r.request_json->>'moduleKind'='shape-price'
      AND r.request_json->'scope'=(SELECT request_json->'scope' FROM market_analysis_module_runs WHERE id=NEW.parent_run_id AND organization_id=NEW.organization_id)
      AND r.request_json->'params'->>'flow'='shape-explanation/v1'
      AND r.request_json->'params'->>'parentRunId'=NEW.parent_run_id::text
      AND r.request_json->'params'->>'revisionId'=NEW.revision_id
      AND r.request_json->'params'->>'explanationCatalogId'=NEW.explanation_catalog_id
      AND r.request_json->'versions'->>'configuration'=NEW.configuration_version
      AND r.request_json->'versions'->>'mapping'=NEW.explanation_catalog_id
      AND r.request_json->>'collectionRevision'=NEW.revision_id
  ) THEN RAISE EXCEPTION 'Shape explanation child lineage differs'; END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER market_shape_explanation_run_scope BEFORE INSERT ON market_shape_explanation_runs
FOR EACH ROW EXECUTE FUNCTION validate_market_shape_explanation_run();
CREATE TRIGGER market_shape_explanation_run_immutable BEFORE UPDATE OR DELETE ON market_shape_explanation_runs
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
