ALTER TABLE agent_runs
  ADD COLUMN execution_fingerprint TEXT CHECK (
    execution_fingerprint IS NULL
    OR execution_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN output_schema_digest TEXT CHECK (
    output_schema_digest IS NULL
    OR output_schema_digest ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN terminal_status TEXT CHECK (
    terminal_status IS NULL
    OR terminal_status IN ('succeeded', 'failed', 'budget-exceeded', 'cancelled')
  ),
  ADD COLUMN usage_completeness TEXT CHECK (
    usage_completeness IS NULL
    OR usage_completeness IN ('complete', 'partial', 'unavailable')
  ),
  ADD COLUMN attempt_count INTEGER CHECK (
    attempt_count IS NULL OR attempt_count BETWEEN 0 AND 4
  ),
  ADD COLUMN attempts_json JSONB CHECK (
    attempts_json IS NULL OR jsonb_typeof(attempts_json) = 'array'
  ),
  ADD COLUMN execution_claim_token TEXT CHECK (
    execution_claim_token IS NULL
    OR char_length(execution_claim_token) BETWEEN 1 AND 200
  ),
  ADD COLUMN execution_claim_owner_id TEXT CHECK (
    execution_claim_owner_id IS NULL
    OR char_length(execution_claim_owner_id) BETWEEN 1 AND 200
  ),
  ADD COLUMN execution_claim_generation INTEGER CHECK (
    execution_claim_generation IS NULL OR execution_claim_generation > 0
  ),
  ADD COLUMN execution_claim_acquired_at TIMESTAMPTZ,
  ADD COLUMN execution_claim_expires_at TIMESTAMPTZ,
  ADD COLUMN terminal_metadata_json JSONB CHECK (
    terminal_metadata_json IS NULL
    OR jsonb_typeof(terminal_metadata_json) = 'object'
  );

ALTER TABLE model_budget_reservations
  ADD COLUMN IF NOT EXISTS job_attempt_id TEXT
    REFERENCES job_attempts(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS request_ordinal INTEGER CHECK (
    request_ordinal IS NULL OR request_ordinal BETWEEN 0 AND 3
  ),
  ADD COLUMN IF NOT EXISTS attempt_kind TEXT CHECK (
    attempt_kind IS NULL
    OR attempt_kind IN ('initial', 'transient-retry', 'format-repair')
  ),
  ADD COLUMN IF NOT EXISTS transient_retry_count INTEGER CHECK (
    transient_retry_count IS NULL OR transient_retry_count BETWEEN 0 AND 2
  ),
  ADD COLUMN IF NOT EXISTS format_repair BOOLEAN,
  ADD COLUMN IF NOT EXISTS response_id TEXT CHECK (
    response_id IS NULL OR char_length(response_id) BETWEEN 1 AND 500
  );

CREATE UNIQUE INDEX agent_runs_job_attempt_idx
ON agent_runs (job_attempt_id)
WHERE job_attempt_id IS NOT NULL AND execution_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS model_budget_job_attempt_ordinal_idx
ON model_budget_reservations (job_attempt_id, request_ordinal)
WHERE job_attempt_id IS NOT NULL;

CREATE TABLE agent_run_snapshots (
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (agent_run_id, snapshot_id),
  UNIQUE (agent_run_id, ordinal)
);

CREATE INDEX agent_run_snapshots_snapshot_idx
ON agent_run_snapshots (snapshot_id, agent_run_id);

CREATE FUNCTION enforce_agent_run_audit_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.execution_fingerprint IS NULL
    OR NEW.output_schema_digest IS NULL
    OR NEW.job_attempt_id IS NULL
    OR NEW.validation_status <> 'pending'
    OR NEW.terminal_status IS NOT NULL
    OR NEW.response_id IS NOT NULL
    OR NEW.output_json IS NOT NULL
    OR NEW.error_json IS NOT NULL
    OR NEW.input_tokens IS NOT NULL
    OR NEW.output_tokens IS NOT NULL
    OR NEW.duration_ms IS NOT NULL
    OR NEW.estimated_cost_micros IS NOT NULL
    OR NEW.usage_completeness IS NOT NULL
    OR NEW.attempt_count IS NOT NULL
    OR NEW.attempts_json IS DISTINCT FROM '[]'::jsonb
    OR NEW.execution_claim_token IS NULL
    OR NEW.execution_claim_owner_id IS NULL
    OR NEW.execution_claim_generation IS NULL
    OR NEW.execution_claim_acquired_at IS NULL
    OR NEW.execution_claim_expires_at IS NULL
    OR NEW.execution_claim_expires_at <= NEW.execution_claim_acquired_at
    OR NEW.terminal_metadata_json IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR jsonb_typeof(NEW.snapshot_ids_json) <> 'array'
    OR jsonb_array_length(NEW.snapshot_ids_json) < 1
  THEN
    RAISE EXCEPTION 'invalid pending agent run audit';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM run_stages
     WHERE id = NEW.stage_id AND run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'agent run stage does not belong to run';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM analysis_runs
     WHERE id = NEW.run_id AND data_cutoff_at = NEW.data_cutoff_at
  ) THEN
    RAISE EXCEPTION 'agent run cutoff does not match run';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM job_attempts
     WHERE id = NEW.job_attempt_id AND stage_id = NEW.stage_id
       AND status = 'running'
       AND leased_by = NEW.execution_claim_owner_id
       AND lease_generation = NEW.execution_claim_generation
       AND lease_expires_at > NEW.execution_claim_acquired_at
  ) THEN
    RAISE EXCEPTION 'agent run job does not belong to stage';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_audit_insert_consistency
BEFORE INSERT ON agent_runs
FOR EACH ROW
WHEN (
  NEW.execution_fingerprint IS NOT NULL
  OR NEW.output_schema_digest IS NOT NULL
  OR NEW.usage_completeness IS NOT NULL
  OR NEW.attempt_count IS NOT NULL
  OR NEW.attempts_json IS NOT NULL
  OR NEW.execution_claim_token IS NOT NULL
  OR NEW.execution_claim_owner_id IS NOT NULL
  OR NEW.execution_claim_generation IS NOT NULL
  OR NEW.execution_claim_acquired_at IS NOT NULL
  OR NEW.execution_claim_expires_at IS NOT NULL
  OR NEW.terminal_metadata_json IS NOT NULL
)
EXECUTE FUNCTION enforce_agent_run_audit_insert();

CREATE FUNCTION enforce_agent_run_snapshot_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM agent_runs ar
      JOIN data_snapshots ds ON ds.id = NEW.snapshot_id
     WHERE ar.id = NEW.agent_run_id
       AND ar.validation_status = 'pending'
       AND ds.run_id = ar.run_id
       AND ds.data_cutoff_at = ar.data_cutoff_at
       AND jsonb_typeof(ar.snapshot_ids_json) = 'array'
       AND NEW.ordinal < jsonb_array_length(ar.snapshot_ids_json)
       AND ar.snapshot_ids_json ->> NEW.ordinal = NEW.snapshot_id
  ) THEN
    RAISE EXCEPTION 'agent run snapshot does not belong to run';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_run_snapshots_run_consistency
