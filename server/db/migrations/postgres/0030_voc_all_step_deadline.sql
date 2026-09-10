ALTER TABLE job_attempts ADD COLUMN voc_deadline_started_at TIMESTAMPTZ;
CREATE OR REPLACE FUNCTION job_report_publication_state_is_valid(attempt job_attempts)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
BEGIN
  IF attempt.report_publication_cycle < 1
    OR attempt.report_publication_attempt_count < 0
  THEN
    RETURN FALSE;
  END IF;

  IF attempt.report_publication_max_attempts IS NULL
    AND attempt.report_publication_initial_delay_ms IS NULL
    AND attempt.report_publication_max_delay_ms IS NULL
    AND attempt.report_publication_attempt_count = 0
    AND attempt.report_publication_retry_at IS NULL
  THEN
    RETURN TRUE;
  END IF;

  IF attempt.report_publication_max_attempts IS NULL
    OR attempt.report_publication_max_attempts <= 0
    OR attempt.report_publication_initial_delay_ms IS NULL
    OR attempt.report_publication_initial_delay_ms <= 0
    OR attempt.report_publication_max_delay_ms IS NULL
    OR attempt.report_publication_max_delay_ms <= 0
    OR attempt.report_publication_initial_delay_ms > attempt.report_publication_max_delay_ms
    OR attempt.report_publication_attempt_count > attempt.report_publication_max_attempts
  THEN
    RETURN FALSE;
  END IF;

  IF attempt.status = 'failed'
    AND attempt.retryable = TRUE
    AND attempt.report_publication_attempt_count < attempt.report_publication_max_attempts
    AND attempt.report_publication_retry_at IS NOT NULL
  THEN
    RETURN TRUE;
  END IF;

  RETURN attempt.retryable = FALSE
    AND attempt.report_publication_retry_at IS NULL
    AND (
      attempt.status <> 'failed'
      OR attempt.report_publication_attempt_count = attempt.report_publication_max_attempts
      OR (attempt.status = 'failed' AND attempt.error_json ->> 'code' IS NOT DISTINCT FROM 'QUEUE_TIMEOUT')
    );
END;
$$;
CREATE OR REPLACE FUNCTION enforce_job_report_publication_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT job_report_publication_state_is_valid(NEW) THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NOT (
    NEW.report_publication_cycle = OLD.report_publication_cycle
    OR (
      NEW.report_publication_cycle = OLD.report_publication_cycle + 1
      AND OLD.status = 'failed'
      AND OLD.retryable = FALSE
      AND OLD.report_publication_max_attempts IS NOT NULL
      AND (OLD.report_publication_attempt_count = OLD.report_publication_max_attempts OR OLD.error_json ->> 'code' IS NOT DISTINCT FROM 'QUEUE_TIMEOUT')
      AND NEW.status = 'queued'
      AND NEW.retryable = FALSE
      AND NEW.report_publication_attempt_count = 0
      AND NEW.report_publication_max_attempts IS NULL
      AND NEW.report_publication_initial_delay_ms IS NULL
      AND NEW.report_publication_max_delay_ms IS NULL
      AND NEW.report_publication_retry_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NEW.report_publication_cycle = OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND NOT (
      (OLD.status IN ('queued', 'running', 'failed') AND NEW.status = 'failed' AND NEW.retryable = FALSE
       AND NEW.report_publication_retry_at IS NULL AND NEW.leased_by IS NULL AND NEW.lease_expires_at IS NULL
       AND NEW.error_json ->> 'code' IS NOT DISTINCT FROM 'QUEUE_TIMEOUT'
       AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count)
      OR
      (
        OLD.status = 'running'
        AND NEW.status = 'failed'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count + 1
      )
      OR (
        OLD.status = 'failed'
        AND OLD.retryable = TRUE
        AND NEW.status = 'running'
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
      OR (
        OLD.status = 'running'
        AND NEW.status IN ('queued', 'succeeded')
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
      OR (
        OLD.status = NEW.status
        AND OLD.retryable = NEW.retryable
        AND NEW.report_publication_attempt_count = OLD.report_publication_attempt_count
      )
    )
  THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  IF NEW.report_publication_cycle = OLD.report_publication_cycle
    AND OLD.report_publication_max_attempts IS NOT NULL
    AND (
      NEW.report_publication_max_attempts IS DISTINCT FROM OLD.report_publication_max_attempts
      OR NEW.report_publication_initial_delay_ms IS DISTINCT FROM OLD.report_publication_initial_delay_ms
      OR NEW.report_publication_max_delay_ms IS DISTINCT FROM OLD.report_publication_max_delay_ms
      OR NEW.report_publication_attempt_count < OLD.report_publication_attempt_count
      OR NEW.report_publication_attempt_count > OLD.report_publication_attempt_count + 1
    )
  THEN
    RAISE EXCEPTION 'job attempt report publication transition is invalid';
  END IF;

  RETURN NEW;
END;
$$;
CREATE TABLE alexa_voc_normalization_input_jobs (
  snapshot_id TEXT NOT NULL REFERENCES data_snapshots(id) ON DELETE CASCADE,
  origin_job_id TEXT NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  PRIMARY KEY (snapshot_id, origin_job_id)
);
CREATE INDEX alexa_voc_input_jobs_origin ON alexa_voc_normalization_input_jobs(origin_job_id);
CREATE FUNCTION enforce_alexa_voc_input_job_scope() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' OR NOT EXISTS (
    SELECT 1 FROM data_snapshots ds JOIN job_attempts origin ON origin.id = NEW.origin_job_id
    JOIN run_stages stage ON stage.id = origin.stage_id
    WHERE ds.id = NEW.snapshot_id AND ds.run_id = stage.run_id
      AND ds.artifact_kind = 'alexa-voc-normalization-input' AND ds.snapshot_kind = 'alexa-voc-normalization-input'
      AND stage.stage = 'alexa-voc-normalization' AND origin.attempt_number = origin.retry_cycle_start_attempt
  ) THEN RAISE EXCEPTION 'normalization input ownership scope is invalid' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER alexa_voc_input_jobs_scope BEFORE INSERT OR UPDATE ON alexa_voc_normalization_input_jobs
FOR EACH ROW EXECUTE FUNCTION enforce_alexa_voc_input_job_scope();
-- Preserve historical shared batches only within their existing retry roots.
INSERT INTO alexa_voc_normalization_input_jobs(snapshot_id, origin_job_id)
SELECT ds.id, origin.id FROM data_snapshots ds
JOIN run_stages stage ON stage.run_id = ds.run_id AND stage.stage = 'alexa-voc-normalization'
JOIN job_attempts origin ON origin.stage_id = stage.id AND origin.attempt_number = origin.retry_cycle_start_attempt
WHERE ds.artifact_kind = 'alexa-voc-normalization-input';
