ALTER TABLE agent_runs ADD COLUMN logical_execution_lineage TEXT
  CHECK (
    logical_execution_lineage IS NULL OR (
      length(logical_execution_lineage) = 64
      AND logical_execution_lineage = lower(logical_execution_lineage)
      AND logical_execution_lineage NOT GLOB '*[^0-9a-f]*'
    )
  );

CREATE UNIQUE INDEX agent_runs_logical_execution_lineage_idx
ON agent_runs (logical_execution_lineage)
WHERE logical_execution_lineage IS NOT NULL;

CREATE TRIGGER agent_runs_logical_execution_lineage_immutable
BEFORE UPDATE OF logical_execution_lineage ON agent_runs
WHEN NEW.logical_execution_lineage IS NOT OLD.logical_execution_lineage
BEGIN
  SELECT RAISE(ABORT, 'agent run logical execution lineage is immutable');
END;