BEFORE INSERT ON agent_run_snapshots
FOR EACH ROW EXECUTE FUNCTION enforce_agent_run_snapshot_insert();

CREATE FUNCTION prevent_agent_run_snapshot_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent run snapshot links are immutable';
END;
$$;

CREATE TRIGGER agent_run_snapshots_update_immutable
BEFORE UPDATE ON agent_run_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_agent_run_snapshot_mutation();

CREATE TRIGGER agent_run_snapshots_delete_immutable
BEFORE DELETE ON agent_run_snapshots
FOR EACH ROW EXECUTE FUNCTION prevent_agent_run_snapshot_mutation();

CREATE FUNCTION enforce_model_budget_attempt_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.job_attempt_id IS NULL
    OR NEW.request_ordinal IS NULL
    OR NEW.attempt_kind IS NULL
    OR NEW.transient_retry_count IS NULL
    OR NEW.format_repair IS NULL
  THEN
    RAISE EXCEPTION 'incomplete model request attempt provenance';
  END IF;

  IF NOT (
    (NEW.attempt_kind = 'initial'
      AND NEW.request_ordinal = 0
      AND NEW.transient_retry_count = 0
      AND NEW.format_repair = FALSE)
    OR (NEW.attempt_kind = 'format-repair' AND NEW.format_repair = TRUE)
    OR (NEW.attempt_kind = 'transient-retry' AND NEW.transient_retry_count > 0)
  ) THEN
    RAISE EXCEPTION 'invalid model request attempt identity';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM job_attempts ja
      JOIN run_stages rs ON rs.id = ja.stage_id
     WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'model request job does not belong to run';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER model_budget_job_attempt_consistency
