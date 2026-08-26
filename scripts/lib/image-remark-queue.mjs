import { governExternalRequest } from "./postgres-resource-governor.mjs";

export const IMAGE_REMARK_CONCURRENCY = 4;
export const IMAGE_REMARK_TIMEOUT_MS = 120_000;

function timeoutResult() {
  return { status: "timeout", reason: "图片分析超过 120 秒" };
}

function failureResult() {
  return { status: "connector-failed", reason: "图片分析连接器失败" };
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
    .catch(() => failureResult());
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
    if (result !== null) return result;
    return timeoutResult();
  } catch {
    return failureResult();
  } finally {
    clearTimeout(timeout);
  }
}

export async function runImageRemarkQueue(items, worker, {
  concurrency = IMAGE_REMARK_CONCURRENCY,
  timeoutMs = IMAGE_REMARK_TIMEOUT_MS,
  onSettled = () => undefined,
  resourceGovernor,
  requireResourceGovernor,
  organizationId,
  jobId,
  env = process.env,
} = {}) {
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
      if (!results[index]?.status) {
        results[index] = { status: "upstream-empty", reason: "上游未返回可用图片备注" };
      }
      completed += 1;
      await onSettled(Object.freeze({
        completed,
        total: items.length,
        status: results[index]?.status ?? "upstream-empty",
      }));
    }
  }));
  return results;
}

export function aggregateImageRemarkResults(results) {
  const statuses = results.map(result => result?.status);
  if (!statuses.length || statuses.every(status => status === "upstream-empty")) return "upstream-empty";
  if (statuses.some(status => status === "timeout")) return "timeout";
  if (statuses.some(status => status === "connector-failed")) return "connector-failed";
  return "ready";
}
