CREATE UNIQUE INDEX market_inputs_scoped_identity ON market_analysis_inputs(organization_id,study_id,id);
CREATE TABLE market_analysis_semantic_snapshot_bindings (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, study_id TEXT NOT NULL, module_run_id UUID NOT NULL,
  input_snapshot_id TEXT NOT NULL, input_digest TEXT NOT NULL CHECK(input_digest ~ '^[a-f0-9]{64}$'),
  selection_revision TEXT NOT NULL, batch_key TEXT NOT NULL, task TEXT NOT NULL,
  input_json JSONB NOT NULL, source_refs_json JSONB NOT NULL, member_refs_json JSONB NOT NULL,
  data_cutoff_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(module_run_id,batch_key,input_digest), UNIQUE(organization_id,study_id,module_run_id,id),
  FOREIGN KEY(organization_id,study_id,module_run_id) REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,study_id,input_snapshot_id) REFERENCES market_analysis_inputs(organization_id,study_id,id) ON DELETE RESTRICT,
  CHECK(task IN ('market-overview-explanation','market-product-shape-suggestion','market-keyword-semantics','market-customer-theme-mapping')),
  CHECK(jsonb_typeof(input_json)='object' AND jsonb_typeof(source_refs_json)='array' AND jsonb_typeof(member_refs_json)='array'),
  CHECK(input_json->>'inputDigest'=input_digest AND input_json->>'task'=task AND input_json->>'contentSnapshotId'=input_snapshot_id),
  CHECK(input_json->>'selectionRevision'=selection_revision AND input_json->>'batchKey'=batch_key),
  CHECK(data_cutoff_at<=created_at)
);
CREATE TABLE market_agent_runs (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, study_id TEXT NOT NULL,
  module_run_id UUID NOT NULL, step_id UUID NOT NULL, attempt_id UUID NOT NULL UNIQUE,
  binding_id UUID NOT NULL, skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  task TEXT NOT NULL, begin_identity_json JSONB NOT NULL, input_summary_json JSONB NOT NULL,
  execution_fingerprint TEXT NOT NULL CHECK(execution_fingerprint ~ '^[a-f0-9]{64}$'),
  output_schema_digest TEXT NOT NULL CHECK(output_schema_digest ~ '^[a-f0-9]{64}$'),
  provider TEXT NOT NULL, model TEXT NOT NULL, output_schema_version TEXT NOT NULL,
  data_cutoff_at TIMESTAMPTZ NOT NULL,
  validation_status TEXT NOT NULL DEFAULT 'pending' CHECK(validation_status IN ('pending','passed','failed')),
  terminal_status TEXT CHECK(terminal_status IN ('succeeded','failed','budget-exceeded','cancelled')),
  output_json JSONB, error_json JSONB, terminal_metadata_json JSONB, attempts_json JSONB,
  outcome_json JSONB, outcome_hash TEXT CHECK(outcome_hash ~ '^[a-f0-9]{64}$'),
  input_tokens BIGINT, output_tokens BIGINT, estimated_cost_micros BIGINT, duration_ms BIGINT, attempt_count INTEGER,
  usage_completeness TEXT CHECK(usage_completeness IN ('complete','partial','unavailable')),
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), completed_at TIMESTAMPTZ,
  execution_claim_token UUID NOT NULL, execution_claim_owner_id UUID NOT NULL, execution_claim_generation INTEGER NOT NULL CHECK(execution_claim_generation>0),
  execution_claim_acquired_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), execution_claim_expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(organization_id,module_run_id,step_id,attempt_id,id),
  FOREIGN KEY(organization_id,module_run_id,step_id,attempt_id) REFERENCES market_analysis_step_attempts(organization_id,run_id,step_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,study_id,module_run_id,binding_id) REFERENCES market_analysis_semantic_snapshot_bindings(organization_id,study_id,module_run_id,id) ON DELETE RESTRICT,
  CHECK((validation_status='pending' AND terminal_status IS NULL AND completed_at IS NULL AND outcome_json IS NULL AND outcome_hash IS NULL)
    OR (validation_status<>'pending' AND terminal_status IS NOT NULL AND completed_at IS NOT NULL AND outcome_json IS NOT NULL AND outcome_hash IS NOT NULL)),
  CHECK((validation_status='passed')=(terminal_status IS NOT DISTINCT FROM 'succeeded')),
  CHECK(input_tokens BETWEEN 0 AND 9007199254740991), CHECK(output_tokens BETWEEN 0 AND 9007199254740991),
  CHECK(estimated_cost_micros BETWEEN 0 AND 9007199254740991), CHECK(duration_ms BETWEEN 0 AND 9007199254740991),
  CHECK(attempt_count BETWEEN 0 AND 4), CHECK(data_cutoff_at<=started_at)
);
CREATE INDEX market_agent_runs_scope ON market_agent_runs(organization_id,module_run_id,started_at,id);
CREATE FUNCTION protect_market_semantic_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='market_analysis_semantic_snapshot_bindings' OR TG_OP='DELETE' THEN RAISE EXCEPTION 'Market semantic history is immutable'; END IF;
  IF OLD.validation_status<>'pending' THEN RAISE EXCEPTION 'Terminal market model audit is immutable'; END IF;
  IF (to_jsonb(NEW)-ARRAY['validation_status','terminal_status','output_json','error_json','terminal_metadata_json','attempts_json','outcome_json','outcome_hash','input_tokens','output_tokens','estimated_cost_micros','duration_ms','attempt_count','usage_completeness','completed_at','execution_claim_token','execution_claim_owner_id','execution_claim_generation','execution_claim_acquired_at','execution_claim_expires_at']) IS DISTINCT FROM
     (to_jsonb(OLD)-ARRAY['validation_status','terminal_status','output_json','error_json','terminal_metadata_json','attempts_json','outcome_json','outcome_hash','input_tokens','output_tokens','estimated_cost_micros','duration_ms','attempt_count','usage_completeness','completed_at','execution_claim_token','execution_claim_owner_id','execution_claim_generation','execution_claim_acquired_at','execution_claim_expires_at']) THEN
    RAISE EXCEPTION 'Market model audit identity is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER market_binding_immutable BEFORE UPDATE OR DELETE ON market_analysis_semantic_snapshot_bindings FOR EACH ROW EXECUTE FUNCTION protect_market_semantic_history();
CREATE TRIGGER market_agent_history BEFORE UPDATE OR DELETE ON market_agent_runs FOR EACH ROW EXECUTE FUNCTION protect_market_semantic_history();