BEFORE INSERT ON model_budget_reservations
FOR EACH ROW
WHEN (
  NEW.job_attempt_id IS NOT NULL
  OR NEW.request_ordinal IS NOT NULL
  OR NEW.attempt_kind IS NOT NULL
  OR NEW.transient_retry_count IS NOT NULL
  OR NEW.format_repair IS NOT NULL
)
EXECUTE FUNCTION enforce_model_budget_attempt_insert();

CREATE FUNCTION enforce_model_budget_attempt_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.run_id,
    NEW.job_attempt_id,
    NEW.request_ordinal,
    NEW.attempt_kind,
    NEW.transient_retry_count,
    NEW.format_repair
  ) IS DISTINCT FROM ROW(
    OLD.run_id,
    OLD.job_attempt_id,
    OLD.request_ordinal,
    OLD.attempt_kind,
    OLD.transient_retry_count,
    OLD.format_repair
  ) THEN
    RAISE EXCEPTION 'model request attempt provenance is immutable';
  END IF;

  IF NEW.job_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM job_attempts ja
      JOIN run_stages rs ON rs.id = ja.stage_id
     WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'model request job no longer belongs to run';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER model_budget_attempt_provenance_immutable
BEFORE UPDATE ON model_budget_reservations
FOR EACH ROW
WHEN (OLD.job_attempt_id IS NOT NULL OR NEW.job_attempt_id IS NOT NULL)
EXECUTE FUNCTION enforce_model_budget_attempt_update();

CREATE FUNCTION enforce_model_budget_response_settle_once()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT (
    OLD.response_id IS NULL
    AND NEW.response_id IS NOT NULL
    AND OLD.state IN ('reserved', 'dispatched')
    AND NEW.state = 'settled'
    AND NEW.actual_input_tokens IS NOT NULL
    AND NEW.actual_output_tokens IS NOT NULL
    AND NEW.actual_cost_micros IS NOT NULL
    AND NEW.settled_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'model response id may only be set once during settle';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER model_budget_response_id_settle_once
BEFORE UPDATE ON model_budget_reservations
FOR EACH ROW
WHEN (NEW.response_id IS DISTINCT FROM OLD.response_id)
EXECUTE FUNCTION enforce_model_budget_response_settle_once();

CREATE FUNCTION prevent_completed_agent_run_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'completed agent runs are immutable';
END;
$$;

CREATE TRIGGER agent_runs_completed_immutable
BEFORE UPDATE ON agent_runs
FOR EACH ROW
WHEN (OLD.validation_status <> 'pending')
EXECUTE FUNCTION prevent_completed_agent_run_update();

CREATE FUNCTION enforce_pending_agent_run_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF ROW(
    NEW.id, NEW.run_id, NEW.stage_id, NEW.job_attempt_id,
    NEW.skill_version_id, NEW.schema_version, NEW.snapshot_ids_json,
    NEW.provider, NEW.model, NEW.response_id, NEW.input_summary_json,
    NEW.output_schema_version, NEW.output_json, NEW.input_tokens,
    NEW.output_tokens, NEW.duration_ms, NEW.estimated_cost_micros,
    NEW.error_json, NEW.data_cutoff_at, NEW.started_at, NEW.completed_at,
    NEW.execution_fingerprint, NEW.output_schema_digest, NEW.terminal_status,
    NEW.usage_completeness, NEW.attempt_count, NEW.attempts_json,
    NEW.terminal_metadata_json
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.run_id, OLD.stage_id, OLD.job_attempt_id,
    OLD.skill_version_id, OLD.schema_version, OLD.snapshot_ids_json,
    OLD.provider, OLD.model, OLD.response_id, OLD.input_summary_json,
    OLD.output_schema_version, OLD.output_json, OLD.input_tokens,
    OLD.output_tokens, OLD.duration_ms, OLD.estimated_cost_micros,
    OLD.error_json, OLD.data_cutoff_at, OLD.started_at, OLD.completed_at,
    OLD.execution_fingerprint, OLD.output_schema_digest, OLD.terminal_status,
    OLD.usage_completeness, OLD.attempt_count, OLD.attempts_json,
    OLD.terminal_metadata_json
  )
    OR NEW.execution_claim_token IS NOT DISTINCT FROM OLD.execution_claim_token
    OR NEW.execution_claim_token IS NULL
    OR NEW.execution_claim_owner_id IS NULL
    OR NEW.execution_claim_generation IS NULL
    OR NEW.execution_claim_acquired_at IS NULL
    OR NEW.execution_claim_expires_at IS NULL
    OR NEW.execution_claim_expires_at <= NEW.execution_claim_acquired_at
  THEN
    RAISE EXCEPTION 'pending agent run claim update is invalid';
  END IF;

  IF NOT (
    OLD.execution_claim_owner_id IS DISTINCT FROM NEW.execution_claim_owner_id
    OR OLD.execution_claim_generation IS DISTINCT FROM NEW.execution_claim_generation
  ) THEN
    RAISE EXCEPTION 'same worker lease agent run claim cannot be replaced';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM job_attempts
     WHERE id = NEW.job_attempt_id AND stage_id = NEW.stage_id
       AND status = 'running'
       AND leased_by = NEW.execution_claim_owner_id
       AND lease_generation = NEW.execution_claim_generation
       AND lease_expires_at > NEW.execution_claim_acquired_at
  ) THEN
    RAISE EXCEPTION 'replacement agent run claim has no active job lease';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_pending_update_requires_completion
