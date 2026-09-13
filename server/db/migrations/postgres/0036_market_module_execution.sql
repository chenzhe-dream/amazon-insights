CREATE TABLE market_analysis_module_runs (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, study_id TEXT NOT NULL,
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_json JSONB NOT NULL, request_fingerprint TEXT NOT NULL CHECK(request_fingerprint ~ '^[a-f0-9]{64}$'),
  status TEXT NOT NULL CHECK(status IN ('queued','running','partial','succeeded','failed','cancelled')),
  plan_revision INTEGER NOT NULL DEFAULT 0 CHECK(plan_revision>=0),
  latest_report_attempt_id UUID, cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,id), UNIQUE(organization_id,study_id,id), UNIQUE(organization_id,request_fingerprint),
  FOREIGN KEY(organization_id,study_id) REFERENCES market_analysis_studies(organization_id,id) ON DELETE RESTRICT,
  CHECK(request_json->'scope'->>'organizationId'=organization_id), CHECK(request_json->'scope'->>'researchId'=study_id)
);
CREATE TABLE market_analysis_steps (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, study_id TEXT NOT NULL, run_id UUID NOT NULL,
  step_key TEXT NOT NULL, definition_json JSONB NOT NULL, input_hash TEXT NOT NULL CHECK(input_hash ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL CHECK(kind IN ('collect-product-month','collect-keyword-page','collect-keyword-trend','collect-customer-themes','prepare-members','prepare-keyword-pool','prepare-model-batches','reconcile','model-batch','rules','report')),
  status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','empty','failed','cancelled')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0), retry_round INTEGER NOT NULL DEFAULT 0 CHECK(retry_round>=0),
  round_attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(round_attempt_count BETWEEN 0 AND 3),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  lease_owner_id UUID, lease_generation INTEGER NOT NULL DEFAULT 0 CHECK(lease_generation>=0), lease_until TIMESTAMPTZ,
  latest_attempt_id UUID, parent_step_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(run_id,step_key), UNIQUE(organization_id,run_id,id),
  FOREIGN KEY(organization_id,study_id,run_id) REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,run_id,parent_step_id) REFERENCES market_analysis_steps(organization_id,run_id,id) ON DELETE RESTRICT,
  CHECK((status='running' AND lease_owner_id IS NOT NULL AND lease_until IS NOT NULL) OR
        (status<>'running' AND lease_owner_id IS NULL AND lease_until IS NULL)),
  CHECK(definition_json->>'stepKey'=step_key), CHECK(definition_json->>'kind'=kind)
);
CREATE TABLE market_analysis_step_attempts (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, study_id TEXT NOT NULL, run_id UUID NOT NULL, step_id UUID NOT NULL,
  attempt_number INTEGER NOT NULL CHECK(attempt_number>0), retry_round INTEGER NOT NULL CHECK(retry_round>=0),
  lease_owner_id UUID NOT NULL, lease_generation INTEGER NOT NULL CHECK(lease_generation>0), input_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('running','succeeded','empty','failed','cancelled','interrupted')),
  output_json JSONB, error_json JSONB, diagnostic_json JSONB, output_hash TEXT, completion_hash TEXT, receipt_json JSONB,
  started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(), finished_at TIMESTAMPTZ,
  UNIQUE(step_id,attempt_number), UNIQUE(organization_id,run_id,step_id,id), UNIQUE(organization_id,run_id,id),
  FOREIGN KEY(organization_id,run_id,step_id) REFERENCES market_analysis_steps(organization_id,run_id,id) ON DELETE RESTRICT,
  FOREIGN KEY(organization_id,study_id,run_id) REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  CHECK((status='running')=(finished_at IS NULL)),
  CHECK(completion_hash IS NULL OR completion_hash ~ '^[a-f0-9]{64}$'),
  CHECK(output_hash IS NULL OR output_hash ~ '^[a-f0-9]{64}$')
);
ALTER TABLE market_analysis_steps ADD FOREIGN KEY(organization_id,run_id,id,latest_attempt_id)
  REFERENCES market_analysis_step_attempts(organization_id,run_id,step_id,id) ON DELETE RESTRICT;
