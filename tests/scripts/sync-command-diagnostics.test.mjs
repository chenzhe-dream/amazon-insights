import assert from "node:assert/strict";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";

test("command output sanitizer redacts sensitive env values and common credential forms", () => {
  assert.equal(typeof runner.sanitizeCommandOutput, "function");
  const secret = "environment-secret-sentinel-123";
  const output = [
    `raw=${secret}`,
    "Authorization: Bearer bearer-token-123456",
    "secret-key: secret-key-value-123456",
    "api_key=api-key-value-123456",
    "Cookie: session=cookie-value-123456; path=/",
    "ordinary provider timeout",
  ].join("\n");

  const sanitized = runner.sanitizeCommandOutput(output, {
    SELLERSPRITE_SECRET_KEY: secret,
  });

  assert.doesNotMatch(sanitized, new RegExp(secret));
  assert.doesNotMatch(sanitized, /bearer-token-123456|secret-key-value-123456|api-key-value-123456|cookie-value-123456/);
  assert.match(sanitized, /\[REDACTED\]/);
  assert.match(sanitized, /ordinary provider timeout/);
});

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
  assert.ok(
    runner.formatCommandFailure("catalog:sync", {
      status: 1,
      signal: null,
      stdout: "",
      stderr: `provider timeout ${"x".repeat(2_000)}`,
    }).length <= 1_000,
  );
  assert.ok(
    runner.formatCommandFailure("catalog:sync", {
      error: new Error(`spawn failed ${"y".repeat(2_000)}`),
      status: null,
      signal: null,
      stdout: "",
      stderr: "",
    }).length <= 1_000,
  );
});
