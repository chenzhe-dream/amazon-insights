import assert from "node:assert/strict";
import test from "node:test";

import { coordinateAlexaCapturePublication } from "../../scripts/lib/alexa-capture-publication.mjs";

test("a slow capture finishes writing before publication is requested", async () => {
  const events = [];
  let releaseCapture;
  const captureReady = new Promise((resolve) => { releaseCapture = resolve; });
  const coordinated = coordinateAlexaCapturePublication({
    publishAfterCapture: true,
    capture: async () => {
      events.push("capture-started");
      await captureReady;
      events.push("capture-written");
      return { okCount: 1, total: 1 };
    },
    publish: () => {
      events.push("publication-requested");
      return { started: true };
    },
  });
  await Promise.resolve();
  assert.deepEqual(events, ["capture-started"]);
  releaseCapture();
  const result = await coordinated;
  assert.deepEqual(events, ["capture-started", "capture-written", "publication-requested"]);
  assert.deepEqual(result.publication, { started: true });
});

test("capture coordinator does not publish when no report was written", async () => {
  let publications = 0;
  const result = await coordinateAlexaCapturePublication({
    publishAfterCapture: true,
    capture: async () => ({ okCount: 0, total: 1 }),
    publish: () => { publications += 1; },
  });
  assert.equal(publications, 0);
  assert.equal(result.publication, null);
});
