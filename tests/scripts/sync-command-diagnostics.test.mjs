import assert from "node:assert/strict";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";

test("command diagnostics distinguish spawn errors, signals, and stderr exits", () => {
  assert.equal(typeof runner.formatCommandFailure, "function");

  assert.match(
    runner.formatCommandFailure("catalog:sync", {
      error: Object.assign(new Error("spawn npm ENOENT"), { code: "ENOENT" }),
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
    }),
    /catalog:sync failed \(spawn npm ENOENT\)/,
  );
  assert.match(
    runner.formatCommandFailure("catalog:sync", {
      status: null,
      signal: "SIGTERM",
      stdout: "",
      stderr: "",
    }),
    /catalog:sync failed \(signal SIGTERM\)/,
  );
  assert.match(
    runner.formatCommandFailure("catalog:sync", {
      status: 1,
      signal: null,
      stdout: "less useful stdout",
      stderr: "npm: command not found\nprovider detail",
    }),
    /catalog:sync failed \(exit 1\): npm: command not found provider detail/,
  );
});
