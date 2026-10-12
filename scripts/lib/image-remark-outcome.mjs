import { sanitizeImageRemarkFailureDiagnostic } from "./image-remark-request.mjs";

export const IMAGE_REMARK_OUTCOME_REASONS = Object.freeze({
  ready: "图片备注已就绪",
  "upstream-empty": "上游未返回可用图片备注",
  timeout: "图片分析超过 120 秒",
  "connector-failed": "图片分析连接器失败",
});

export const IMAGE_REMARK_OUTCOME_STATUSES = Object.freeze(
  Object.keys(IMAGE_REMARK_OUTCOME_REASONS),
);

const SAFE_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function validImageRemarkAttemptJobId(value) {
  const jobId = typeof value === "string" ? value.trim() : "";
  return SAFE_JOB_ID_PATTERN.test(jobId) ? jobId : null;
}

/**
 * @typedef {object} ImageRemarkOutcome
 * @property {keyof typeof IMAGE_REMARK_OUTCOME_REASONS} status
 * @property {string} reason
 * @property {string} [attemptJobId]
 * @property {object} [diagnostic]
 */

/**
 * @param {unknown} status
 * @param {{ attemptJobId?: unknown, diagnostic?: unknown }} [options]
 * @returns {ImageRemarkOutcome}
 */
export function imageRemarkOutcome(status, options = {}) {
  const { attemptJobId, diagnostic } = options;
  const safeStatus = Object.hasOwn(IMAGE_REMARK_OUTCOME_REASONS, status)
    ? status
    : "upstream-empty";
  const outcome = {
    status: safeStatus,
    reason: IMAGE_REMARK_OUTCOME_REASONS[safeStatus],
  };
  const safeAttemptJobId = validImageRemarkAttemptJobId(attemptJobId);
  if ((safeStatus === "timeout" || safeStatus === "connector-failed") && safeAttemptJobId) {
    outcome.attemptJobId = safeAttemptJobId;
  }
  const safeDiagnostic = sanitizeImageRemarkFailureDiagnostic(diagnostic);
  if (safeStatus === "connector-failed" && safeDiagnostic) outcome.diagnostic = safeDiagnostic;
  return outcome;
}
