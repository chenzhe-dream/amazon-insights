ALTER TABLE model_budget_reservations
ADD COLUMN agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT;

UPDATE model_budget_reservations
SET agent_run_id = (
  SELECT agent_runs.id
  FROM agent_runs
  WHERE agent_runs.job_attempt_id = model_budget_reservations.job_attempt_id
    AND agent_runs.execution_fingerprint IS NOT NULL
)
WHERE job_attempt_id IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM agent_runs
    WHERE agent_runs.job_attempt_id = model_budget_reservations.job_attempt_id
      AND agent_runs.execution_fingerprint IS NOT NULL
  );

DROP INDEX agent_runs_job_attempt_idx;
CREATE UNIQUE INDEX agent_runs_job_attempt_idx
ON agent_runs (job_attempt_id, execution_fingerprint)
WHERE job_attempt_id IS NOT NULL AND execution_fingerprint IS NOT NULL;

DROP INDEX agent_runs_one_per_logical_cycle_idx;
CREATE UNIQUE INDEX agent_runs_one_per_logical_cycle_idx
ON agent_runs (stage_id, logical_execution_cycle_id, execution_fingerprint)
WHERE logical_execution_cycle_id IS NOT NULL
  AND execution_fingerprint IS NOT NULL;

DROP INDEX model_budget_job_attempt_ordinal_idx;
CREATE UNIQUE INDEX model_budget_agent_run_ordinal_idx
ON model_budget_reservations (agent_run_id, request_ordinal)
WHERE agent_run_id IS NOT NULL AND request_ordinal IS NOT NULL;

CREATE UNIQUE INDEX model_budget_legacy_job_attempt_ordinal_idx
ON model_budget_reservations (job_attempt_id, request_ordinal)
WHERE agent_run_id IS NULL
  AND job_attempt_id IS NOT NULL
  AND request_ordinal IS NOT NULL;

DROP INDEX data_snapshots_semantic_identity_idx;
CREATE UNIQUE INDEX data_snapshots_semantic_identity_idx
ON data_snapshots (
  run_id, schema_version, marketplace, asins_json, data_cutoff_at, content_hash
)
WHERE snapshot_kind = 'voc';

CREATE TABLE alexa_voc_normalization_terminals (
  snapshot_id TEXT PRIMARY KEY REFERENCES data_snapshots(id) ON DELETE RESTRICT,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  job_attempt_id TEXT NOT NULL REFERENCES job_attempts(id) ON DELETE RESTRICT,
  agent_run_id TEXT REFERENCES agent_runs(id) ON DELETE RESTRICT,
  asin TEXT NOT NULL,
  execution_fingerprint TEXT NOT NULL CHECK (
    length(execution_fingerprint) = 64
    AND execution_fingerprint = lower(execution_fingerprint)
    AND execution_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  status TEXT NOT NULL CHECK (status IN ('success', 'failure')),
  error_category TEXT CHECK (
    error_category IS NULL
    OR error_category IN ('model-output', 'schema', 'persistence', 'authorization')
  ),
  completed_at TEXT NOT NULL,
  CHECK (
    (status = 'success' AND agent_run_id IS NOT NULL AND error_category IS NULL)
    OR (status = 'failure' AND error_category IS NOT NULL)
  )
) STRICT;

CREATE INDEX alexa_voc_normalization_terminals_run_idx
ON alexa_voc_normalization_terminals (run_id, completed_at, snapshot_id);

CREATE TRIGGER alexa_voc_normalization_terminal_immutable
BEFORE UPDATE ON alexa_voc_normalization_terminals
BEGIN
  SELECT RAISE(ABORT, 'Alexa VOC normalization terminals are immutable');
END;

CREATE TRIGGER model_budget_agent_run_insert_consistency
BEFORE INSERT ON model_budget_reservations
WHEN NEW.agent_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
    FROM agent_runs agent_run
    WHERE agent_run.id = NEW.agent_run_id
      AND agent_run.run_id = NEW.run_id
      AND agent_run.job_attempt_id = NEW.job_attempt_id
      AND agent_run.validation_status = 'pending'
  ) THEN RAISE(ABORT, 'model request agent run authority is invalid') END;
END;

CREATE TRIGGER model_budget_agent_run_immutable
BEFORE UPDATE ON model_budget_reservations
WHEN NEW.agent_run_id IS NOT OLD.agent_run_id
BEGIN
  SELECT RAISE(ABORT, 'model request agent run is immutable');
END;
