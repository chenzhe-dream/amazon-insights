import { IMAGE_REMARK_TIMEOUT_MS } from "./image-remark-policy.mjs";

export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const DEFAULT_IMAGE_REMARK_MODEL = "gpt-4o-mini";
export const DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS = IMAGE_REMARK_TIMEOUT_MS;

const imageRemarkFailureStages = new Set([
  "fetch",
  "http-response",
  "response-json",
  "response-output",
  "governance",
]);
const imageRemarkErrorClasses = new Set([
  "network",
  "http",
  "invalid-json",
  "invalid-output",
  "governance",
]);

class ImageRemarkRequestError extends Error {
  constructor(diagnostic) {
    super("Image analysis provider request failed");
    this.name = "ImageRemarkRequestError";
    this.diagnostic = sanitizeImageRemarkFailureDiagnostic(diagnostic);
  }
}

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
    throw new ImageRemarkRequestError({
      stage: "http-response",
      httpStatus: response.status,
      errorClass: "http",
    });
  }
  try {
    return await response.json();
  } catch {
    throw new ImageRemarkRequestError({
      stage: "response-json",
      httpStatus: response.status,
      errorClass: "invalid-json",
    });
  }
}

export function readImageRemarkFailureDiagnostic(error) {
  if (!(error instanceof ImageRemarkRequestError)) return null;
  return sanitizeImageRemarkFailureDiagnostic(error.diagnostic);
}

export async function requestImageRemark({
  fetchImpl = globalThis.fetch,
  endpoint,
  apiKey,
  signal,
  model,
  prompt,
  imageUrl,
}) {
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: imageUrl } },
            ],
          },
        ],
      }),
    });
  } catch {
    throw new ImageRemarkRequestError({
      stage: "fetch",
      httpStatus: null,
      errorClass: "network",
    });
  }

  const payload = await readImageRemarkProviderPayload(response);
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== "string" || !raw.trim()) {
    throw invalidOutputError(response.status);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidOutputError(response.status);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw invalidOutputError(response.status);
  }

  const remark = String(parsed.remark ?? "").trim();
  if (!remark) throw invalidOutputError(response.status);
  return {
    remark,
    image_types: Array.isArray(parsed.image_types) ? parsed.image_types.map(String).slice(0, 3) : [],
    confidence: ["high", "medium", "low"].includes(parsed.confidence) ? parsed.confidence : "medium",
  };
}

export function imageRemarkRequestTimeoutMs() {
  return DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS;
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

function invalidOutputError(httpStatus) {
  return new ImageRemarkRequestError({
    stage: "response-output",
    httpStatus,
    errorClass: "invalid-output",
  });
}

export function sanitizeImageRemarkFailureDiagnostic(input) {
  if (!input || typeof input !== "object" || !imageRemarkFailureStages.has(input.stage) || !imageRemarkErrorClasses.has(input.errorClass)) return null;
  const stage = imageRemarkFailureStages.has(input?.stage) ? input.stage : "fetch";
  const errorClass = imageRemarkErrorClasses.has(input?.errorClass) ? input.errorClass : "network";
  const numericStatus = Number(input?.httpStatus);
  const httpStatus = Number.isInteger(numericStatus) && numericStatus >= 100 && numericStatus <= 599
    ? numericStatus
    : null;
  const safe = { stage, httpStatus, errorClass };
  if (stage === "governance" && errorClass === "governance" && ["rolling-window","concurrency","paused","unavailable","cancelled","missing-key"].includes(input.governanceCategory)) safe.governanceCategory = input.governanceCategory;
  return Object.freeze(safe);
}
