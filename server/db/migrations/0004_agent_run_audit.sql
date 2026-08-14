ALTER TABLE agent_runs ADD COLUMN execution_fingerprint TEXT;
ALTER TABLE agent_runs ADD COLUMN output_schema_digest TEXT;
ALTER TABLE agent_runs ADD COLUMN terminal_status TEXT CHECK (
  terminal_status IS NULL OR terminal_status IN (
    'succeeded', 'failed', 'budget-exceeded', 'cancelled'
  )
);
ALTER TABLE agent_runs ADD COLUMN usage_completeness TEXT CHECK (
  usage_completeness IS NULL OR usage_completeness IN (
    'complete', 'partial', 'unavailable'
  )
);
ALTER TABLE agent_runs ADD COLUMN attempt_count INTEGER CHECK (
  attempt_count IS NULL OR attempt_count BETWEEN 0 AND 4
);
ALTER TABLE agent_runs ADD COLUMN attempts_json TEXT CHECK (
  attempts_json IS NULL OR (json_valid(attempts_json) AND json_type(attempts_json) = 'array')
);
ALTER TABLE agent_runs ADD COLUMN execution_claim_token TEXT CHECK (
  execution_claim_token IS NULL OR length(execution_claim_token) BETWEEN 1 AND 200
);
ALTER TABLE agent_runs ADD COLUMN execution_claim_owner_id TEXT CHECK (
  execution_claim_owner_id IS NULL OR length(execution_claim_owner_id) BETWEEN 1 AND 200
);
ALTER TABLE agent_runs ADD COLUMN execution_claim_generation INTEGER CHECK (
  execution_claim_generation IS NULL OR execution_claim_generation > 0
);
ALTER TABLE agent_runs ADD COLUMN execution_claim_acquired_at TEXT;
ALTER TABLE agent_runs ADD COLUMN execution_claim_expires_at TEXT;
ALTER TABLE agent_runs ADD COLUMN terminal_metadata_json TEXT CHECK (
  terminal_metadata_json IS NULL OR (
    json_valid(terminal_metadata_json) AND json_type(terminal_metadata_json) = 'object'
  )
);

ALTER TABLE model_budget_reservations ADD COLUMN job_attempt_id TEXT
  REFERENCES job_attempts(id) ON DELETE RESTRICT;
ALTER TABLE model_budget_reservations ADD COLUMN request_ordinal INTEGER CHECK (
  request_ordinal IS NULL OR request_ordinal BETWEEN 0 AND 3
);
ALTER TABLE model_budget_reservations ADD COLUMN attempt_kind TEXT CHECK (
  attempt_kind IS NULL OR attempt_kind IN (
    'initial', 'transient-retry', 'format-repair'
  )
);
ALTER TABLE model_budget_reservations ADD COLUMN transient_retry_count INTEGER CHECK (
  transient_retry_count IS NULL OR transient_retry_count BETWEEN 0 AND 2
);
ALTER TABLE model_budget_reservations ADD COLUMN format_repair INTEGER CHECK (
  format_repair IS NULL OR format_repair IN (0, 1)
);
ALTER TABLE model_budget_reservations ADD COLUMN response_id TEXT CHECK (
  response_id IS NULL OR (length(response_id) BETWEEN 1 AND 500)
);

CREATE UNIQUE INDEX agent_runs_job_attempt_idx
ON agent_runs (job_attempt_id)
WHERE job_attempt_id IS NOT NULL AND execution_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX model_budget_job_attempt_ordinal_idx
ON model_budget_reservations (job_attempt_id, request_ordinal)
WHERE job_attempt_id IS NOT NULL;

CREATE TABLE agent_run_snapshots (
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE RESTRICT,
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (agent_run_id, snapshot_id),
  UNIQUE (agent_run_id, ordinal)
) STRICT;

CREATE INDEX agent_run_snapshots_snapshot_idx
ON agent_run_snapshots (snapshot_id, agent_run_id);

