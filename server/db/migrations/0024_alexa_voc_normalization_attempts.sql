DROP TRIGGER alexa_voc_normalization_terminal_immutable;

ALTER TABLE alexa_voc_normalization_terminals
RENAME TO alexa_voc_normalization_terminals_legacy;

CREATE TABLE alexa_voc_normalization_terminals (
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE RESTRICT,
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
  PRIMARY KEY (snapshot_id, job_attempt_id),
  CHECK (
    (status = 'success' AND agent_run_id IS NOT NULL AND error_category IS NULL)
    OR (status = 'failure' AND error_category IS NOT NULL)
  )
) STRICT;

INSERT INTO alexa_voc_normalization_terminals (
  snapshot_id, run_id, job_attempt_id, agent_run_id, asin,
  execution_fingerprint, status, error_category, completed_at
)
SELECT snapshot_id, run_id, job_attempt_id, agent_run_id, asin,
       execution_fingerprint, status, error_category, completed_at
FROM alexa_voc_normalization_terminals_legacy;

DROP TABLE alexa_voc_normalization_terminals_legacy;

CREATE INDEX alexa_voc_normalization_terminals_run_idx
ON alexa_voc_normalization_terminals (run_id, completed_at, snapshot_id);

CREATE INDEX alexa_voc_normalization_terminals_snapshot_idx
ON alexa_voc_normalization_terminals (snapshot_id, completed_at, job_attempt_id);

CREATE TRIGGER alexa_voc_normalization_terminal_immutable
BEFORE UPDATE ON alexa_voc_normalization_terminals
BEGIN
  SELECT RAISE(ABORT, 'Alexa VOC normalization terminals are immutable');
END;