BEFORE UPDATE ON agent_runs
FOR EACH ROW
WHEN (OLD.validation_status = 'pending' AND NEW.validation_status = 'pending')
EXECUTE FUNCTION enforce_pending_agent_run_update();

CREATE FUNCTION jsonb_object_key_count(value JSONB)
RETURNS BIGINT
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT count(*) FROM jsonb_object_keys(value);
$$;

CREATE FUNCTION enforce_agent_run_completion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  metadata_kind TEXT;
  metadata_scope TEXT;
  metadata_metric TEXT;
BEGIN
  IF ROW(
    NEW.id, NEW.run_id, NEW.stage_id, NEW.job_attempt_id,
    NEW.skill_version_id, NEW.schema_version, NEW.snapshot_ids_json,
    NEW.provider, NEW.model, NEW.input_summary_json,
    NEW.output_schema_version, NEW.data_cutoff_at, NEW.started_at,
    NEW.execution_fingerprint, NEW.output_schema_digest,
    NEW.execution_claim_token, NEW.execution_claim_owner_id,
    NEW.execution_claim_generation, NEW.execution_claim_acquired_at,
    NEW.execution_claim_expires_at
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.run_id, OLD.stage_id, OLD.job_attempt_id,
    OLD.skill_version_id, OLD.schema_version, OLD.snapshot_ids_json,
    OLD.provider, OLD.model, OLD.input_summary_json,
    OLD.output_schema_version, OLD.data_cutoff_at, OLD.started_at,
    OLD.execution_fingerprint, OLD.output_schema_digest,
    OLD.execution_claim_token, OLD.execution_claim_owner_id,
    OLD.execution_claim_generation, OLD.execution_claim_acquired_at,
    OLD.execution_claim_expires_at
  ) THEN
    RAISE EXCEPTION 'agent run execution identity is immutable';
  END IF;

  IF NEW.completed_at IS NULL
    OR NEW.terminal_status IS NULL
    OR NEW.attempt_count IS NULL
    OR NEW.attempts_json IS NULL
    OR jsonb_typeof(NEW.attempts_json) <> 'array'
    OR jsonb_array_length(NEW.attempts_json) <> NEW.attempt_count
    OR NEW.usage_completeness IS NULL
    OR NEW.terminal_metadata_json IS NULL
    OR jsonb_typeof(NEW.terminal_metadata_json) <> 'object'
  THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.validation_status = 'passed' AND (
    NEW.terminal_status <> 'succeeded'
    OR NEW.output_json IS NULL
    OR NEW.error_json IS NOT NULL
    OR NEW.attempt_count < 1
  ) THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.validation_status = 'failed' AND (
    NEW.terminal_status NOT IN ('failed', 'budget-exceeded', 'cancelled')
    OR NEW.output_json IS NOT NULL
    OR NEW.error_json IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.validation_status NOT IN ('passed', 'failed') THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  metadata_kind := NEW.terminal_metadata_json ->> 'kind';
  IF metadata_kind IS DISTINCT FROM NEW.terminal_status THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.terminal_status IN ('succeeded', 'cancelled') AND
    jsonb_object_key_count(NEW.terminal_metadata_json) <> 1
  THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.terminal_status = 'failed' AND (
    jsonb_object_key_count(NEW.terminal_metadata_json) <> 2
    OR NEW.terminal_metadata_json ->> 'classification' NOT IN (
      'validation', 'configuration', 'authentication', 'rate-limit',
      'upstream-temporary', 'upstream-permanent', 'data-quality',
      'model-output', 'infrastructure'
    )
  ) THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.terminal_status = 'budget-exceeded' THEN
    metadata_scope := NEW.terminal_metadata_json ->> 'scope';
    metadata_metric := NEW.terminal_metadata_json ->> 'metric';
    IF jsonb_object_key_count(NEW.terminal_metadata_json) <> 6
      OR metadata_scope NOT IN ('call', 'run', 'daily')
      OR metadata_metric NOT IN ('tokens', 'costUsd', 'costMicros')
      OR jsonb_typeof(NEW.terminal_metadata_json -> 'used') <> 'number'
      OR jsonb_typeof(NEW.terminal_metadata_json -> 'projected') <> 'number'
      OR jsonb_typeof(NEW.terminal_metadata_json -> 'limit') <> 'number'
      OR (NEW.terminal_metadata_json ->> 'used')::numeric < 0
      OR (NEW.terminal_metadata_json ->> 'projected')::numeric < 0
      OR (NEW.terminal_metadata_json ->> 'limit')::numeric < 0
    THEN
      RAISE EXCEPTION 'invalid completed agent run audit';
    END IF;
    IF metadata_metric IN ('tokens', 'costMicros') AND (
      NEW.terminal_metadata_json ->> 'used' !~ '^\d+$'
      OR NEW.terminal_metadata_json ->> 'projected' !~ '^\d+$'
      OR NEW.terminal_metadata_json ->> 'limit' !~ '^\d+$'
      OR (NEW.terminal_metadata_json ->> 'used')::numeric > 9007199254740991
      OR (NEW.terminal_metadata_json ->> 'projected')::numeric > 9007199254740991
      OR (NEW.terminal_metadata_json ->> 'limit')::numeric > 9007199254740991
    ) THEN
      RAISE EXCEPTION 'invalid completed agent run audit';
    END IF;
  END IF;

  IF NEW.usage_completeness IN ('complete', 'partial') AND (
    NEW.input_tokens IS NULL
    OR NEW.output_tokens IS NULL
    OR NEW.estimated_cost_micros IS NULL
  ) THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  IF NEW.usage_completeness = 'unavailable' AND (
    NEW.input_tokens IS NOT NULL
    OR NEW.output_tokens IS NOT NULL
    OR NEW.estimated_cost_micros IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'invalid completed agent run audit';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_completion_consistency
BEFORE UPDATE ON agent_runs
FOR EACH ROW
WHEN (OLD.validation_status = 'pending' AND NEW.validation_status <> 'pending')
EXECUTE FUNCTION enforce_agent_run_completion();

CREATE FUNCTION prevent_agent_run_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent runs are immutable';
END;
$$;

CREATE TRIGGER agent_runs_delete_immutable
BEFORE DELETE ON agent_runs
FOR EACH ROW EXECUTE FUNCTION prevent_agent_run_delete();
