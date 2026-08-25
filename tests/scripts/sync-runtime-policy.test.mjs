import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  shouldBuildForSync,
  windowsHiddenChildProcessOptions,
} from "../../scripts/lib/sync-runtime-policy.mjs";

test("local fake sync skips the frontend build", () => {
  assert.equal(shouldBuildForSync({ AGENT_VOC_LOCAL_FAKE: "1" }), false);
});

test("ordinary sync keeps the frontend build", () => {
  assert.equal(shouldBuildForSync({}), true);
  assert.equal(shouldBuildForSync({ AGENT_VOC_LOCAL_FAKE: "0" }), true);
});

test("Windows sync child processes are hidden without changing Linux options", () => {
  assert.deepEqual(windowsHiddenChildProcessOptions("win32"), { windowsHide: true });
  assert.deepEqual(windowsHiddenChildProcessOptions("linux"), {});
});

test("the ASIN runner publishes build, manifest, request, then mirror in behavior", async () => {
  const { publishWebBuild } = await import("../../scripts/run-asin-sync-job.mjs");
  const artifactId = "a".repeat(64);
  const requestedAt = "2026-08-25T10:00:00.000Z";
  const target = { worktreeId: "b".repeat(64), webHost: "127.0.0.1", webPort: 3001 };
  const contentHash = "d".repeat(64);
  const finalJob = {
    jobId: "job-1",
    jobVersion: 9,
    asins: ["B0TEST0001"],
    stages: [{ id: "keywords", status: "done" }],
    outputs: [{ stage: "keywords", stageStatus: "done", contentHash, updatedAt: requestedAt }],
    persistedStageContentHashes: { keywords: contentHash },
    publication: { generation: 2 },
  };
  const events = [];
  let publication = null;

  await publishWebBuild("job-1", {
    worktree: "isolated-worktree",
    spoolDir: "isolated-spool",
    createArtifactId: () => {
      events.push("artifact");
      return artifactId;
    },
    build: () => events.push("build"),
    writeManifest: async (input) => {
      events.push("manifest");
      assert.deepEqual(input, {
        worktree: "isolated-worktree", artifactId, jobId: "job-1", jobVersion: 9,
        stageContentHashes: { keywords: contentHash },
      });
    },
    completeBuildStage: (jobId) => {
      events.push("complete");
      assert.equal(jobId, "job-1");
    },
    now: () => requestedAt,
    configuredTarget: () => {
      events.push("target");
      return target;
    },
    writeReloadRequest: async (payload, options) => {
      events.push("request");
      assert.deepEqual(payload, {
        jobId: "job-1", jobVersion: 9, artifactId,
        stageContentHashes: { keywords: contentHash }, buildCompletedAt: requestedAt, target,
      });
      assert.deepEqual(options, { spoolDir: "isolated-spool" });
      return { id: "c".repeat(64) };
    },
    readJob: () => finalJob,
    projectOutput: () => ({ contentHash }),
    patchJob: (_jobId, patch) => {
      events.push("mirror");
      publication = patch.publication;
    },
  });

  assert.deepEqual(events, ["artifact", "build", "manifest", "complete", "target", "request", "mirror"]);
  assert.deepEqual(publication, {
    generation: 3,
    requestId: "c".repeat(64),
    artifactId,
    jobVersion: 9,
    stageContentHashes: { keywords: contentHash },
    requestedAt,
  });
});

test("a failed ASIN runner build propagates to the existing failure transition with zero publication writes", async () => {
  const { publishWebBuild } = await import("../../scripts/run-asin-sync-job.mjs");
  const buildFailure = new Error("isolated build failure");
  const writes = { manifest: 0, request: 0, mirror: 0 };
  const contentHash = "d".repeat(64);

  await assert.rejects(
    () => publishWebBuild("job-1", {
      createArtifactId: () => "a".repeat(64),
      readJob: () => ({
        jobId: "job-1", jobVersion: 9, asins: ["B0TEST0001"],
        stages: [{ id: "keywords", status: "done" }],
        outputs: [{ stage: "keywords", stageStatus: "done", contentHash }],
        persistedStageContentHashes: { keywords: contentHash },
      }),
      projectOutput: () => ({ contentHash }),
      build: () => {
        throw buildFailure;
      },
      writeManifest: async () => {
        writes.manifest += 1;
      },
      writeReloadRequest: async () => {
        writes.request += 1;
        return { id: "b".repeat(64) };
      },
      patchJob: () => {
        writes.mirror += 1;
      },
    }),
    (error) => error === buildFailure,
  );

  assert.deepEqual(writes, { manifest: 0, request: 0, mirror: 0 });
});

test("the ASIN runner does not own the Web process", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");

  assert.match(runner, /status: "skipped"/);
  assert.match(runner, /\.\.\.windowsHiddenChildProcessOptions\(\)/);
  assert.doesNotMatch(runner, new RegExp(["restart", "TeamServer"].join("")));
  assert.doesNotMatch(runner, new RegExp(["start", "team", "server"].join("-") + "\\.ps1"));
  assert.doesNotMatch(runner, /\bspawn\s*\(/);
});
