CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX users_organization_idx ON users (organization_id);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;

CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  name TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (
    length(marketplace) = 2 AND marketplace = upper(marketplace)
  ),
  asins_json TEXT NOT NULL CHECK (
    json_valid(asins_json) AND json_type(asins_json) = 'array'
  ),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  current_run_id TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE INDEX projects_organization_idx ON projects (organization_id, updated_at);

CREATE TABLE analysis_runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('existing-data', 'collect-missing')),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'running', 'waiting-input', 'succeeded', 'partial',
      'failed', 'budget-exceeded', 'cancelled'
    )
  ),
  created_by TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  data_cutoff_at TEXT NOT NULL,
  idempotency_scope TEXT NOT NULL CHECK (length(idempotency_scope) BETWEEN 1 AND 500),
  idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (idempotency_scope, idempotency_key)
) STRICT;

CREATE INDEX analysis_runs_project_idx ON analysis_runs (project_id, created_at);

CREATE TABLE run_stages (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK (
    stage IN ('traffic-analysis', 'voc-positioning', 'product-definition')
  ),
  status TEXT NOT NULL CHECK (
    status IN (
      'queued', 'running', 'waiting-input', 'succeeded', 'failed', 'skipped',
      'budget-exceeded', 'cancelled', 'stale'
    )
  ),
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at TEXT,
  completed_at TEXT,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (run_id, stage)
) STRICT;

CREATE INDEX run_stages_run_status_idx ON run_stages (run_id, status);

CREATE TABLE job_attempts (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES run_stages(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK (max_attempts > 0),
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')
  ),
  available_at TEXT NOT NULL,
  leased_by TEXT,
  lease_expires_at TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  retryable INTEGER NOT NULL DEFAULT 0 CHECK (retryable IN (0, 1)),
  retry_scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    status <> 'running' OR (leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  UNIQUE (stage_id, attempt_number)
) STRICT;

CREATE INDEX job_attempts_claim_idx ON job_attempts (
  status, available_at, lease_expires_at, retryable, retry_scheduled_at
);

CREATE TABLE data_snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  schema_version TEXT NOT NULL,
  marketplace TEXT NOT NULL,
  asins_json TEXT NOT NULL CHECK (json_valid(asins_json)),
  data_cutoff_at TEXT NOT NULL,
  sources_json TEXT NOT NULL CHECK (json_valid(sources_json)),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX data_snapshots_run_idx ON data_snapshots (run_id, created_at);

CREATE TABLE skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  manifest_json TEXT NOT NULL CHECK (json_valid(manifest_json)),
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version),
  UNIQUE (skill_id, content_hash)
) STRICT;

CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  stage_id TEXT NOT NULL REFERENCES run_stages(id) ON DELETE CASCADE,
  job_attempt_id TEXT REFERENCES job_attempts(id) ON DELETE SET NULL,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  schema_version TEXT NOT NULL,
  snapshot_ids_json TEXT NOT NULL CHECK (json_valid(snapshot_ids_json)),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  response_id TEXT,
  input_summary_json TEXT NOT NULL CHECK (json_valid(input_summary_json)),
  output_schema_version TEXT NOT NULL,
  output_json TEXT CHECK (output_json IS NULL OR json_valid(output_json)),
  validation_status TEXT NOT NULL CHECK (
    validation_status IN ('pending', 'passed', 'failed')
  ),
  input_tokens INTEGER CHECK (input_tokens IS NULL OR input_tokens >= 0),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
  estimated_cost_micros INTEGER CHECK (
    estimated_cost_micros IS NULL OR estimated_cost_micros >= 0
  ),
  error_json TEXT CHECK (error_json IS NULL OR json_valid(error_json)),
  data_cutoff_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT
) STRICT;

CREATE INDEX agent_runs_run_stage_idx ON agent_runs (run_id, stage_id, started_at);

CREATE TABLE analysis_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL CHECK (version > 0),
  stage TEXT NOT NULL CHECK (
    stage IN ('traffic-analysis', 'voc-positioning', 'product-definition')
  ),
  schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('complete', 'partial', 'stale', 'unavailable')
  ),
  snapshot_ids_json TEXT NOT NULL CHECK (json_valid(snapshot_ids_json)),
  evidence_json TEXT NOT NULL CHECK (json_valid(evidence_json)),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  data_cutoff_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (run_id, stage, version)
) STRICT;

CREATE INDEX analysis_reports_run_idx ON analysis_reports (run_id, stage, version);

CREATE TRIGGER analysis_reports_no_update
BEFORE UPDATE ON analysis_reports
BEGIN
  SELECT RAISE(ABORT, 'analysis reports are immutable');
END;

CREATE TRIGGER analysis_reports_no_delete
BEFORE DELETE ON analysis_reports
BEGIN
  SELECT RAISE(ABORT, 'analysis reports are immutable');
END;

CREATE TABLE connector_status (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  connector TEXT NOT NULL,
  configured INTEGER NOT NULL CHECK (configured IN (0, 1)),
  health TEXT NOT NULL CHECK (health IN ('unknown', 'available', 'unavailable')),
  last_checked_at TEXT,
  last_error_json TEXT CHECK (last_error_json IS NULL OR json_valid(last_error_json)),
  updated_at TEXT NOT NULL,
  UNIQUE (organization_id, connector)
) STRICT;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at TEXT NOT NULL
) STRICT;

CREATE INDEX audit_events_organization_idx ON audit_events (
  organization_id, created_at
);
