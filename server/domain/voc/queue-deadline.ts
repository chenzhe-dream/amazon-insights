import { VOC_QUEUE_TIMEOUT_MESSAGE } from "../../../shared/voc-queue-timeout";

export const DEFAULT_VOC_QUEUE_TIMEOUT_MS = 300_000;

export function isVocDeadlineStage(stage: string): boolean {
  return stage === "alexa-voc-normalization" || stage === "voc-positioning" || stage === "product-definition";
}

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
  AND (rs.stage = 'alexa-voc-normalization' OR ${latestAttemptSql})`;

// Normalization can append new ASIN work while an earlier cycle still needs
// publication recovery. Do not discard that legitimate predecessor.
export const claimableAttemptSql = `ar.status <> 'cancelled' AND rs.status <> 'cancelled'
  AND (rs.stage <> 'voc-positioning' OR ${latestAttemptSql})`;

export function expiredVocWaitSql(cutoff: "?" | "$1" | "$3"): string {
  return `rs.stage IN ('alexa-voc-normalization', 'voc-positioning', 'product-definition')
    AND (ja.status IN ('queued', 'running') OR
      (ja.status = 'failed' AND ja.retryable = TRUE AND ja.retry_scheduled_at IS NULL))
    AND COALESCE(ja.voc_deadline_started_at, (
      SELECT COALESCE(origin.voc_deadline_started_at, origin.created_at) FROM job_attempts origin
      WHERE origin.stage_id = ja.stage_id
        AND origin.attempt_number = ja.retry_cycle_start_attempt
    ), ja.created_at) <= ${cutoff}`;
}

export function vocQueueTimeoutError() {
  return { code: "QUEUE_TIMEOUT", message: VOC_QUEUE_TIMEOUT_MESSAGE, retryable: false };
}
