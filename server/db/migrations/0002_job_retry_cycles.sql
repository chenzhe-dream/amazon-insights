ALTER TABLE job_attempts
ADD COLUMN retry_cycle_start_attempt INTEGER NOT NULL DEFAULT 1
CHECK (
  retry_cycle_start_attempt > 0
  AND retry_cycle_start_attempt <= attempt_number
);
