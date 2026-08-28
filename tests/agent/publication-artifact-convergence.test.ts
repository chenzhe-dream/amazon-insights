import assert from "node:assert/strict";
import test from "node:test";

import {
  urlForPublishedArtifact,
  waitForPublishedArtifact,
} from "../../app/lib/publication-artifact-convergence";

test("waits through unavailable health until the exact artifact is ready", async () => {
  const values = [null, "a".repeat(64), "b".repeat(64)];
  const result = await waitForPublishedArtifact({
    currentArtifactId: "a".repeat(64),
    targetArtifactId: "b".repeat(64),
    probe: async () => values.shift() ?? null,
    wait: async () => undefined,
    maxAttempts: 3,
  });
  assert.equal(result, "ready");
});

test("cache-busted artifact URL preserves canonical identities", () => {
  const url = new URL(urlForPublishedArtifact(
    "http://host/p/ai-us-3?run=run-1&syncJob=job-1&tab=overview-images",
    "b".repeat(64),
  ));
  assert.equal(url.searchParams.get("run"), "run-1");
  assert.equal(url.searchParams.get("syncJob"), "job-1");
  assert.equal(url.searchParams.get("tab"), "overview-images");
  assert.equal(url.searchParams.get("webArtifact"), "b".repeat(64));
});

test("skips probes when the loaded artifact is already current", async () => {
  let probes = 0;
  const result = await waitForPublishedArtifact({
    currentArtifactId: "b".repeat(64),
    targetArtifactId: "b".repeat(64),
    probe: async () => {
      probes += 1;
      return null;
    },
    wait: async () => undefined,
  });
  assert.equal(result, "already-current");
  assert.equal(probes, 0);
});

test("times out after exactly the default bounded number of probes", async () => {
  let probes = 0;
  const result = await waitForPublishedArtifact({
    currentArtifactId: "a".repeat(64),
    targetArtifactId: "b".repeat(64),
    probe: async () => {
      probes += 1;
      return null;
    },
    wait: async () => undefined,
  });
  assert.equal(result, "timeout");
  assert.equal(probes, 30);
});
