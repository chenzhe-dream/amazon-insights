ALTER TABLE concurrency_resource_permits
  DROP CONSTRAINT concurrency_resource_permits_attempt_kind_check;

ALTER TABLE concurrency_resource_permits
  ADD CONSTRAINT concurrency_resource_permits_attempt_kind_check
  CHECK (attempt_kind IN ('initial', 'retry', 'repair', 'probe', 'quota-refresh', 'transient-retry'));

ALTER TABLE concurrency_physical_attempts
  DROP CONSTRAINT concurrency_physical_attempts_attempt_kind_check;

ALTER TABLE concurrency_physical_attempts
  ADD CONSTRAINT concurrency_physical_attempts_attempt_kind_check
  CHECK (attempt_kind IN ('initial', 'retry', 'repair', 'probe', 'quota-refresh', 'transient-retry'));

ALTER TABLE concurrency_resource_permits
  ADD COLUMN stage_id TEXT,
  ADD COLUMN logical_operation_key TEXT,
  ADD COLUMN dispatch_key TEXT;

UPDATE concurrency_resource_permits
SET stage_id = 'unknown-stage',
    logical_operation_key = 'legacy:permit:' || encode(sha256(convert_to(permit_id, 'UTF8')), 'hex'),
    dispatch_key = 'legacy:permit:' || encode(sha256(convert_to(permit_id, 'UTF8')), 'hex');

ALTER TABLE concurrency_resource_permits
  ALTER COLUMN stage_id SET NOT NULL,
  ALTER COLUMN stage_id SET DEFAULT 'unknown-stage',
  ALTER COLUMN logical_operation_key SET NOT NULL,
  ALTER COLUMN logical_operation_key SET DEFAULT 'legacy',
  ALTER COLUMN dispatch_key SET NOT NULL,
  ALTER COLUMN dispatch_key SET DEFAULT 'legacy',
  ADD CONSTRAINT concurrency_resource_permits_stage_id_check
    CHECK (char_length(stage_id) BETWEEN 1 AND 100),
  ADD CONSTRAINT concurrency_resource_permits_logical_operation_key_check
    CHECK (char_length(logical_operation_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT concurrency_resource_permits_dispatch_key_check
    CHECK (char_length(dispatch_key) BETWEEN 1 AND 240);

ALTER TABLE concurrency_physical_attempts
  ADD COLUMN stage_id TEXT,
  ADD COLUMN logical_operation_key TEXT,
  ADD COLUMN dispatch_key TEXT;

UPDATE concurrency_physical_attempts
SET stage_id = 'unknown-stage',
    logical_operation_key = 'legacy:physical-attempt:' || id::text,
    dispatch_key = 'legacy:physical-attempt:' || id::text;

ALTER TABLE concurrency_physical_attempts
  ALTER COLUMN stage_id SET NOT NULL,
  ALTER COLUMN stage_id SET DEFAULT 'unknown-stage',
  ALTER COLUMN logical_operation_key SET NOT NULL,
  ALTER COLUMN logical_operation_key SET DEFAULT 'legacy',
  ALTER COLUMN dispatch_key SET NOT NULL,
  ALTER COLUMN dispatch_key SET DEFAULT 'legacy',
  ADD CONSTRAINT concurrency_physical_attempts_stage_id_check
    CHECK (char_length(stage_id) BETWEEN 1 AND 100),
  ADD CONSTRAINT concurrency_physical_attempts_logical_operation_key_check
    CHECK (char_length(logical_operation_key) BETWEEN 1 AND 200),
  ADD CONSTRAINT concurrency_physical_attempts_dispatch_key_check
    CHECK (char_length(dispatch_key) BETWEEN 1 AND 240);

CREATE INDEX concurrency_physical_attempts_logical_operation_idx
ON concurrency_physical_attempts (
  organization_id,
  job_id,
  stage_id,
  logical_operation_key,
  recorded_at
);
