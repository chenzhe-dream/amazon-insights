export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_REMARK_MODEL = "gpt-4o-mini";
export const DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS = 120_000;

export function imageRemarkEndpoint(env = process.env) {
  const configured = env.OPENAI_BASE_URL?.trim() || DEFAULT_OPENAI_BASE_URL;
  let base;
  try {
    base = new URL(configured);
  } catch {
    throw new Error("OPENAI_BASE_URL is invalid");
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    throw new Error("OPENAI_BASE_URL must use HTTP or HTTPS");
  }
  if (base.username || base.password) {
    throw new Error("OPENAI_BASE_URL must not contain credentials");
  }
  if (base.hash) {
    throw new Error("OPENAI_BASE_URL must not contain a fragment");
  }

  base.search = "";
  const prefix = base.pathname
    .replace(/\/{2,}/g, "/")
    .replace(/\/+$/, "")
    .replace(/(?:\/v1)+$/i, "");
  base.pathname = `${prefix}/v1/chat/completions`;
  return base.toString();
}

export function imageRemarkModel(env = process.env) {
  return env.OPENAI_VISION_MODEL?.trim() || env.AGENT_VOC_MODEL?.trim() || DEFAULT_IMAGE_REMARK_MODEL;
}

export async function readImageRemarkProviderPayload(response) {
  if (!response.ok) {
    throw new Error(`Image analysis provider returned HTTP ${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error("Image analysis provider returned invalid JSON");
  }
}

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
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    return await fetchImpl(url, { ...init, signal });
  } finally {
    clearTimeout(timer);
  }
}
