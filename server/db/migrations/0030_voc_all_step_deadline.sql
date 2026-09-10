-- Preserve actual publication-attempt counts when a VOC deadline ends recovery.
ALTER TABLE job_attempts ADD COLUMN voc_deadline_started_at TEXT CHECK (voc_deadline_started_at IS NULL OR unixepoch(voc_deadline_started_at) IS NOT NULL);
DROP TRIGGER job_attempts_report_publication_state_insert;
DROP TRIGGER job_attempts_report_publication_state_update;
CREATE TRIGGER job_attempts_report_publication_state_insert
BEFORE INSERT ON job_attempts
BEGIN
  SELECT CASE WHEN NOT (
    typeof(NEW.report_publication_cycle) = 'integer'
    AND NEW.report_publication_cycle >= 1
    AND typeof(NEW.report_publication_attempt_count) = 'integer'
    AND NEW.report_publication_attempt_count >= 0
    AND (
      (
        NEW.report_publication_max_attempts IS NULL
        AND NEW.report_publication_initial_delay_ms IS NULL
        AND NEW.report_publication_max_delay_ms IS NULL
        AND NEW.report_publication_attempt_count = 0
        AND NEW.report_publication_retry_at IS NULL
      )
      OR (
        typeof(NEW.report_publication_max_attempts) = 'integer'
        AND NEW.report_publication_max_attempts > 0
        AND typeof(NEW.report_publication_initial_delay_ms) = 'integer'
        AND NEW.report_publication_initial_delay_ms > 0
        AND typeof(NEW.report_publication_max_delay_ms) = 'integer'
        AND NEW.report_publication_max_delay_ms > 0
        AND NEW.report_publication_initial_delay_ms <= NEW.report_publication_max_delay_ms
        AND NEW.report_publication_attempt_count <= NEW.report_publication_max_attempts
        AND (
          (
            NEW.status IS 'failed'
            AND NEW.retryable IS 1
            AND NEW.report_publication_attempt_count < NEW.report_publication_max_attempts
            AND NEW.report_publication_retry_at IS NOT NULL
            AND typeof(NEW.report_publication_retry_at) = 'text'
            AND length(NEW.report_publication_retry_at) = 24
            AND NEW.report_publication_retry_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.report_publication_retry_at)
              IS NEW.report_publication_retry_at
          )
          OR (
            NEW.retryable IS NOT 1
            AND NEW.report_publication_retry_at IS NULL
            AND (
              NEW.status IS NOT 'failed'
              OR NEW.report_publication_attempt_count IS NEW.report_publication_max_attempts
              OR (NEW.status IS 'failed' AND json_extract(NEW.error_json, '$.code') IS 'QUEUE_TIMEOUT')
            )
          )
        )
      )
    )
  ) THEN RAISE(ABORT, 'job attempt report publication state is invalid') END;
END;

CREATE TRIGGER job_attempts_report_publication_state_update
BEFORE UPDATE OF status,
  retryable,
  report_publication_cycle,
  report_publication_attempt_count,
  report_publication_max_attempts,
  report_publication_initial_delay_ms,
  report_publication_max_delay_ms,
  report_publication_retry_at ON job_attempts
