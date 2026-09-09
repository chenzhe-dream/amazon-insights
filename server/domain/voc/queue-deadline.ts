import { VOC_QUEUE_TIMEOUT_MESSAGE } from "../../../shared/voc-queue-timeout";

export const DEFAULT_VOC_QUEUE_TIMEOUT_MS = 300_000;

export function vocQueueCutoff(checkedAt: string, timeoutMs: number): string {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 3_600_000) {
    throw new TypeError("VOC queue timeout must be 1000–3600000 milliseconds");
  }
  const time = Date.parse(checkedAt);
  if (!Number.isFinite(time)) throw new TypeError("Invalid queue check timestamp");
  return new Date(time - timeoutMs).toISOString();
}

// These fragments use fixed internal aliases, never user-provided SQL identifiers.
const latestAttemptSql = `NOT EXISTS (
    SELECT 1 FROM job_attempts newer
    WHERE newer.stage_id = ja.stage_id AND newer.attempt_number > ja.attempt_number
  )`;

export const latestActiveAttemptSql = `
  ar.status NOT IN ('cancelled', 'succeeded')
  AND rs.status NOT IN ('cancelled', 'succeeded', 'skipped', 'stale')
  AND ${latestAttemptSql}`;

// Normalization can append new ASIN work while an earlier cycle still needs
// publication recovery. Do not discard that legitimate predecessor.
export const claimableAttemptSql = `ar.status <> 'cancelled' AND rs.status <> 'cancelled'
  AND (rs.stage <> 'voc-positioning' OR ${latestAttemptSql})`;

export function expiredVocWaitSql(cutoff: "?" | "$1" | "$3"): string {
  return `rs.stage = 'voc-positioning'
    AND (ja.status = 'queued' OR
      (ja.status = 'failed' AND ja.retryable = TRUE AND ja.retry_scheduled_at IS NULL))
    AND ja.available_at <= ${cutoff}
    AND ja.report_publication_max_attempts IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM agent_runs audit
      WHERE audit.stage_id = ja.stage_id
        AND audit.logical_execution_cycle_id = ja.logical_execution_cycle_id
        AND (audit.validation_status IN ('pending', 'passed') OR EXISTS (
          SELECT 1 FROM analysis_reports report WHERE report.agent_run_id = audit.id
        ))
    )`;
}

export function vocQueueTimeoutError() {
  return { code: "QUEUE_TIMEOUT", message: VOC_QUEUE_TIMEOUT_MESSAGE, retryable: false };
}
