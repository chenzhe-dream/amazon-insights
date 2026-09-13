ALTER TABLE model_budget_reservations
  ALTER COLUMN run_id DROP NOT NULL,
  ALTER COLUMN project_id DROP NOT NULL,
  ADD COLUMN subject_kind TEXT NOT NULL DEFAULT 'project-analysis',
  ADD COLUMN market_study_id TEXT,
  ADD COLUMN market_module_run_id UUID,
  ADD COLUMN market_step_id UUID,
  ADD COLUMN market_attempt_id UUID,
  ADD COLUMN market_agent_run_id UUID,
  ADD COLUMN market_claim_token UUID,
  ADD COLUMN market_lease_owner_id UUID,
  ADD COLUMN market_lease_generation INTEGER,
  ADD COLUMN market_data_cutoff_at TIMESTAMPTZ,
  ADD COLUMN market_request_ordinal INTEGER,
  ADD COLUMN market_attempt_kind TEXT,
  ADD COLUMN market_transient_retry_count INTEGER,
  ADD COLUMN market_format_repair BOOLEAN,
  ADD CONSTRAINT market_budget_native_authority_fk
    FOREIGN KEY (organization_id,market_module_run_id,market_step_id,market_attempt_id,market_agent_run_id)
    REFERENCES market_agent_runs(organization_id,module_run_id,step_id,attempt_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT market_budget_study_fk
    FOREIGN KEY (organization_id,market_study_id,market_module_run_id)
    REFERENCES market_analysis_module_runs(organization_id,study_id,id) ON DELETE RESTRICT,
  ADD CONSTRAINT model_budget_subject_branch CHECK (
    (subject_kind='project-analysis' AND run_id IS NOT NULL AND project_id IS NOT NULL
      AND market_study_id IS NULL AND market_module_run_id IS NULL AND market_step_id IS NULL
      AND market_attempt_id IS NULL AND market_agent_run_id IS NULL AND market_claim_token IS NULL
      AND market_lease_owner_id IS NULL AND market_lease_generation IS NULL AND market_data_cutoff_at IS NULL
      AND market_request_ordinal IS NULL AND market_attempt_kind IS NULL
      AND market_transient_retry_count IS NULL AND market_format_repair IS NULL)
    OR
    (subject_kind='market-module-run' AND run_id IS NULL AND project_id IS NULL AND job_attempt_id IS NULL AND agent_run_id IS NULL
      AND request_ordinal IS NULL AND attempt_kind IS NULL AND transient_retry_count IS NULL AND format_repair IS NULL
      AND market_study_id IS NOT NULL AND market_module_run_id IS NOT NULL AND market_step_id IS NOT NULL
      AND market_attempt_id IS NOT NULL AND market_agent_run_id IS NOT NULL AND market_claim_token IS NOT NULL
      AND market_lease_owner_id IS NOT NULL AND market_lease_generation IS NOT NULL AND market_lease_generation>0 AND market_data_cutoff_at IS NOT NULL
      AND market_request_ordinal IS NOT NULL AND market_request_ordinal BETWEEN 0 AND 3
      AND market_attempt_kind IS NOT NULL AND market_attempt_kind IN ('initial','transient-retry','format-repair')
      AND market_transient_retry_count IS NOT NULL AND market_transient_retry_count BETWEEN 0 AND 2
      AND market_format_repair IS NOT NULL
      AND ((market_attempt_kind='initial' AND market_request_ordinal=0 AND market_transient_retry_count=0 AND NOT market_format_repair)
        OR (market_attempt_kind='transient-retry' AND market_request_ordinal>0 AND market_transient_retry_count>0 AND market_transient_retry_count<=market_request_ordinal)
        OR (market_attempt_kind='format-repair' AND market_request_ordinal>0 AND market_format_repair AND market_transient_retry_count<=market_request_ordinal)))
  );
CREATE UNIQUE INDEX market_budget_idempotency ON model_budget_reservations(market_module_run_id,idempotency_key) WHERE subject_kind='market-module-run';
CREATE UNIQUE INDEX market_budget_agent_ordinal ON model_budget_reservations(market_agent_run_id,market_request_ordinal) WHERE subject_kind='market-module-run';
CREATE INDEX market_budget_run_usage ON model_budget_reservations(market_module_run_id,state,created_at) WHERE subject_kind='market-module-run';
CREATE FUNCTION protect_market_budget_identity() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.subject_kind='market-module-run' THEN RAISE EXCEPTION 'Market model accounting cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.subject_kind IS DISTINCT FROM OLD.subject_kind THEN RAISE EXCEPTION 'Budget subject kind is immutable'; END IF;
  IF OLD.subject_kind='market-module-run' THEN
    IF OLD.state IN ('settled','released') AND NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'Terminal market accounting is immutable';
    END IF;
    IF (OLD.state='reserved' AND NEW.state NOT IN ('reserved','dispatched','released'))
      OR (OLD.state='dispatched' AND NEW.state NOT IN ('dispatched','settled')) THEN
      RAISE EXCEPTION 'Invalid market accounting transition';
    END IF;
    IF OLD.dispatched_at IS NOT NULL AND NEW.dispatched_at IS DISTINCT FROM OLD.dispatched_at THEN
      RAISE EXCEPTION 'Market dispatch evidence is immutable';
    END IF;
  END IF;
  IF OLD.subject_kind='market-module-run' AND
    (to_jsonb(NEW)-ARRAY['state','actual_input_tokens','actual_output_tokens','actual_cost_micros','lease_expires_at','updated_at','dispatched_at','settled_at','released_at','response_id']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['state','actual_input_tokens','actual_output_tokens','actual_cost_micros','lease_expires_at','updated_at','dispatched_at','settled_at','released_at','response_id']) THEN
    RAISE EXCEPTION 'Market budget request provenance is immutable';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER market_budget_identity_protect BEFORE UPDATE OR DELETE ON model_budget_reservations FOR EACH ROW EXECUTE FUNCTION protect_market_budget_identity();
