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

test("the ASIN runner builds then writes a controlled reload request without owning Web", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");

  assert.match(runner, /if \(shouldBuildForSync\(process\.env\)\) \{/);
  assert.match(runner, /writeWebReloadRequest\(/);
  assert.match(runner, /status: "skipped"/);
  assert.match(runner, /\.\.\.windowsHiddenChildProcessOptions\(\)/);
  assert.doesNotMatch(runner, new RegExp(["restart", "TeamServer"].join("")));
  assert.doesNotMatch(runner, new RegExp(["start", "team", "server"].join("-") + "\\.ps1"));
  assert.doesNotMatch(runner, /\bspawn\s*\(/);
});
