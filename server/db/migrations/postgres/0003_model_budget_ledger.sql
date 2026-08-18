CREATE UNIQUE INDEX analysis_runs_id_project_idx
ON analysis_runs (id, project_id);

CREATE UNIQUE INDEX projects_id_organization_idx
ON projects (id, organization_id);

CREATE TABLE model_budget_reservations (
  id TEXT PRIMARY KEY CHECK (char_length(id) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
  request_fingerprint TEXT NOT NULL CHECK (
    request_fingerprint ~ '^[0-9a-f]{64}$'
  ),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL
    CHECK (char_length(organization_id) BETWEEN 1 AND 200),
  utc_day DATE NOT NULL,
  state TEXT NOT NULL CHECK (
    state IN ('reserved', 'dispatched', 'settled', 'released')
  ),
  projected_input_tokens BIGINT NOT NULL CHECK (
    projected_input_tokens BETWEEN 0 AND 9007199254740991
  ),
  projected_output_tokens BIGINT NOT NULL CHECK (
    projected_output_tokens BETWEEN 0 AND 9007199254740991
  ),
  projected_cost_micros BIGINT NOT NULL CHECK (
    projected_cost_micros BETWEEN 0 AND 9007199254740991
  ),
  actual_input_tokens BIGINT CHECK (
    actual_input_tokens IS NULL
    OR actual_input_tokens BETWEEN 0 AND 9007199254740991
  ),
  actual_output_tokens BIGINT CHECK (
    actual_output_tokens IS NULL
    OR actual_output_tokens BETWEEN 0 AND 9007199254740991
  ),
  actual_cost_micros BIGINT CHECK (
    actual_cost_micros IS NULL
    OR actual_cost_micros BETWEEN 0 AND 9007199254740991
  ),
  lease_expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  dispatched_at TIMESTAMPTZ,
  settled_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  job_attempt_id TEXT REFERENCES job_attempts(id) ON DELETE RESTRICT,
  request_ordinal INTEGER CHECK (
    request_ordinal IS NULL OR request_ordinal BETWEEN 0 AND 3
  ),
  attempt_kind TEXT CHECK (
    attempt_kind IS NULL
    OR attempt_kind IN ('initial', 'transient-retry', 'format-repair')
  ),
  transient_retry_count INTEGER CHECK (
    transient_retry_count IS NULL OR transient_retry_count BETWEEN 0 AND 2
  ),
  format_repair BOOLEAN,
  response_id TEXT CHECK (
    response_id IS NULL OR char_length(response_id) BETWEEN 1 AND 500
  ),
  FOREIGN KEY (run_id, project_id)
    REFERENCES analysis_runs(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
  UNIQUE (run_id, idempotency_key),
  CHECK (projected_input_tokens + projected_output_tokens > 0),
  CHECK (
    (state = 'reserved' AND lease_expires_at IS NOT NULL)
    OR (state <> 'reserved' AND lease_expires_at IS NULL)
  ),
  CHECK (
    (state = 'dispatched' AND dispatched_at IS NOT NULL)
    OR state <> 'dispatched'
  ),
  CHECK (
    (state = 'settled'
      AND actual_input_tokens IS NOT NULL
      AND actual_output_tokens IS NOT NULL
      AND actual_cost_micros IS NOT NULL
      AND settled_at IS NOT NULL)
    OR
    (state <> 'settled'
      AND actual_input_tokens IS NULL
      AND actual_output_tokens IS NULL
      AND actual_cost_micros IS NULL
      AND settled_at IS NULL)
  ),
  CHECK (
    (state = 'released' AND released_at IS NOT NULL)
    OR state <> 'released'
  ),
  CHECK (
    (job_attempt_id IS NULL
      AND request_ordinal IS NULL
      AND attempt_kind IS NULL
      AND transient_retry_count IS NULL
      AND format_repair IS NULL)
    OR
    (job_attempt_id IS NOT NULL
      AND request_ordinal IS NOT NULL
      AND attempt_kind IS NOT NULL
      AND transient_retry_count IS NOT NULL
      AND format_repair IS NOT NULL)
  ),
  CHECK (
    job_attempt_id IS NULL
    OR (attempt_kind = 'initial'
      AND request_ordinal = 0
      AND transient_retry_count = 0
      AND format_repair = FALSE)
    OR (attempt_kind = 'format-repair' AND format_repair = TRUE)
    OR (attempt_kind = 'transient-retry' AND transient_retry_count > 0)
  ),
  CHECK (
    response_id IS NULL OR state = 'settled'
  )
);

CREATE INDEX model_budget_reservations_run_idx
ON model_budget_reservations (run_id, state, created_at);

CREATE INDEX model_budget_reservations_org_day_idx
ON model_budget_reservations (organization_id, utc_day, state, created_at);

CREATE INDEX model_budget_reservations_expiry_idx
ON model_budget_reservations (state, lease_expires_at)
WHERE state = 'reserved';

CREATE UNIQUE INDEX model_budget_job_attempt_ordinal_idx
ON model_budget_reservations (job_attempt_id, request_ordinal)
WHERE job_attempt_id IS NOT NULL;

CREATE FUNCTION enforce_model_budget_provenance()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND ROW(
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
    RAISE EXCEPTION 'model budget provenance is immutable';
  END IF;

  IF NEW.job_attempt_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
      FROM job_attempts ja
      JOIN run_stages rs ON rs.id = ja.stage_id
     WHERE ja.id = NEW.job_attempt_id AND rs.run_id = NEW.run_id
  ) THEN
    RAISE EXCEPTION 'model budget provenance does not belong to run';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER model_budget_provenance_guard
BEFORE INSERT OR UPDATE ON model_budget_reservations
FOR EACH ROW EXECUTE FUNCTION enforce_model_budget_provenance();