CREATE TRIGGER agent_runs_audit_insert_consistency
BEFORE INSERT ON agent_runs
WHEN NEW.execution_fingerprint IS NOT NULL
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
BEGIN
  SELECT CASE WHEN
    NEW.execution_fingerprint IS NULL
    OR length(NEW.execution_fingerprint) <> 64
    OR NEW.execution_fingerprint <> lower(NEW.execution_fingerprint)
    OR NEW.execution_fingerprint GLOB '*[^0-9a-f]*'
    OR NEW.output_schema_digest IS NULL
    OR length(NEW.output_schema_digest) <> 64
    OR NEW.output_schema_digest <> lower(NEW.output_schema_digest)
    OR NEW.output_schema_digest GLOB '*[^0-9a-f]*'
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
    OR NEW.attempts_json <> '[]'
    OR NEW.execution_claim_token IS NULL
    OR NEW.execution_claim_owner_id IS NULL
    OR NEW.execution_claim_generation IS NULL
    OR NEW.execution_claim_acquired_at IS NULL
    OR NEW.execution_claim_expires_at IS NULL
    OR NEW.terminal_metadata_json IS NOT NULL
    OR unixepoch(NEW.execution_claim_acquired_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) IS NULL
    OR unixepoch(NEW.execution_claim_expires_at) <= unixepoch(NEW.execution_claim_acquired_at)
    OR NEW.completed_at IS NOT NULL
    OR json_array_length(NEW.snapshot_ids_json) < 1
  THEN RAISE(ABORT, 'invalid pending agent run audit') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM run_stages
    WHERE id = NEW.stage_id AND run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'agent run stage does not belong to run') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM analysis_runs
    WHERE id = NEW.run_id
      AND julianday(data_cutoff_at) = julianday(NEW.data_cutoff_at)
  ) THEN RAISE(ABORT, 'agent run cutoff does not match run') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM job_attempts
    WHERE id = NEW.job_attempt_id AND stage_id = NEW.stage_id
      AND status = 'running'
      AND leased_by = NEW.execution_claim_owner_id
      AND lease_generation = NEW.execution_claim_generation
      AND unixepoch(lease_expires_at) > unixepoch(NEW.execution_claim_acquired_at)
  ) THEN RAISE(ABORT, 'agent run job does not belong to stage') END;
END;

CREATE TRIGGER agent_run_snapshots_run_consistency
BEFORE INSERT ON agent_run_snapshots
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM agent_runs ar
    JOIN data_snapshots ds ON ds.id = NEW.snapshot_id
    WHERE ar.id = NEW.agent_run_id
      AND ar.validation_status = 'pending'
      AND ds.run_id = ar.run_id
      AND julianday(ds.data_cutoff_at) = julianday(ar.data_cutoff_at)
      AND NEW.ordinal < json_array_length(ar.snapshot_ids_json)
      AND json_extract(
        ar.snapshot_ids_json,
        '$[' || NEW.ordinal || ']'
      ) = NEW.snapshot_id
  ) THEN RAISE(ABORT, 'agent run snapshot does not belong to run') END;
END;

CREATE TRIGGER agent_run_snapshots_update_immutable
BEFORE UPDATE ON agent_run_snapshots
BEGIN
  SELECT RAISE(ABORT, 'agent run snapshot links are immutable');
END;

CREATE TRIGGER agent_run_snapshots_delete_immutable
BEFORE DELETE ON agent_run_snapshots
BEGIN
  SELECT RAISE(ABORT, 'agent run snapshot links are immutable');
END;

CREATE TRIGGER model_budget_job_attempt_consistency
BEFORE INSERT ON model_budget_reservations
WHEN NEW.job_attempt_id IS NOT NULL
  OR NEW.request_ordinal IS NOT NULL
  OR NEW.attempt_kind IS NOT NULL
  OR NEW.transient_retry_count IS NOT NULL
  OR NEW.format_repair IS NOT NULL
BEGIN
  SELECT CASE WHEN
    NEW.job_attempt_id IS NULL
    OR NEW.request_ordinal IS NULL
    OR NEW.attempt_kind IS NULL
    OR NEW.transient_retry_count IS NULL
    OR NEW.format_repair IS NULL
  THEN RAISE(ABORT, 'incomplete model request attempt provenance') END;
  SELECT CASE WHEN NOT (
    (NEW.attempt_kind = 'initial'
      AND NEW.request_ordinal = 0
      AND NEW.transient_retry_count = 0
      AND NEW.format_repair = 0)
    OR (NEW.attempt_kind = 'format-repair' AND NEW.format_repair = 1)
    OR (NEW.attempt_kind = 'transient-retry' AND NEW.transient_retry_count > 0)
  ) THEN RAISE(ABORT, 'invalid model request attempt identity') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_attempts ja
    JOIN run_stages rs ON rs.id = ja.stage_id
    WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'model request job does not belong to run') END;
END;

CREATE TRIGGER model_budget_attempt_provenance_immutable
BEFORE UPDATE ON model_budget_reservations
WHEN OLD.job_attempt_id IS NOT NULL OR NEW.job_attempt_id IS NOT NULL
BEGIN
  SELECT CASE WHEN
    NEW.run_id IS NOT OLD.run_id
    OR NEW.job_attempt_id IS NOT OLD.job_attempt_id
    OR NEW.request_ordinal IS NOT OLD.request_ordinal
    OR NEW.attempt_kind IS NOT OLD.attempt_kind
    OR NEW.transient_retry_count IS NOT OLD.transient_retry_count
    OR NEW.format_repair IS NOT OLD.format_repair
  THEN RAISE(ABORT, 'model request attempt provenance is immutable') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM job_attempts ja
    JOIN run_stages rs ON rs.id = ja.stage_id
    WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN RAISE(ABORT, 'model request job no longer belongs to run') END;
END;

