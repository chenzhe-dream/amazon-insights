CREATE TABLE sync_jobs (
  job_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  fingerprint TEXT NOT NULL,
  marketplace TEXT NOT NULL CHECK (marketplace = 'US'),
  asins JSONB NOT NULL CHECK (jsonb_typeof(asins) = 'array' AND jsonb_array_length(asins) BETWEEN 1 AND 10),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed')),
  message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
  current_stage_id TEXT NOT NULL CHECK (char_length(current_stage_id) BETWEEN 1 AND 200),
  stages JSONB NOT NULL CHECK (jsonb_typeof(stages) = 'array'),
  asin_progress JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(asin_progress) = 'object'),
  leased_by TEXT,
  lease_generation INTEGER NOT NULL DEFAULT 0 CHECK (lease_generation >= 0),
  lease_expires_at TIMESTAMPTZ,
  error JSONB,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  CHECK (
    (status = 'running' AND leased_by IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR (status <> 'running')
  )
);

CREATE UNIQUE INDEX sync_jobs_active_fingerprint_idx
ON sync_jobs (organization_id, fingerprint)
WHERE status IN ('queued', 'running');

CREATE INDEX sync_jobs_claim_idx
ON sync_jobs (status, created_at, job_id)
WHERE status IN ('queued', 'running');

CREATE INDEX sync_jobs_scope_idx
ON sync_jobs (organization_id, project_id, run_id, created_at DESC);

CREATE TABLE sync_job_submissions (
  id BIGSERIAL PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES sync_jobs (job_id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  project_id TEXT,
  run_id TEXT,
  actor_id TEXT,
  fingerprint TEXT NOT NULL,
  asins JSONB NOT NULL CHECK (jsonb_typeof(asins) = 'array' AND jsonb_array_length(asins) BETWEEN 1 AND 10),
  marketplace TEXT NOT NULL CHECK (marketplace = 'US'),
  disposition TEXT NOT NULL CHECK (disposition IN ('created', 'deduplicated')),
  submitted_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX sync_job_submissions_job_idx
ON sync_job_submissions (job_id, submitted_at DESC);

CREATE TABLE sync_job_modules (
  job_id TEXT NOT NULL REFERENCES sync_jobs (job_id) ON DELETE CASCADE,
  asin TEXT NOT NULL CHECK (char_length(asin) = 10),
  module TEXT NOT NULL CHECK (char_length(module) BETWEEN 1 AND 100),
  status TEXT NOT NULL CHECK (status IN ('ready', 'upstream-empty', 'timeout', 'connector-failed', 'pending', 'manual')),
  reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 240),
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job_id, asin, module)
);

CREATE INDEX sync_job_modules_job_idx
ON sync_job_modules (job_id, updated_at DESC);
