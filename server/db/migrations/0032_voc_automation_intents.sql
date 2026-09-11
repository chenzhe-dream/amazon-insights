CREATE TABLE voc_automation_intents (
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  base_sync_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE CASCADE,
  selected_asins_json TEXT NOT NULL CHECK (json_valid(selected_asins_json) AND json_type(selected_asins_json) = 'array' AND json_array_length(selected_asins_json) > 0),
  retry_key TEXT,
  fingerprint TEXT,
  run_id TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, project_id)
) STRICT;