CREATE TRIGGER model_budget_response_id_settle_once
BEFORE UPDATE ON model_budget_reservations
WHEN NEW.response_id IS NOT OLD.response_id
BEGIN
  SELECT CASE WHEN NOT (
    OLD.response_id IS NULL
    AND NEW.response_id IS NOT NULL
    AND OLD.state IN ('reserved', 'dispatched')
    AND NEW.state = 'settled'
    AND NEW.actual_input_tokens IS NOT NULL
    AND NEW.actual_output_tokens IS NOT NULL
    AND NEW.actual_cost_micros IS NOT NULL
    AND NEW.settled_at IS NOT NULL
  ) THEN RAISE(ABORT, 'model response id may only be set once during settle') END;
END;

CREATE TRIGGER agent_runs_completed_immutable
BEFORE UPDATE ON agent_runs
WHEN OLD.validation_status <> 'pending'
BEGIN
  SELECT RAISE(ABORT, 'completed agent runs are immutable');
END;

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
  ) THEN RAISE(ABORT, 'same worker lease agent run claim cannot be replaced') END;

  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM job_attempts
    WHERE id = NEW.job_attempt_id AND stage_id = NEW.stage_id
      AND status = 'running'
      AND leased_by = NEW.execution_claim_owner_id
      AND lease_generation = NEW.execution_claim_generation
      AND unixepoch(lease_expires_at) > unixepoch(NEW.execution_claim_acquired_at)
  ) THEN RAISE(ABORT, 'replacement agent run claim has no active job lease') END;
END;

CREATE TRIGGER agent_runs_completion_consistency
BEFORE UPDATE ON agent_runs
WHEN OLD.validation_status = 'pending' AND NEW.validation_status <> 'pending'
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
    OR NEW.input_summary_json IS NOT OLD.input_summary_json
    OR NEW.output_schema_version IS NOT OLD.output_schema_version
    OR NEW.data_cutoff_at IS NOT OLD.data_cutoff_at
    OR NEW.started_at IS NOT OLD.started_at
    OR NEW.execution_fingerprint IS NOT OLD.execution_fingerprint
    OR NEW.output_schema_digest IS NOT OLD.output_schema_digest
    OR NEW.execution_claim_token IS NOT OLD.execution_claim_token
    OR NEW.execution_claim_owner_id IS NOT OLD.execution_claim_owner_id
    OR NEW.execution_claim_generation IS NOT OLD.execution_claim_generation
    OR NEW.execution_claim_acquired_at IS NOT OLD.execution_claim_acquired_at
    OR NEW.execution_claim_expires_at IS NOT OLD.execution_claim_expires_at
  THEN RAISE(ABORT, 'agent run execution identity is immutable') END;

  SELECT CASE WHEN
    NEW.completed_at IS NULL
    OR NEW.terminal_status IS NULL
    OR NEW.attempt_count IS NULL
    OR NEW.attempts_json IS NULL
    OR NEW.terminal_metadata_json IS NULL
    OR json_array_length(NEW.attempts_json) <> NEW.attempt_count
    OR NEW.usage_completeness IS NULL
    OR (NEW.validation_status = 'passed' AND (
      NEW.terminal_status <> 'succeeded'
      OR NEW.output_json IS NULL
      OR NEW.error_json IS NOT NULL
      OR NEW.attempt_count < 1
    ))
    OR (NEW.validation_status = 'failed' AND (
      NEW.terminal_status NOT IN ('failed', 'budget-exceeded', 'cancelled')
      OR NEW.output_json IS NOT NULL
      OR NEW.error_json IS NULL
    ))
    OR NEW.validation_status NOT IN ('passed', 'failed')
    OR (NEW.terminal_status = 'succeeded'
      AND json_extract(NEW.terminal_metadata_json, '$.kind') <> 'succeeded')
    OR (NEW.terminal_status = 'budget-exceeded'
      AND json_extract(NEW.terminal_metadata_json, '$.kind') <> 'budget-exceeded')
    OR (NEW.terminal_status = 'cancelled'
      AND json_extract(NEW.terminal_metadata_json, '$.kind') <> 'cancelled')
    OR (NEW.terminal_status = 'failed'
      AND json_extract(NEW.terminal_metadata_json, '$.kind') <> 'failed')
    OR (NEW.usage_completeness IN ('complete', 'partial') AND (
      NEW.input_tokens IS NULL
      OR NEW.output_tokens IS NULL
      OR NEW.estimated_cost_micros IS NULL
    ))
    OR (NEW.usage_completeness = 'unavailable' AND (
      NEW.input_tokens IS NOT NULL
      OR NEW.output_tokens IS NOT NULL
      OR NEW.estimated_cost_micros IS NOT NULL
    ))
  THEN RAISE(ABORT, 'invalid completed agent run audit') END;
END;

CREATE TRIGGER agent_runs_delete_immutable
BEFORE DELETE ON agent_runs
BEGIN
  SELECT RAISE(ABORT, 'agent runs are immutable');
END;
