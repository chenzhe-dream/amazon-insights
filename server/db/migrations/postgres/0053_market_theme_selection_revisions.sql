-- Independent, immutable sample selections; original reports and execution remain untouched.
CREATE TABLE market_theme_selection_revisions (
 organization_id TEXT NOT NULL,study_id TEXT NOT NULL,run_id UUID NOT NULL,base_attempt_id UUID NOT NULL,
 revision_id TEXT NOT NULL CHECK(revision_id ~ '^market-theme-selection-revision:[a-f0-9]{64}$'),parent_revision_id TEXT,
 ordinal INTEGER NOT NULL CHECK(ordinal>0 AND ordinal<=1000),stored_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 stored_at TIMESTAMPTZ NOT NULL,idempotency_key UUID NOT NULL,request_json JSONB NOT NULL,request_hash TEXT NOT NULL,
 facts_json JSONB NOT NULL,facts_hash TEXT NOT NULL,revision_json JSONB NOT NULL,
 PRIMARY KEY(organization_id,run_id,base_attempt_id,revision_id),UNIQUE(organization_id,idempotency_key),UNIQUE(organization_id,run_id,base_attempt_id,ordinal),
 FOREIGN KEY(organization_id,study_id,run_id) REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
 FOREIGN KEY(organization_id,run_id,base_attempt_id,parent_revision_id) REFERENCES market_theme_selection_revisions(organization_id,run_id,base_attempt_id,revision_id) ON DELETE RESTRICT,
 CHECK((ordinal=1)=(parent_revision_id IS NULL)),CHECK(jsonb_typeof(request_json)='object' AND jsonb_typeof(facts_json)='object' AND jsonb_typeof(revision_json)='object'),
 CHECK(request_hash ~ '^[a-f0-9]{64}$' AND facts_hash ~ '^[a-f0-9]{64}$'),
 CHECK((revision_json->>'revisionId') IS NOT DISTINCT FROM revision_id),CHECK((revision_json->>'parentRevisionId') IS NOT DISTINCT FROM parent_revision_id),
 CHECK((revision_json->>'authorId') IS NOT DISTINCT FROM stored_by),CHECK((revision_json->>'baseReportAttemptId') IS NOT DISTINCT FROM base_attempt_id::text),
 CHECK((request_json->>'expectedParentRevisionId') IS NOT DISTINCT FROM parent_revision_id)
);
CREATE UNIQUE INDEX market_theme_selection_parent ON market_theme_selection_revisions(organization_id,run_id,base_attempt_id,COALESCE(parent_revision_id,''));
CREATE FUNCTION validate_market_theme_selection_revision() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM market_analysis_module_runs r WHERE r.id=NEW.run_id AND r.organization_id=NEW.organization_id AND r.study_id=NEW.study_id AND r.request_json->>'moduleKind'='customer-themes' AND r.request_json->'scope'=NEW.facts_json->'base'->'report'->'scope') THEN RAISE EXCEPTION 'Theme selection scope differs'; END IF;
 IF NEW.parent_revision_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM market_theme_selection_revisions p WHERE p.organization_id=NEW.organization_id AND p.run_id=NEW.run_id AND p.base_attempt_id=NEW.base_attempt_id AND p.revision_id=NEW.parent_revision_id AND p.ordinal=NEW.ordinal-1 AND p.facts_hash=NEW.facts_hash) THEN RAISE EXCEPTION 'Theme selection parent or base differs'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER market_theme_selection_scope BEFORE INSERT ON market_theme_selection_revisions FOR EACH ROW EXECUTE FUNCTION validate_market_theme_selection_revision();
CREATE TRIGGER market_theme_selection_immutable BEFORE UPDATE OR DELETE ON market_theme_selection_revisions FOR EACH ROW EXECUTE FUNCTION protect_market_analysis_snapshot();
