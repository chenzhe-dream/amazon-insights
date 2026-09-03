CREATE TABLE concurrency_policy_versions (
  policy_version TEXT PRIMARY KEY,
  profile TEXT NOT NULL CHECK (profile IN ('conservative', 'standard', 'fast')),
  whole_job_limit INTEGER NOT NULL CHECK (whole_job_limit > 0),
  seller_sprite_concurrency INTEGER NOT NULL CHECK (seller_sprite_concurrency > 0),
  sif_concurrency INTEGER NOT NULL CHECK (sif_concurrency > 0),
  sorftime_concurrency INTEGER NOT NULL CHECK (sorftime_concurrency > 0),
  model_concurrency INTEGER NOT NULL CHECK (model_concurrency > 0),
  image_concurrency INTEGER NOT NULL CHECK (image_concurrency > 0),
  seller_sprite_rolling_max_attempts INTEGER NOT NULL CHECK (seller_sprite_rolling_max_attempts > 0),
  seller_sprite_rolling_window_ms INTEGER NOT NULL CHECK (seller_sprite_rolling_window_ms > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO concurrency_policy_versions (
  policy_version,
  profile,
  whole_job_limit,
  seller_sprite_concurrency,
  sif_concurrency,
  sorftime_concurrency,
  model_concurrency,
  image_concurrency,
  seller_sprite_rolling_max_attempts,
  seller_sprite_rolling_window_ms
)
VALUES
  ('conservative-v1', 'conservative', 2, 1, 1, 1, 1, 1, 15, 60000),
  ('standard-v1', 'standard', 4, 2, 1, 1, 2, 2, 30, 60000),
  ('fast-v1', 'fast', 6, 3, 2, 2, 3, 3, 30, 60000);

CREATE TABLE concurrency_policy_current (
  organization_id TEXT PRIMARY KEY,
  policy_version TEXT NOT NULL REFERENCES concurrency_policy_versions (policy_version),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO concurrency_policy_current (organization_id, policy_version)
VALUES ('*', 'standard-v1');

ALTER TABLE sync_jobs
ADD COLUMN policy_version TEXT NOT NULL DEFAULT 'standard-v1'
  REFERENCES concurrency_policy_versions (policy_version);

CREATE INDEX sync_jobs_policy_version_idx
ON sync_jobs (policy_version);

CREATE TABLE concurrency_resource_permits (
  permit_id TEXT PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('wholeJob', 'sellerSprite', 'sif', 'sorftime', 'model', 'image')),
  job_id TEXT NOT NULL,
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('initial', 'retry', 'repair', 'probe', 'quota-refresh')),
  owner_id TEXT NOT NULL,
  lease_generation INTEGER NOT NULL DEFAULT 1 CHECK (lease_generation > 0),
  policy_version TEXT NOT NULL REFERENCES concurrency_policy_versions (policy_version),
  acquired_at TIMESTAMPTZ NOT NULL,
  lease_expires_at TIMESTAMPTZ NOT NULL,
  released_at TIMESTAMPTZ,
  CHECK (char_length(owner_id) BETWEEN 1 AND 200),
  CHECK (lease_expires_at > acquired_at)
);

CREATE INDEX concurrency_resource_permits_active_idx
ON concurrency_resource_permits (organization_id, resource, lease_expires_at)
WHERE released_at IS NULL;

CREATE TABLE concurrency_physical_attempts (
  id BIGSERIAL PRIMARY KEY,
  organization_id TEXT NOT NULL,
  resource TEXT NOT NULL CHECK (resource IN ('wholeJob', 'sellerSprite', 'sif', 'sorftime', 'model', 'image')),
  job_id TEXT NOT NULL,
  attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('initial', 'retry', 'repair', 'probe', 'quota-refresh')),
  policy_version TEXT NOT NULL REFERENCES concurrency_policy_versions (policy_version),
  recorded_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX concurrency_physical_attempts_sellersprite_window_idx
ON concurrency_physical_attempts (organization_id, recorded_at)
WHERE resource = 'sellerSprite';

CREATE INDEX concurrency_physical_attempts_job_idx
ON concurrency_physical_attempts (organization_id, job_id, recorded_at DESC);
