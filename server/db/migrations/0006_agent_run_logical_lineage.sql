ALTER TABLE job_attempts ADD COLUMN logical_execution_cycle_id TEXT
  CHECK (
    logical_execution_cycle_id IS NULL OR (
      length(logical_execution_cycle_id) = 64
      AND logical_execution_cycle_id = lower(logical_execution_cycle_id)
      AND logical_execution_cycle_id NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE job_attempts ADD COLUMN report_publication_cycle INTEGER
  NOT NULL DEFAULT 1 CHECK (report_publication_cycle > 0);

ALTER TABLE job_attempts ADD COLUMN report_publication_attempt_count INTEGER
  NOT NULL DEFAULT 0 CHECK (report_publication_attempt_count >= 0);

ALTER TABLE job_attempts ADD COLUMN report_publication_max_attempts INTEGER
  CHECK (report_publication_max_attempts IS NULL OR report_publication_max_attempts > 0);

ALTER TABLE job_attempts ADD COLUMN report_publication_initial_delay_ms INTEGER
  CHECK (report_publication_initial_delay_ms IS NULL OR report_publication_initial_delay_ms > 0);

ALTER TABLE job_attempts ADD COLUMN report_publication_max_delay_ms INTEGER
  CHECK (report_publication_max_delay_ms IS NULL OR report_publication_max_delay_ms > 0);

ALTER TABLE job_attempts ADD COLUMN report_publication_retry_at TEXT
  CHECK (
    report_publication_retry_at IS NULL
    OR unixepoch(report_publication_retry_at) IS NOT NULL
  );

CREATE INDEX job_attempts_report_publication_retry_idx
ON job_attempts (status, retryable, report_publication_retry_at);

UPDATE job_attempts
SET logical_execution_cycle_id = lower(hex(randomblob(32)))
WHERE logical_execution_cycle_id IS NULL;

CREATE UNIQUE INDEX job_attempts_one_active_logical_cycle_idx
ON job_attempts (logical_execution_cycle_id)
WHERE status IN ('queued', 'running');

CREATE TRIGGER job_attempts_logical_cycle_required
BEFORE INSERT ON job_attempts
WHEN NEW.logical_execution_cycle_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'job attempt logical execution cycle is required');
END;

CREATE TRIGGER job_attempts_logical_cycle_immutable
BEFORE UPDATE OF logical_execution_cycle_id ON job_attempts
WHEN NEW.logical_execution_cycle_id IS NOT OLD.logical_execution_cycle_id
BEGIN
  SELECT RAISE(ABORT, 'job attempt logical execution cycle is immutable');
END;

CREATE TRIGGER job_attempts_report_publication_state_insert
BEFORE INSERT ON job_attempts
BEGIN
  SELECT CASE WHEN NOT (
    typeof(NEW.report_publication_cycle) = 'integer'
    AND NEW.report_publication_cycle >= 1
    AND typeof(NEW.report_publication_attempt_count) = 'integer'
    AND NEW.report_publication_attempt_count >= 0
    AND (
      (
        NEW.report_publication_max_attempts IS NULL
        AND NEW.report_publication_initial_delay_ms IS NULL
        AND NEW.report_publication_max_delay_ms IS NULL
        AND NEW.report_publication_attempt_count = 0
        AND NEW.report_publication_retry_at IS NULL
      )
      OR (
        typeof(NEW.report_publication_max_attempts) = 'integer'
        AND NEW.report_publication_max_attempts > 0
        AND typeof(NEW.report_publication_initial_delay_ms) = 'integer'
        AND NEW.report_publication_initial_delay_ms > 0
        AND typeof(NEW.report_publication_max_delay_ms) = 'integer'
        AND NEW.report_publication_max_delay_ms > 0
        AND NEW.report_publication_initial_delay_ms <= NEW.report_publication_max_delay_ms
        AND NEW.report_publication_attempt_count <= NEW.report_publication_max_attempts
        AND (
          (
            NEW.status IS 'failed'
            AND NEW.retryable IS 1
            AND NEW.report_publication_attempt_count < NEW.report_publication_max_attempts
            AND NEW.report_publication_retry_at IS NOT NULL
            AND typeof(NEW.report_publication_retry_at) = 'text'
            AND length(NEW.report_publication_retry_at) = 24
            AND NEW.report_publication_retry_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.report_publication_retry_at)
              IS NEW.report_publication_retry_at
          )
          OR (
            NEW.retryable IS NOT 1
            AND NEW.report_publication_retry_at IS NULL
            AND (
              NEW.status IS NOT 'failed'
              OR NEW.report_publication_attempt_count IS NEW.report_publication_max_attempts
            )
          )
        )
      )
    )
  ) THEN RAISE(ABORT, 'job attempt report publication state is invalid') END;