BEGIN
  SELECT CASE WHEN NOT (
    typeof(NEW.report_publication_cycle) = 'integer'
    AND NEW.report_publication_cycle >= 1
    AND typeof(NEW.report_publication_attempt_count) = 'integer'
    AND NEW.report_publication_attempt_count >= 0
    AND (
      (
        NEW.report_publication_max_attempts IS NULL
        AND NEW.report_publication_initial_delay_ms IS NULL
        AND NEW.report_publication_max_delay_ms IS NULL
        AND NEW.report_publication_attempt_count = 0
        AND NEW.report_publication_retry_at IS NULL
      )
      OR (
        typeof(NEW.report_publication_max_attempts) = 'integer'
        AND NEW.report_publication_max_attempts > 0
        AND typeof(NEW.report_publication_initial_delay_ms) = 'integer'
        AND NEW.report_publication_initial_delay_ms > 0
        AND typeof(NEW.report_publication_max_delay_ms) = 'integer'
        AND NEW.report_publication_max_delay_ms > 0
        AND NEW.report_publication_initial_delay_ms <= NEW.report_publication_max_delay_ms
        AND NEW.report_publication_attempt_count <= NEW.report_publication_max_attempts
        AND (
          (
            NEW.status IS 'failed'
            AND NEW.retryable IS 1
            AND NEW.report_publication_attempt_count < NEW.report_publication_max_attempts
            AND NEW.report_publication_retry_at IS NOT NULL
            AND typeof(NEW.report_publication_retry_at) = 'text'
            AND length(NEW.report_publication_retry_at) = 24
            AND NEW.report_publication_retry_at GLOB '????-??-??T??:??:??.???Z'
            AND strftime('%Y-%m-%dT%H:%M:%fZ', NEW.report_publication_retry_at)
              IS NEW.report_publication_retry_at
          )
          OR (
            NEW.retryable IS NOT 1
            AND NEW.report_publication_retry_at IS NULL
            AND (
              NEW.status IS NOT 'failed'
              OR NEW.report_publication_attempt_count IS NEW.report_publication_max_attempts
              OR (NEW.status IS 'failed' AND json_extract(NEW.error_json, '$.code') IS 'QUEUE_TIMEOUT')
            )
          )
        )
      )
    )
  ) THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN NOT (
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    OR (
      NEW.report_publication_cycle = OLD.report_publication_cycle + 1
      AND OLD.status IS 'failed'
      AND OLD.retryable IS 0
      AND typeof(OLD.report_publication_max_attempts) = 'integer'
      AND (OLD.report_publication_attempt_count IS OLD.report_publication_max_attempts OR json_extract(OLD.error_json, '$.code') IS 'QUEUE_TIMEOUT')
      AND NEW.status IS 'queued'
      AND NEW.retryable IS 0
      AND NEW.report_publication_attempt_count = 0
      AND NEW.report_publication_max_attempts IS NULL
      AND NEW.report_publication_initial_delay_ms IS NULL
      AND NEW.report_publication_max_delay_ms IS NULL
      AND NEW.report_publication_retry_at IS NULL
    )
  ) THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND NOT (
      (OLD.status IN ('queued', 'running', 'failed') AND NEW.status IS 'failed' AND NEW.retryable IS 0
       AND NEW.report_publication_retry_at IS NULL AND NEW.leased_by IS NULL AND NEW.lease_expires_at IS NULL
       AND json_extract(NEW.error_json, '$.code') IS 'QUEUE_TIMEOUT'
       AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count)
      OR
      (
        OLD.status IS 'running'
        AND NEW.status IS 'failed'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count + 1
      )
      OR (
        OLD.status IS 'failed'
        AND OLD.retryable IS 1
        AND NEW.status IS 'running'
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
      OR (
        OLD.status IS 'running'
        AND (NEW.status IS 'queued' OR NEW.status IS 'succeeded')
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
      OR (
        OLD.status IS NEW.status
        AND OLD.retryable IS NEW.retryable
        AND NEW.report_publication_attempt_count IS OLD.report_publication_attempt_count
      )
    )
  THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;

  SELECT CASE WHEN
    NEW.report_publication_cycle IS OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND (
      NEW.report_publication_max_attempts IS NOT OLD.report_publication_max_attempts
      OR NEW.report_publication_initial_delay_ms IS NOT OLD.report_publication_initial_delay_ms
      OR NEW.report_publication_max_delay_ms IS NOT OLD.report_publication_max_delay_ms
      OR NEW.report_publication_attempt_count < OLD.report_publication_attempt_count
      OR NEW.report_publication_attempt_count > OLD.report_publication_attempt_count + 1
    )
  THEN RAISE(ABORT, 'job attempt report publication transition is invalid') END;
END;
-- Explicit ownership prevents a new input from reviving another expired chain.
CREATE TABLE alexa_voc_normalization_input_jobs (
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE CASCADE,
  origin_job_id TEXT NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY (snapshot_id, origin_job_id)
);
CREATE INDEX alexa_voc_input_jobs_origin ON alexa_voc_normalization_input_jobs(origin_job_id);
CREATE TRIGGER alexa_voc_input_jobs_scope_insert BEFORE INSERT ON alexa_voc_normalization_input_jobs
WHEN NOT EXISTS (
  SELECT 1 FROM data_snapshots ds JOIN job_attempts origin ON origin.id = NEW.origin_job_id
  JOIN run_stages stage ON stage.id = origin.stage_id
  WHERE ds.id = NEW.snapshot_id AND ds.run_id = stage.run_id
    AND ds.artifact_kind = 'alexa-voc-normalization-input' AND ds.snapshot_kind = 'alexa-voc-normalization-input'
    AND stage.stage = 'alexa-voc-normalization' AND origin.attempt_number = origin.retry_cycle_start_attempt
)
BEGIN SELECT RAISE(ABORT, 'normalization input ownership scope is invalid'); END;
CREATE TRIGGER alexa_voc_input_jobs_scope_update BEFORE UPDATE ON alexa_voc_normalization_input_jobs
BEGIN SELECT RAISE(ABORT, 'normalization input ownership is immutable'); END;
-- Legacy inputs were shared by the whole run. Preserve only their existing
-- chains; future submissions never acquire these rows implicitly.
INSERT INTO alexa_voc_normalization_input_jobs(snapshot_id, origin_job_id)
SELECT ds.id, origin.id FROM data_snapshots ds
JOIN run_stages stage ON stage.run_id = ds.run_id AND stage.stage = 'alexa-voc-normalization'
JOIN job_attempts origin ON origin.stage_id = stage.id AND origin.attempt_number = origin.retry_cycle_start_attempt
WHERE ds.artifact_kind = 'alexa-voc-normalization-input';
