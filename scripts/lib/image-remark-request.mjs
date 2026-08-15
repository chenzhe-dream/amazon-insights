export const DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS = 20_000;

export function imageRemarkRequestTimeoutMs(env = process.env) {
  const configured = Number(env.OPENAI_IMAGE_REQUEST_TIMEOUT_MS);
  return Number.isInteger(configured) && configured >= 1_000 && configured <= 120_000
    ? configured
    : DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS;
}

export async function fetchImageRemarkWithTimeout(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Image remark request timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
