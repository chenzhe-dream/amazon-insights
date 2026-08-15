import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_IMAGE_REMARK_REQUEST_TIMEOUT_MS,
  fetchImageRemarkWithTimeout,
  imageRemarkRequestTimeoutMs,
} from "../../scripts/lib/image-remark-request.mjs";

test("image remark requests use a bounded configurable timeout", () => {
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
