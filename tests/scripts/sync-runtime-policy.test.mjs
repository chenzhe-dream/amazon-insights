import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  shouldBuildAndRestartForSync,
  windowsHiddenChildProcessOptions,
} from "../../scripts/lib/sync-runtime-policy.mjs";

test("local fake sync skips the frontend build and team-server restart", () => {
  assert.equal(shouldBuildAndRestartForSync({ AGENT_VOC_LOCAL_FAKE: "1" }), false);
});

test("ordinary sync keeps the frontend build and team-server restart", () => {
  assert.equal(shouldBuildAndRestartForSync({}), true);
  assert.equal(shouldBuildAndRestartForSync({ AGENT_VOC_LOCAL_FAKE: "0" }), true);
});

test("Windows sync child processes are hidden without changing Linux options", () => {
  assert.deepEqual(windowsHiddenChildProcessOptions("win32"), { windowsHide: true });
  assert.deepEqual(windowsHiddenChildProcessOptions("linux"), {});
});

test("the ASIN runner applies the runtime policy around build and restart", async () => {
  const runner = await readFile(new URL("../../scripts/run-asin-sync-job.mjs", import.meta.url), "utf8");

  assert.match(runner, /if \(shouldBuildAndRestartForSync\(process\.env\)\) \{/);
  assert.match(runner, /await restartTeamServer\(\);/);
  assert.match(runner, /status: "skipped"/);
  assert.match(runner, /\.\.\.windowsHiddenChildProcessOptions\(\)/);
});
