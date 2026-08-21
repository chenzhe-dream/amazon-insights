export const IMAGE_REMARK_CONCURRENCY = 2;
export const IMAGE_REMARK_TIMEOUT_MS = 90_000;

function timeoutResult() {
  return { status: "timeout", reason: "图片分析超过 90 秒" };
}

function failureResult() {
  return { status: "connector-failed", reason: "图片分析连接器失败" };
}

async function runOne(item, worker, timeoutMs) {
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      Promise.resolve().then(() => worker(item, { signal: controller.signal })),
      new Promise(resolve => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(timeoutResult());
        }, timeoutMs);
      }),
    ]);
  } catch {
    return failureResult();
  } finally {
    clearTimeout(timeout);
  }
}

export async function runImageRemarkQueue(items, worker, {
  concurrency = IMAGE_REMARK_CONCURRENCY,
  timeoutMs = IMAGE_REMARK_TIMEOUT_MS,
} = {}) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      const result = await runOne(items[index], worker, timeoutMs);
      results[index] = result?.status ? result : { status: "upstream-empty", reason: "上游未返回可用图片备注" };
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
