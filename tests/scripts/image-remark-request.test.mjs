import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IMAGE_REMARK_MODEL,
  DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS,
  fetchImageRemarkWithTimeout,
  imageRemarkEndpoint,
  imageRemarkModel,
  imageRemarkRequestTimeoutMs,
  readImageRemarkProviderPayload,
} from "../../scripts/lib/image-remark-request.mjs";

test("image remark requests use a bounded configurable timeout", () => {
  assert.equal(DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS, 120_000);
  assert.equal(imageRemarkRequestTimeoutMs({}), DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS);
  assert.equal(imageRemarkRequestTimeoutMs({ OPENAI_IMAGE_REQUEST_TIMEOUT_MS: "25000" }), 25_000);
  assert.equal(imageRemarkRequestTimeoutMs({ OPENAI_IMAGE_REQUEST_TIMEOUT_MS: "invalid" }), DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS);
});

test("image remark requests abort when the timeout elapses", async () => {
  const pendingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason));
  });

  await assert.rejects(
    fetchImageRemarkWithTimeout(pendingFetch, "https://example.test/image", {}, 1),
    /timed out/i,
  );
});

test("image remark endpoint uses the official default and one relay v1 segment", () => {
  assert.equal(imageRemarkEndpoint({}), "https://api.openai.com/v1/chat/completions");
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/" }),
    "https://relay.example.test/v1/chat/completions",
  );
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/gateway/v1/v1/" }),
    "https://relay.example.test/gateway/v1/chat/completions",
  );
  assert.equal(
    imageRemarkEndpoint({ OPENAI_BASE_URL: "https://relay.example.test/v1//v1" }),
    "https://relay.example.test/v1/chat/completions",
  );
});

test("image remark endpoint rejects unsafe bases without echoing them", () => {
  for (const value of [
    "ftp://relay.example.test/v1",
    "https://user:secret@relay.example.test/v1",
    "https://relay.example.test/v1#secret-fragment",
    "not a url",
  ]) {
    assert.throws(
      () => imageRemarkEndpoint({ OPENAI_BASE_URL: value }),
      error => error instanceof Error && !error.message.includes(value) && !/secret/i.test(error.message),
    );
  }
});

test("image remark model precedence is vision, VOC, then fallback", () => {
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " vision-model ", AGENT_VOC_MODEL: "voc-model" }), "vision-model");
  assert.equal(imageRemarkModel({ OPENAI_VISION_MODEL: " ", AGENT_VOC_MODEL: " voc-model " }), "voc-model");
  assert.equal(imageRemarkModel({}), DEFAULT_IMAGE_REMARK_MODEL);
});

test("provider failures expose only status and invalid-json summaries", async () => {
  await assert.rejects(
    readImageRemarkProviderPayload(new Response("provider secret body", { status: 502 })),
    error => error instanceof Error && /HTTP 502/.test(error.message) && !/provider secret body/.test(error.message),
  );
  await assert.rejects(
    readImageRemarkProviderPayload(new Response("not json", { status: 200 })),
    /^Error: Image analysis provider returned invalid JSON$/,
  );
});
