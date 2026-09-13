-- Append-only manual choices and their source-replayed numeric reports.
-- No changes to the existing VOC or source snapshots.
CREATE TABLE market_shape_price_revisions (
  organization_id TEXT NOT NULL,
  study_id TEXT NOT NULL,
  run_id UUID NOT NULL,
  revision_id TEXT NOT NULL CHECK (revision_id ~ '^market-shape-revision:[a-f0-9]{64}$'),
  parent_revision_id TEXT,
  ordinal INTEGER NOT NULL CHECK (ordinal > 0),
  stored_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  stored_at TIMESTAMPTZ NOT NULL,
  idempotency_key UUID NOT NULL,
  request_json JSONB NOT NULL CHECK (jsonb_typeof(request_json) = 'object'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  catalog_json JSONB NOT NULL CHECK (jsonb_typeof(catalog_json) = 'object'),
  catalog_hash TEXT NOT NULL CHECK (catalog_hash ~ '^[a-f0-9]{64}$'),
  PRIMARY KEY (organization_id,run_id,revision_id),
  UNIQUE (organization_id,run_id,ordinal),
  UNIQUE (organization_id,idempotency_key),
  FOREIGN KEY (organization_id,study_id,run_id) REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  FOREIGN KEY (organization_id,run_id,parent_revision_id) REFERENCES market_shape_price_revisions(organization_id,run_id,revision_id) ON DELETE RESTRICT,
  CHECK ((catalog_json->'revision'->>'revisionId') IS NOT DISTINCT FROM revision_id),
  CHECK ((catalog_json->'revision'->>'parentRevisionId') IS NOT DISTINCT FROM parent_revision_id),
  CHECK ((catalog_json->'revision'->>'authorId') IS NOT DISTINCT FROM stored_by),
  CHECK (((catalog_json->'revision'->>'createdAt')::timestamptz) IS NOT DISTINCT FROM stored_at),
  CHECK ((request_json->>'expectedParentRevisionId') IS NOT DISTINCT FROM parent_revision_id),
  CHECK ((ordinal=1) = (parent_revision_id IS NULL))
);
CREATE UNIQUE INDEX market_shape_price_revision_parent ON market_shape_price_revisions(organization_id,run_id,COALESCE(parent_revision_id,''));

CREATE FUNCTION validate_market_shape_price_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM market_analysis_module_runs r
    WHERE r.id=NEW.run_id AND r.organization_id=NEW.organization_id AND r.study_id=NEW.study_id
      AND r.request_json->>'moduleKind'='shape-price'
      AND r.request_json->'scope'=NEW.catalog_json->'scope'
      AND r.request_json->'scope'=NEW.catalog_json->'revision'->'scope'
  ) THEN RAISE EXCEPTION 'Shape revision scope differs from its native run'; END IF;
  IF NEW.parent_revision_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM market_shape_price_revisions p WHERE p.organization_id=NEW.organization_id
      AND p.run_id=NEW.run_id AND p.revision_id=NEW.parent_revision_id AND p.ordinal=NEW.ordinal-1
  ) THEN RAISE EXCEPTION 'Shape revision parent differs'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER market_shape_price_revision_scope BEFORE INSERT ON market_shape_price_revisions
FOR EACH ROW EXECUTE FUNCTION validate_market_shape_price_revision();
CREATE TRIGGER market_shape_price_revision_immutable BEFORE UPDATE OR DELETE ON market_shape_price_revisions
FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
