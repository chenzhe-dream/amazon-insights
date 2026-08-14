CREATE UNIQUE INDEX analysis_runs_id_project_idx
ON analysis_runs (id, project_id);

CREATE UNIQUE INDEX projects_id_organization_idx
ON projects (id, organization_id);

CREATE TABLE model_budget_reservations (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  run_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  organization_id TEXT NOT NULL CHECK (length(organization_id) BETWEEN 1 AND 200),
  utc_day TEXT NOT NULL CHECK (
    length(utc_day) = 10
    AND utc_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
  ),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'dispatched', 'settled', 'released')),
  projected_input_tokens INTEGER NOT NULL CHECK (
    projected_input_tokens BETWEEN 0 AND 9007199254740991
  ),
  projected_output_tokens INTEGER NOT NULL CHECK (
    projected_output_tokens BETWEEN 0 AND 9007199254740991
  ),
  projected_cost_micros INTEGER NOT NULL CHECK (
    projected_cost_micros BETWEEN 0 AND 9007199254740991
  ),
  actual_input_tokens INTEGER CHECK (
    actual_input_tokens IS NULL
    OR actual_input_tokens BETWEEN 0 AND 9007199254740991
  ),
  actual_output_tokens INTEGER CHECK (
    actual_output_tokens IS NULL
    OR actual_output_tokens BETWEEN 0 AND 9007199254740991
  ),
  actual_cost_micros INTEGER CHECK (
    actual_cost_micros IS NULL
    OR actual_cost_micros BETWEEN 0 AND 9007199254740991
  ),
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  dispatched_at TEXT,
  settled_at TEXT,
  released_at TEXT,
  FOREIGN KEY (run_id, project_id)
    REFERENCES analysis_runs(id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, organization_id)
    REFERENCES projects(id, organization_id) ON DELETE CASCADE,
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
  )
) STRICT;

CREATE INDEX model_budget_reservations_run_idx
ON model_budget_reservations (run_id, state, created_at);

CREATE INDEX model_budget_reservations_org_day_idx
ON model_budget_reservations (organization_id, utc_day, state, created_at);

CREATE INDEX model_budget_reservations_expiry_idx
ON model_budget_reservations (state, lease_expires_at)
WHERE state = 'reserved';
