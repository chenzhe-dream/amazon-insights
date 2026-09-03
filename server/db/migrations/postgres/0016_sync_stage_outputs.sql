ALTER TABLE sync_jobs
  ADD COLUMN job_version BIGINT NOT NULL DEFAULT 1 CHECK (job_version > 0);

CREATE TABLE sync_job_stage_outputs (
  job_id TEXT NOT NULL REFERENCES sync_jobs (job_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  stage_id TEXT NOT NULL CHECK (stage_id IN ('keywords','reviews','sales_trend','fba','listing','category','traffic')),
  stage_status TEXT NOT NULL CHECK (stage_status IN ('done','partial','failed')),
  output_version BIGINT NOT NULL DEFAULT 1 CHECK (output_version > 0),
  content_hash TEXT NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  data_json JSONB,
  gap_json JSONB,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, stage_id),
  CHECK ((data_json IS NOT NULL)::integer + (gap_json IS NOT NULL)::integer = 1)
);

CREATE INDEX sync_job_stage_outputs_scope_idx
ON sync_job_stage_outputs (organization_id, project_id, run_id, job_id, stage_id);
