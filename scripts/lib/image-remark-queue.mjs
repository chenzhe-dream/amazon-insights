import { readImageRemarkFailureDiagnostic } from "./image-remark-request.mjs";
import { ResourceGovernorAdmissionError, governExternalRequest } from "./postgres-resource-governor.mjs";
import { imageRemarkOutcome, validImageRemarkAttemptJobId } from "./image-remark-outcome.mjs";
import {
  IMAGE_REMARK_CONCURRENCY,
  IMAGE_REMARK_TIMEOUT_MS,
} from "./image-remark-policy.mjs";

export { IMAGE_REMARK_CONCURRENCY, IMAGE_REMARK_TIMEOUT_MS } from "./image-remark-policy.mjs";

const RETRYABLE_IMAGE_REMARK_STATUSES = new Set(["timeout", "connector-failed"]);

export function shouldQueueImageRemarkSlot({ outcome, force = false, jobId } = {}) {
  const status = outcome?.status;
  if (!force && outcome?.diagnostic) {
    const diagnostic = outcome.diagnostic;
    if (["invalid-json", "invalid-output"].includes(diagnostic.errorClass)) return false;
    if (diagnostic.errorClass === "http" && diagnostic.httpStatus !== 429 && diagnostic.httpStatus < 500) return false;
  }
  if (status === "ready" || status === "upstream-empty") return force;
  if (!RETRYABLE_IMAGE_REMARK_STATUSES.has(status)) return true;
  const currentJobId = validImageRemarkAttemptJobId(jobId);
  const previousJobId = validImageRemarkAttemptJobId(outcome?.attemptJobId);
  if (!currentJobId) return false;
  if (!previousJobId) return true;
  return currentJobId !== previousJobId;
}

function timeoutResult(attemptJobId) {
  return imageRemarkOutcome("timeout", { attemptJobId });
}

function failureResult(attemptJobId, error) {
  return imageRemarkOutcome("connector-failed", { attemptJobId, diagnostic: error instanceof ResourceGovernorAdmissionError ? {stage:"governance",httpStatus:null,errorClass:"governance",governanceCategory:error.reason} : readImageRemarkFailureDiagnostic(error) });
}

async function runOne(item, worker, timeoutMs, governorContext) {
  const controller = new AbortController();
  let timeout;
  const work = Promise.resolve()
    .then(() => governExternalRequest({
      ...governorContext,
      resource: "image",
      attemptKind: "initial",
      operation: () => worker(item, { signal: controller.signal }),
    }))
    .catch(error => {
      if (!(error instanceof ResourceGovernorAdmissionError) && !readImageRemarkFailureDiagnostic(error)) throw error;
      return failureResult(governorContext.jobId, error);
    });
  try {
    const result = await Promise.race([
      work,
      new Promise(resolve => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, timeoutMs);
      }),
    ]);
    if (result !== null) return imageRemarkOutcome(result?.status, { attemptJobId: governorContext.jobId, diagnostic: result?.diagnostic });
    return timeoutResult(governorContext.jobId);
  } catch (error) {
    if (!(error instanceof ResourceGovernorAdmissionError) && !readImageRemarkFailureDiagnostic(error)) throw error;
    return failureResult(governorContext.jobId, error);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * @typedef {object} ImageRemarkQueueOptions
 * @property {number} [concurrency]
 * @property {number} [timeoutMs]
 * @property {(progress: Readonly<{completed: number, total: number, status: import('./image-remark-outcome.mjs').ImageRemarkOutcome['status']}>, index: number) => void | Promise<void>} [onSettled]
 * @property {import('./postgres-resource-governor.mjs').ScriptResourceGovernor} [resourceGovernor]
 * @property {boolean} [requireResourceGovernor]
 * @property {string | null} [organizationId]
 * @property {string | null} [jobId]
 * @property {Readonly<Record<string, string | undefined>>} [env]
 */

/**
 * @template T
 * @param {readonly T[]} items
 * @param {(item: T, context: { signal: AbortSignal }) => Promise<{ status?: unknown } | null | undefined>} worker
 * @param {ImageRemarkQueueOptions} [options]
 * @returns {Promise<import('./image-remark-outcome.mjs').ImageRemarkOutcome[]>}
 */
export async function runImageRemarkQueue(items, worker, options = {}) {
  const {
    concurrency = IMAGE_REMARK_CONCURRENCY,
    timeoutMs = IMAGE_REMARK_TIMEOUT_MS,
    onSettled = () => undefined,
    resourceGovernor,
    requireResourceGovernor,
    organizationId,
    jobId,
    env = process.env,
  } = options;
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;
  const workerCount = Math.min(IMAGE_REMARK_CONCURRENCY, Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await runOne(items[index], worker, timeoutMs, {
        resourceGovernor,
        requireResourceGovernor,
        organizationId,
        jobId,
        env,
      });
      results[index] = imageRemarkOutcome(results[index]?.status, {
        attemptJobId: results[index]?.attemptJobId,
        diagnostic: results[index]?.diagnostic,
      });
      completed += 1;
      await onSettled(
        Object.freeze({
          completed,
          total: items.length,
          status: results[index]?.status ?? "upstream-empty",
          ...(results[index]?.diagnostic ? {diagnostic: results[index].diagnostic} : {}),
        }),
        index,
      );
    }
  }));
  return results;
}

export function aggregateImageRemarkResults(results, {
  completeWithoutWork = false,
  persistedComplete = false,
} = {}) {
  const statuses = results.map(result => result?.status);
  if (!statuses.length) return completeWithoutWork ? "ready" : "upstream-empty";
  if (statuses.some(status => status === "timeout")) return "timeout";
  if (statuses.some(status => status === "connector-failed")) return "connector-failed";
  if (statuses.some(status => status === "upstream-empty")) {
    return persistedComplete ? "ready" : "upstream-empty";
  }
  return "ready";
}
