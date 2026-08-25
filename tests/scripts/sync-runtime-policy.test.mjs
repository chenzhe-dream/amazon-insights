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

test("the ASIN runner publishes build, manifest, request, then mirror in that order without owning Web", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const buildBranchStart = runner.indexOf('if (shouldRunSyncStage(job, "build") && shouldBuildForSync(process.env)) {');
  const buildBranchEnd = runner.indexOf('} else if (shouldRunSyncStage(job, "build")) {', buildBranchStart);
  const buildBranch = runner.slice(buildBranchStart, buildBranchEnd);
  const orderedSteps = [
    "const artifactId = createWebPublicationArtifactId();",
    'runCommand("build", "npm", ["run", "build"]);',
    "await writeCurrentWebArtifact({ worktree: root, artifactId });",
    'completeStage(jobId, "build");',
    "const requestedAt = new Date().toISOString();",
    "const request = await writeWebReloadRequest({",
    "patchSyncJob(jobId, {",
  ];

  assert.notEqual(buildBranchStart, -1);
  assert.notEqual(buildBranchEnd, -1);
  let previousIndex = -1;
  for (const step of orderedSteps) {
    const index = buildBranch.indexOf(step, previousIndex + 1);
    assert.ok(index > previousIndex, `${step} must follow the previous publication step`);
    previousIndex = index;
  }
  assert.match(buildBranch, /writeWebReloadRequest\(\{\s*jobId,\s*artifactId,\s*buildCompletedAt: requestedAt,\s*target,/s);
  assert.match(buildBranch, /publication:\s*\{\s*generation:\s*Number\(readSyncJob\(jobId\)\?\.publication\?\.generation \?\? 0\) \+ 1,\s*requestId: request\.id,\s*artifactId,\s*requestedAt,\s*\}/s);
  assert.match(runner, /status: "skipped"/);
  assert.match(runner, /\.\.\.windowsHiddenChildProcessOptions\(\)/);
  assert.doesNotMatch(runner, new RegExp(["restart", "TeamServer"].join("")));
  assert.doesNotMatch(runner, new RegExp(["start", "team", "server"].join("-") + "\\.ps1"));
  assert.doesNotMatch(runner, /\bspawn\s*\(/);
});

test("a failed ASIN runner build cannot create a manifest, request, or publication mirror", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");
  const buildBranchStart = runner.indexOf('if (shouldRunSyncStage(job, "build") && shouldBuildForSync(process.env)) {');
  const buildBranchEnd = runner.indexOf('} else if (shouldRunSyncStage(job, "build")) {', buildBranchStart);
  const buildBranch = runner.slice(buildBranchStart, buildBranchEnd);
  const build = buildBranch.indexOf('runCommand("build", "npm", ["run", "build"]);');
  const manifest = buildBranch.indexOf("await writeCurrentWebArtifact({ worktree: root, artifactId });");
  const request = buildBranch.indexOf("const request = await writeWebReloadRequest({");
  const publication = buildBranch.indexOf("publication:");

  assert.ok(build >= 0 && build < manifest, "the throwing build gate must precede manifest publication");
  assert.ok(manifest < request, "a request cannot be written before its manifest");
  assert.ok(request < publication, "the mirror cannot reference a request that was not written");
});
