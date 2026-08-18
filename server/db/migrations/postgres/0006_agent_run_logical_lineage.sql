ALTER TABLE job_attempts
  ADD COLUMN logical_execution_cycle_id TEXT CHECK (
    logical_execution_cycle_id IS NULL
    OR logical_execution_cycle_id ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN report_publication_cycle INTEGER
    NOT NULL DEFAULT 1 CHECK (report_publication_cycle > 0),
  ADD COLUMN report_publication_attempt_count INTEGER
    NOT NULL DEFAULT 0 CHECK (report_publication_attempt_count >= 0),
  ADD COLUMN report_publication_max_attempts INTEGER CHECK (
    report_publication_max_attempts IS NULL OR report_publication_max_attempts > 0
  ),
  ADD COLUMN report_publication_initial_delay_ms INTEGER CHECK (
    report_publication_initial_delay_ms IS NULL OR report_publication_initial_delay_ms > 0
  ),
  ADD COLUMN report_publication_max_delay_ms INTEGER CHECK (
    report_publication_max_delay_ms IS NULL OR report_publication_max_delay_ms > 0
  ),
  ADD COLUMN report_publication_retry_at TIMESTAMPTZ;

CREATE INDEX job_attempts_report_publication_retry_idx
ON job_attempts (status, retryable, report_publication_retry_at);

UPDATE job_attempts
SET logical_execution_cycle_id = encode(
  sha256(convert_to(
    id || ':' || random()::text || ':' || clock_timestamp()::text,
    'UTF8'
  )),
  'hex'
)
WHERE logical_execution_cycle_id IS NULL;

CREATE UNIQUE INDEX job_attempts_one_active_logical_cycle_idx
ON job_attempts (logical_execution_cycle_id)
WHERE status IN ('queued', 'running');

CREATE FUNCTION require_job_attempt_logical_cycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.logical_execution_cycle_id IS NULL THEN
    RAISE EXCEPTION 'job attempt logical execution cycle is required';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_attempts_logical_cycle_required
BEFORE INSERT ON job_attempts
FOR EACH ROW EXECUTE FUNCTION require_job_attempt_logical_cycle();

CREATE FUNCTION prevent_job_attempt_logical_cycle_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'job attempt logical execution cycle is immutable';
END;
$$;

CREATE TRIGGER job_attempts_logical_cycle_immutable
BEFORE UPDATE OF logical_execution_cycle_id ON job_attempts
FOR EACH ROW
WHEN (NEW.logical_execution_cycle_id IS DISTINCT FROM OLD.logical_execution_cycle_id)
EXECUTE FUNCTION prevent_job_attempt_logical_cycle_update();

CREATE FUNCTION job_report_publication_state_is_valid(attempt job_attempts)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  IF attempt.report_publication_cycle < 1
    OR attempt.report_publication_attempt_count < 0
  THEN
    RETURN FALSE;
  END IF;

  IF attempt.report_publication_max_attempts IS NULL
    AND attempt.report_publication_initial_delay_ms IS NULL
    AND attempt.report_publication_max_delay_ms IS NULL
    AND attempt.report_publication_attempt_count = 0
    AND attempt.report_publication_retry_at IS NULL
  THEN
    RETURN TRUE;
  END IF;

  IF attempt.report_publication_max_attempts IS NULL
    OR attempt.report_publication_max_attempts <= 0
    OR attempt.report_publication_initial_delay_ms IS NULL
    OR attempt.report_publication_initial_delay_ms <= 0
    OR attempt.report_publication_max_delay_ms IS NULL
    OR attempt.report_publication_max_delay_ms <= 0
    OR attempt.report_publication_initial_delay_ms > attempt.report_publication_max_delay_ms
    OR attempt.report_publication_attempt_count > attempt.report_publication_max_attempts
  THEN
    RETURN FALSE;
  END IF;

  IF attempt.status = 'failed'
    AND attempt.retryable = TRUE
    AND attempt.report_publication_attempt_count < attempt.report_publication_max_attempts
    AND attempt.report_publication_retry_at IS NOT NULL
  THEN
    RETURN TRUE;
  END IF;

  RETURN attempt.retryable = FALSE
    AND attempt.report_publication_retry_at IS NULL
    AND (
      attempt.status <> 'failed'
      OR attempt.report_publication_attempt_count = attempt.report_publication_max_attempts
    );
END;
$$;

CREATE FUNCTION enforce_job_report_publication_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT job_report_publication_state_is_valid(NEW) THEN
    RAISE EXCEPTION 'job attempt report publication state is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER job_attempts_report_publication_state_insert
BEFORE INSERT ON job_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_job_report_publication_insert();

CREATE FUNCTION enforce_job_report_publication_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT job_report_publication_state_is_valid(NEW) THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NOT (
    NEW.report_publication_cycle = OLD.report_publication_cycle
    OR (
      NEW.report_publication_cycle = OLD.report_publication_cycle + 1
      AND OLD.status = 'failed'
      AND OLD.retryable = FALSE
      AND OLD.report_publication_max_attempts IS NOT NULL
      AND OLD.report_publication_attempt_count = OLD.report_publication_max_attempts
      AND NEW.status = 'queued'
      AND NEW.retryable = FALSE
      AND NEW.report_publication_attempt_count = 0
      AND NEW.report_publication_max_attempts IS NULL
      AND NEW.report_publication_initial_delay_ms IS NULL
      AND NEW.report_publication_max_delay_ms IS NULL
      AND NEW.report_publication_retry_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NEW.report_publication_cycle = OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND NOT (
      (
        OLD.status = 'running'
        AND NEW.status = 'failed'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count + 1
      )
      OR (
        OLD.status = 'failed'
        AND OLD.retryable = TRUE
        AND NEW.status = 'running'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
      OR (
        OLD.status = 'running'
        AND NEW.status IN ('queued', 'succeeded')
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
      OR (
        OLD.status = NEW.status
        AND OLD.retryable = NEW.retryable
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
    )
  THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NEW.report_publication_cycle = OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND (
      NEW.report_publication_max_attempts IS DISTINCT FROM OLD.report_publication_max_attempts
      OR NEW.report_publication_initial_delay_ms IS DISTINCT FROM OLD.report_publication_initial_delay_ms
      OR NEW.report_publication_max_delay_ms IS DISTINCT FROM OLD.report_publication_max_delay_ms
      OR NEW.report_publication_attempt_count < OLD.report_publication_attempt_count
      OR NEW.report_publication_attempt_count > OLD.report_publication_attempt_count + 1
    )
  THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER job_attempts_report_publication_state_update
BEFORE UPDATE OF status,
  retryable,
  report_publication_cycle,
  report_publication_attempt_count,
  report_publication_max_attempts,
  report_publication_initial_delay_ms,
  report_publication_max_delay_ms,
  report_publication_retry_at ON job_attempts
FOR EACH ROW EXECUTE FUNCTION enforce_job_report_publication_update();

ALTER TABLE agent_runs
  ADD COLUMN logical_execution_lineage TEXT CHECK (
    logical_execution_lineage IS NULL
    OR logical_execution_lineage ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN logical_execution_cycle_id TEXT CHECK (
    logical_execution_cycle_id IS NULL
    OR logical_execution_cycle_id ~ '^[0-9a-f]{64}$'
  ),
  ADD COLUMN active_job_attempt_id TEXT
    REFERENCES job_attempts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX agent_runs_logical_execution_lineage_idx
ON agent_runs (logical_execution_lineage)
WHERE logical_execution_lineage IS NOT NULL;

CREATE UNIQUE INDEX agent_runs_one_per_logical_cycle_idx
ON agent_runs (stage_id, logical_execution_cycle_id)
WHERE logical_execution_cycle_id IS NOT NULL;

CREATE FUNCTION prevent_agent_run_logical_lineage_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent run logical execution lineage is immutable';
END;
$$;

CREATE TRIGGER agent_runs_logical_execution_lineage_immutable
BEFORE UPDATE OF logical_execution_lineage ON agent_runs
FOR EACH ROW
WHEN (NEW.logical_execution_lineage IS DISTINCT FROM OLD.logical_execution_lineage)
EXECUTE FUNCTION prevent_agent_run_logical_lineage_update();

CREATE FUNCTION prevent_agent_run_logical_cycle_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent run logical execution cycle is immutable';
END;
$$;

CREATE TRIGGER agent_runs_logical_cycle_immutable
BEFORE UPDATE OF logical_execution_cycle_id ON agent_runs
FOR EACH ROW
WHEN (NEW.logical_execution_cycle_id IS DISTINCT FROM OLD.logical_execution_cycle_id)
EXECUTE FUNCTION prevent_agent_run_logical_cycle_update();

CREATE FUNCTION enforce_agent_run_logical_cycle_insert()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.logical_execution_lineage IS NULL
    AND (
      NEW.logical_execution_cycle_id IS NOT NULL
      OR NEW.active_job_attempt_id IS NOT NULL
    )
  ) OR (
    NEW.logical_execution_lineage IS NOT NULL
    AND (
      NEW.logical_execution_cycle_id IS NULL
      OR NEW.active_job_attempt_id IS DISTINCT FROM NEW.job_attempt_id
      OR NOT EXISTS (
        SELECT 1
          FROM job_attempts attempt
         WHERE attempt.id = NEW.job_attempt_id
           AND attempt.logical_execution_cycle_id = NEW.logical_execution_cycle_id
      )
    )
  ) THEN
    RAISE EXCEPTION 'agent run logical cycle has no trusted job authority';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER agent_runs_logical_cycle_insert_consistency
BEFORE INSERT ON agent_runs
FOR EACH ROW EXECUTE FUNCTION enforce_agent_run_logical_cycle_insert();

CREATE FUNCTION prevent_agent_run_active_attempt_completion_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'agent run active recovery authority is immutable at completion';
END;
$$;

CREATE TRIGGER agent_runs_active_attempt_completion_immutable
BEFORE UPDATE OF active_job_attempt_id ON agent_runs
FOR EACH ROW
WHEN (
  OLD.validation_status = 'pending'
  AND NEW.validation_status <> 'pending'
  AND NEW.active_job_attempt_id IS DISTINCT FROM OLD.active_job_attempt_id
)
EXECUTE FUNCTION prevent_agent_run_active_attempt_completion_update();

DROP TRIGGER agent_runs_pending_update_requires_completion ON agent_runs;
DROP FUNCTION enforce_pending_agent_run_update();

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
    NEW.execution_fingerprint, NEW.output_schema_digest,
    NEW.logical_execution_lineage, NEW.logical_execution_cycle_id,
    NEW.terminal_status, NEW.usage_completeness, NEW.attempt_count,
    NEW.attempts_json, NEW.terminal_metadata_json
  ) IS DISTINCT FROM ROW(
    OLD.id, OLD.run_id, OLD.stage_id, OLD.job_attempt_id,
    OLD.skill_version_id, OLD.schema_version, OLD.snapshot_ids_json,
    OLD.provider, OLD.model, OLD.response_id, OLD.input_summary_json,
    OLD.output_schema_version, OLD.output_json, OLD.input_tokens,
    OLD.output_tokens, OLD.duration_ms, OLD.estimated_cost_micros,
    OLD.error_json, OLD.data_cutoff_at, OLD.started_at, OLD.completed_at,
    OLD.execution_fingerprint, OLD.output_schema_digest,
    OLD.logical_execution_lineage, OLD.logical_execution_cycle_id,
    OLD.terminal_status, OLD.usage_completeness, OLD.attempt_count,
    OLD.attempts_json, OLD.terminal_metadata_json
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
    OR OLD.active_job_attempt_id IS DISTINCT FROM NEW.active_job_attempt_id
  ) THEN
    RAISE EXCEPTION 'same worker lease agent run claim cannot be replaced';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM job_attempts attempt
     WHERE attempt.id = COALESCE(NEW.active_job_attempt_id, NEW.job_attempt_id)
       AND attempt.stage_id = NEW.stage_id
       AND (
         NEW.logical_execution_cycle_id IS NULL
         OR attempt.logical_execution_cycle_id = NEW.logical_execution_cycle_id
       )
       AND attempt.status = 'running'
       AND attempt.leased_by = NEW.execution_claim_owner_id
       AND attempt.lease_generation = NEW.execution_claim_generation
       AND attempt.lease_expires_at > NEW.execution_claim_acquired_at
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
