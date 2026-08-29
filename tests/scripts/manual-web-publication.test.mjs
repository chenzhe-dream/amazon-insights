import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  manualWebPublicationDescriptor,
  publishManualWebUpdate,
} from "../../scripts/lib/manual-web-publication.mjs";

test("manual publication identity binds the exact Alexa projection", () => {
  const artifactId = "a".repeat(64);
  const descriptor = manualWebPublicationDescriptor({ artifactId, source: "exact-voc-source" });

  assert.equal(descriptor.jobId, `manual-alexa-voc-${artifactId.slice(0, 32)}`);
  assert.equal(descriptor.jobVersion, 1);
  assert.deepEqual(descriptor.stageContentHashes, {
    alexa_voc: createHash("sha256").update("exact-voc-source").digest("hex"),
  });
});

test("manual publication writes reload only after immutable artifact succeeds", async () => {
  const calls = [];

  const result = await publishManualWebUpdate({
    worktree: "C:/safe-worktree",
    env: { WEB_HOST: "0.0.0.0", WEB_PORT: "31900" },
    build: async () => { calls.push("build"); },
    readSource: async () => "voc-source",
    createArtifactId: () => "b".repeat(64),
    publishArtifact: async (input) => {
      calls.push("artifact");
      await input.build();
      return { id: input.artifactId };
    },
    writeReloadRequest: async (input) => {
      calls.push("reload");
      return { id: "c".repeat(64), payload: input };
    },
  });

  assert.deepEqual(calls, ["artifact", "build", "reload"]);
  assert.equal(result.artifactId, "b".repeat(64));
  assert.equal(result.reloadRequestId, "c".repeat(64));
});