ALTER TABLE market_analysis_module_runs ADD FOREIGN KEY(organization_id,id,latest_report_attempt_id)
  REFERENCES market_analysis_step_attempts(organization_id,run_id,id) ON DELETE RESTRICT;
CREATE TABLE market_analysis_commands (
  id UUID PRIMARY KEY, organization_id TEXT NOT NULL, run_id UUID NOT NULL,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('create','retry-failed','cancel')), idempotency_key UUID NOT NULL,
  request_hash TEXT NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'), receipt_json JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(organization_id,kind,idempotency_key),
  FOREIGN KEY(organization_id,run_id) REFERENCES market_analysis_module_runs(organization_id,id) ON DELETE RESTRICT
);
CREATE INDEX market_analysis_steps_claim ON market_analysis_steps(run_id,next_attempt_at,created_at,id) WHERE status IN ('queued','running');
CREATE INDEX market_analysis_module_runs_history ON market_analysis_module_runs(organization_id,study_id,created_at DESC,id);
CREATE FUNCTION protect_market_execution_history() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Market execution history cannot be deleted'; END IF;
  IF TG_TABLE_NAME='market_analysis_commands' THEN RAISE EXCEPTION 'Market execution commands are immutable'; END IF;
  IF TG_TABLE_NAME='market_analysis_step_attempts' THEN
    IF OLD.status<>'running' THEN RAISE EXCEPTION 'Finished market attempts are immutable'; END IF;
    IF (to_jsonb(NEW)-ARRAY['status','output_json','error_json','diagnostic_json','output_hash','completion_hash','receipt_json','finished_at']) IS DISTINCT FROM
       (to_jsonb(OLD)-ARRAY['status','output_json','error_json','diagnostic_json','output_hash','completion_hash','receipt_json','finished_at']) THEN
      RAISE EXCEPTION 'Market attempt identity is immutable';
    END IF;
  ELSIF TG_TABLE_NAME='market_analysis_steps' THEN
    IF OLD.status IN ('succeeded','empty') THEN RAISE EXCEPTION 'Successful market steps are immutable'; END IF;
    IF (NEW.id,NEW.organization_id,NEW.study_id,NEW.run_id,NEW.step_key,NEW.definition_json,NEW.input_hash,NEW.kind,NEW.parent_step_id)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.study_id,OLD.run_id,OLD.step_key,OLD.definition_json,OLD.input_hash,OLD.kind,OLD.parent_step_id) THEN
      RAISE EXCEPTION 'Market step identity is immutable';
    END IF;
  ELSE
    IF (NEW.id,NEW.organization_id,NEW.study_id,NEW.created_by,NEW.request_json,NEW.request_fingerprint,NEW.created_at)
      IS DISTINCT FROM (OLD.id,OLD.organization_id,OLD.study_id,OLD.created_by,OLD.request_json,OLD.request_fingerprint,OLD.created_at) THEN
      RAISE EXCEPTION 'Market run identity is immutable';
    END IF;
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER market_runs_protect BEFORE UPDATE OR DELETE ON market_analysis_module_runs FOR EACH ROW EXECUTE FUNCTION protect_market_execution_history();
CREATE TRIGGER market_steps_protect BEFORE UPDATE OR DELETE ON market_analysis_steps FOR EACH ROW EXECUTE FUNCTION protect_market_execution_history();
CREATE TRIGGER market_attempts_protect BEFORE UPDATE OR DELETE ON market_analysis_step_attempts FOR EACH ROW EXECUTE FUNCTION protect_market_execution_history();
CREATE TRIGGER market_commands_protect BEFORE UPDATE OR DELETE ON market_analysis_commands FOR EACH ROW EXECUTE FUNCTION protect_market_execution_history();
CREATE FUNCTION validate_market_execution_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM market_analysis_studies s WHERE s.id=NEW.study_id AND s.organization_id=NEW.organization_id AND s.scope_json=NEW.request_json->'scope') THEN
    RAISE EXCEPTION 'Market execution scope must equal its immutable study';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER market_runs_scope BEFORE INSERT ON market_analysis_module_runs FOR EACH ROW EXECUTE FUNCTION validate_market_execution_scope();
