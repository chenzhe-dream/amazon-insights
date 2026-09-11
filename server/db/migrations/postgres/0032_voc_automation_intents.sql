CREATE TABLE voc_automation_intents (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  base_sync_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  selected_asins_json JSONB NOT NULL CHECK (jsonb_typeof(selected_asins_json) = 'array' AND jsonb_array_length(selected_asins_json) > 0),
  retry_key TEXT,
  fingerprint TEXT,
  run_id TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (organization_id, project_id)
);