END;

CREATE TRIGGER job_attempts_report_publication_state_update
BEFORE UPDATE OF status,
  retryable,
  report_publication_cycle,
  report_publication_attempt_count,
  report_publication_max_attempts,
  report_publication_initial_delay_ms,
  report_publication_max_delay_ms,
  report_publication_retry_at ON job_attempts
BEGIN
  SELECT CASE WHEN NOT (
    typeof(NEW.report_publication_cycle) = 'integer'
    AND NEW.report_publication_cycle >= 1
    AND typeof(NEW.report_publication_attempt_count) = 'integer'
    AND NEW.report_publication_attempt_count >= 0
    AND (
      (
        NEW.report_publication_max_attempts IS NULL
        AND NEW.report_publication_initial_delay_ms IS NULL
        AND NEW.report_publication_max_delay_ms IS NULL
        AND NEW.report_publication_attempt_count = 0
        AND NEW.report_publication_retry_at IS NULL
      )
      OR (
        typeof(NEW.report_publication_max_attempts) = 'integer'
        AND NEW.report_publication_max_attempts > 0
        AND typeof(NEW.report_publication_initial_delay_ms) = 'integer'
        AND NEW.report_publication_initial_delay_ms > 0
        AND typeof(NEW.report_publication_max_delay_ms) = 'integer'
        AND NEW.report_publication_max_delay_ms > 0
        AND NEW.report_publication_initial_delay_ms <= NEW.report_publication_max_delay_ms
        AND NEW.report_publication_attempt_count <= NEW.report_publication_max_attempts
        AND (
          (
            NEW.status IS 'failed'
            AND NEW.retryable IS 1
            AND NEW.report_publication_attempt_count < NEW.report_publication_max_attempts
            AND NEW.report_publication_retry_at IS NOT NULL
            AND typeof(NEW.report_publication_retry_at) = 'text'
            AND length(NEW.report_publication_retry_at) = 24
            AND NEW.report_publication_retry_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.report_publication_retry_at)
              IS NEW.report_publication_retry_at
          )
          OR (
            NEW.retryable IS NOT 1
            AND NEW.report_publication_retry_at IS NULL
            AND (
              NEW.status IS NOT 'failed'
              OR NEW.report_publication_attempt_count IS NEW.report_publication_max_attempts
            )
          )
        )
      )
    )
  ) THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN NOT (
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    OR (
      NEW.report_publication_cycle = OLD.report_publication_cycle + 1
      AND OLD.status IS 'failed'
      AND OLD.retryable IS 0
      AND typeof(OLD.report_publication_max_attempts) = 'integer'
      AND OLD.report_publication_attempt_count IS OLD.report_publication_max_attempts
      AND NEW.status IS 'queued'
      AND NEW.retryable IS 0
      AND NEW.report_publication_attempt_count = 0
      AND NEW.report_publication_max_attempts IS NULL
      AND NEW.report_publication_initial_delay_ms IS NULL
      AND NEW.report_publication_max_delay_ms IS NULL
      AND NEW.report_publication_retry_at IS NULL
    )
  ) THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND NOT (
      (
        OLD.status IS 'running'
        AND NEW.status IS 'failed'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count + 1
      )
      OR (
        OLD.status IS 'failed'
        AND OLD.retryable IS 1
        AND NEW.status IS 'running'
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
      OR (
        OLD.status IS 'running'
        AND (NEW.status IS 'queued' OR NEW.status IS 'succeeded')
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
      OR (
        OLD.status IS NEW.status
        AND OLD.retryable IS NEW.retryable
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
    )
  THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND (
      NEW.report_publication_max_attempts IS NOT OLD.report_publication_max_attempts
      OR NEW.report_publication_initial_delay_ms IS NOT OLD.report_publication_initial_delay_ms
      OR NEW.report_publication_max_delay_ms IS NOT OLD.report_publication_max_delay_ms
      OR NEW.report_publication_attempt_count < OLD.report_publication_attempt_count
      OR NEW.report_publication_attempt_count > OLD.report_publication_attempt_count + 1
    )
  THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;
END;

ALTER TABLE agent_runs ADD COLUMN logical_execution_lineage TEXT
  CHECK (
    logical_execution_lineage IS NULL OR (
      length(logical_execution_lineage) = 64
      AND logical_execution_lineage = lower(logical_execution_lineage)
      AND logical_execution_lineage NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE agent_runs ADD COLUMN logical_execution_cycle_id TEXT
  CHECK (
    logical_execution_cycle_id IS NULL OR (
      length(logical_execution_cycle_id) = 64
      AND logical_execution_cycle_id = lower(logical_execution_cycle_id)
      AND logical_execution_cycle_id NOT GLOB '*[^0-9a-f]*'
    )
  );

ALTER TABLE agent_runs ADD COLUMN active_job_attempt_id TEXT
  REFERENCES job_attempts(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX agent_runs_logical_execution_lineage_idx
ON agent_runs (logical_execution_lineage)
WHERE logical_execution_lineage IS NOT NULL;

CREATE UNIQUE INDEX agent_runs_one_per_logical_cycle_idx
ON agent_runs (stage_id, logical_execution_cycle_id)
WHERE logical_execution_cycle_id IS NOT NULL;

CREATE TRIGGER agent_runs_logical_execution_lineage_immutable
BEFORE UPDATE OF logical_execution_lineage ON agent_runs
WHEN NEW.logical_execution_lineage IS NOT OLD.logical_execution_lineage
BEGIN
  SELECT RAISE(ABORT, 'agent run logical execution lineage is immutable');
END;

CREATE TRIGGER agent_runs_logical_cycle_immutable
BEFORE UPDATE OF logical_execution_cycle_id ON agent_runs
WHEN NEW.logical_execution_cycle_id IS NOT OLD.logical_execution_cycle_id
BEGIN
  SELECT RAISE(ABORT, 'agent run logical execution cycle is immutable');
END;

CREATE TRIGGER agent_runs_logical_cycle_insert_consistency
BEFORE INSERT ON agent_runs
BEGIN
  SELECT CASE WHEN
    (
      NEW.logical_execution_lineage IS NULL
      AND (
        NEW.logical_execution_cycle_id IS NOT NULL
        OR NEW.active_job_attempt_id IS NOT NULL
      )
    )
    OR (
      NEW.logical_execution_lineage IS NOT NULL
      AND (
        NEW.logical_execution_cycle_id IS NULL
        OR NEW.active_job_attempt_id IS NOT NEW.job_attempt_id
        OR NOT EXISTS (
          SELECT 1 FROM job_attempts ja
          WHERE ja.id = NEW.job_attempt_id
            AND ja.logical_execution_cycle_id = NEW.logical_execution_cycle_id
        )
      )
    )
  THEN RAISE(ABORT, 'agent run logical cycle has no trusted job authority') END;
END;

CREATE TRIGGER agent_runs_active_attempt_completion_immutable
BEFORE UPDATE OF active_job_attempt_id ON agent_runs
WHEN OLD.validation_status = 'pending'
  AND NEW.validation_status <> 'pending'
  AND NEW.active_job_attempt_id IS NOT OLD.active_job_attempt_id
BEGIN
  SELECT RAISE(ABORT, 'agent run active recovery authority is immutable at completion');
END;

DROP TRIGGER agent_runs_pending_update_requires_completion;

CREATE TRIGGER agent_runs_pending_update_requires_completion
BEFORE UPDATE ON agent_runs
WHEN OLD.validation_status = 'pending' AND NEW.validation_status = 'pending'
BEGIN
  SELECT CASE WHEN
    NEW.id IS NOT OLD.id
    OR NEW.run_id IS NOT OLD.run_id
    OR NEW.stage_id IS NOT OLD.stage_id
    OR NEW.job_attempt_id IS NOT OLD.job_attempt_id
    OR NEW.skill_version_id IS NOT OLD.skill_version_id
    OR NEW.schema_version IS NOT OLD.schema_version
    OR NEW.snapshot_ids_json IS NOT OLD.snapshot_ids_json
    OR NEW.provider IS NOT OLD.provider
    OR NEW.model IS NOT OLD.model
    OR NEW.response_id IS NOT OLD.response_id
    OR NEW.input_summary_json IS NOT OLD.input_summary_json
    OR NEW.output_schema_version IS NOT OLD.output_schema_version
    OR NEW.output_json IS NOT OLD.output_json
    OR NEW.input_tokens IS NOT OLD.input_tokens
    OR NEW.output_tokens IS NOT OLD.output_tokens
    OR NEW.duration_ms IS NOT OLD.duration_ms
    OR NEW.estimated_cost_micros IS NOT OLD.estimated_cost_micros
    OR NEW.error_json IS NOT OLD.error_json
    OR NEW.data_cutoff_at IS NOT OLD.data_cutoff_at
    OR NEW.started_at IS NOT OLD.started_at
    OR NEW.completed_at IS NOT OLD.completed_at
    OR NEW.execution_fingerprint IS NOT OLD.execution_fingerprint
    OR NEW.output_schema_digest IS NOT OLD.output_schema_digest
    OR NEW.logical_execution_lineage IS NOT OLD.logical_execution_lineage
    OR NEW.logical_execution_cycle_id IS NOT OLD.logical_execution_cycle_id
    OR NEW.terminal_status IS NOT OLD.terminal_status
    OR NEW.usage_completeness IS NOT OLD.usage_completeness
    OR NEW.attempt_count IS NOT OLD.attempt_count
    OR NEW.attempts_json IS NOT OLD.attempts_json
    OR NEW.terminal_metadata_json IS NOT OLD.terminal_metadata_json
    OR NEW.execution_claim_token IS OLD.execution_claim_token
    OR NEW.execution_claim_token IS NULL
    OR NEW.execution_claim_owner_id IS NULL
    OR NEW.execution_claim_generation IS NULL
    OR NEW.execution_claim_acquired_at IS NULL
    OR NEW.execution_claim_expires_at IS NULL
    OR unixepoch(NEW.execution_claim_acquired_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) <= unixepoch(NEW.execution_claim_acquired_at)
  THEN RAISE(ABORT, 'pending agent run claim update is invalid') END;

  SELECT CASE WHEN NOT (
    OLD.execution_claim_owner_id IS NOT NEW.execution_claim_owner_id
    OR OLD.execution_claim_generation IS NOT NEW.execution_claim_generation
    OR OLD.active_job_attempt_id IS NOT NEW.active_job_attempt_id
  ) THEN RAISE(ABORT, 'same worker lease agent run claim cannot be replaced') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM job_attempts
    WHERE id = COALESCE(NEW.active_job_attempt_id, NEW.job_attempt_id)
      AND stage_id = NEW.stage_id
      AND (
        NEW.logical_execution_cycle_id IS NULL
        OR logical_execution_cycle_id = NEW.logical_execution_cycle_id
      )
      AND status = 'running'
      AND leased_by = NEW.execution_claim_owner_id
      AND lease_generation = NEW.execution_claim_generation
      AND unixepoch(lease_expires_at) > unixepoch(NEW.execution_claim_acquired_at)
  ) THEN RAISE(ABORT, 'replacement agent run claim has no active job lease') END;
END;

DROP TRIGGER agent_runs_logical_execution_lineage_immutable;

CREATE TRIGGER agent_runs_logical_execution_lineage_immutable
BEFORE UPDATE OF logical_execution_lineage ON agent_runs
WHEN NEW.logical_execution_lineage IS NOT OLD.logical_execution_lineage
BEGIN
  SELECT RAISE(ABORT, 'agent run logical execution lineage is immutable');
END;
