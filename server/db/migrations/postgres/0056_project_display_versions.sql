CREATE TABLE project_display_versions (
  id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_run_id TEXT NOT NULL REFERENCES analysis_runs(id) ON DELETE RESTRICT,
  source_job_id TEXT NOT NULL REFERENCES sync_jobs(job_id) ON DELETE RESTRICT,
  marketplace TEXT NOT NULL,
  asins_json JSONB NOT NULL CHECK (jsonb_typeof(asins_json) = 'array'),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  body_json JSONB CHECK (body_json IS NULL OR jsonb_typeof(body_json) = 'object'),
  source_completed_at TIMESTAMPTZ NOT NULL,
  published_at TIMESTAMPTZ NOT NULL,
  body_expires_at TIMESTAMPTZ,
  body_purged_at TIMESTAMPTZ,
  UNIQUE (project_id, source_job_id),
  UNIQUE (project_id, id),
  CHECK (body_json IS NOT NULL OR body_purged_at IS NOT NULL),
  CHECK (body_purged_at IS NULL OR body_json IS NULL),
  CHECK (body_expires_at IS NULL OR body_expires_at >= published_at)
);

CREATE INDEX project_display_versions_expiry_idx
  ON project_display_versions(body_expires_at, id)
  WHERE body_json IS NOT NULL AND body_expires_at IS NOT NULL;

ALTER TABLE projects ADD COLUMN current_display_version_id TEXT;
ALTER TABLE projects ADD CONSTRAINT projects_current_display_version_fk
  FOREIGN KEY (id, current_display_version_id)
  REFERENCES project_display_versions(project_id, id)
  ON DELETE SET NULL (current_display_version_id);
