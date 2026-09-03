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
VALUES (
  'standard-v2',
  'standard',
  4,
  2,
  1,
  1,
  2,
  4,
  30,
  60000
);

UPDATE concurrency_policy_current
SET policy_version = 'standard-v2',
    updated_at = CURRENT_TIMESTAMP
WHERE policy_version = 'standard-v1';

ALTER TABLE sync_jobs
ALTER COLUMN policy_version SET DEFAULT 'standard-v2';
