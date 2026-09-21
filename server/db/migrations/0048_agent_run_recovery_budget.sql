-- Replace the insert check atomically within the migration transaction.
-- Canonical job_attempt_id remains immutable audit provenance.
DROP TRIGGER model_budget_agent_run_insert_consistency;
CREATE TRIGGER model_budget_agent_run_insert_consistency
BEFORE INSERT ON model_budget_reservations
WHEN NEW.agent_run_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM agent_runs agent_run
    JOIN job_attempts attempt ON attempt.id = COALESCE(agent_run.active_job_attempt_id, agent_run.job_attempt_id)
    JOIN analysis_runs run ON run.id = agent_run.run_id
    JOIN projects project ON project.id = run.project_id
    WHERE agent_run.id = NEW.agent_run_id
      AND agent_run.run_id = NEW.run_id
      AND attempt.id = NEW.job_attempt_id
      AND attempt.stage_id = agent_run.stage_id
      AND (agent_run.logical_execution_cycle_id IS NULL OR attempt.logical_execution_cycle_id = agent_run.logical_execution_cycle_id)
      AND project.id = NEW.project_id AND project.organization_id = NEW.organization_id
      AND agent_run.validation_status = 'pending'
  ) THEN RAISE(ABORT, 'model request agent run authority is invalid') END;
END;
