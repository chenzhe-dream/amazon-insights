import assert from "node:assert/strict";
import test from "node:test";

import * as runner from "../../scripts/run-asin-sync-job.mjs";

test("command output sanitizer redacts sensitive env values and common credential forms", () => {
  assert.equal(typeof runner.sanitizeCommandOutput, "function");
  const secret = "environment-secret-sentinel-123";
  const output = [
    `raw=${secret}`,
    "Authorization: Bearer bearer-token-123456",
    "Authorization: Basic basic-token-123456",
    "prefix Authorization: Custom custom-token-123456",
    "secret-key: secret-key-value-123456",
    "api_key=api-key-value-123456",
    "Cookie: session=cookie-value-123456; path=/",
    '{"authorization":"Bearer json-auth-token-123456","access_token":"access-token-123456","refresh_token":"refresh-token-123456"}',
    '{"client_secret":"client-secret-123456","secret-key":"json-secret-key-123456","api_key":"json-api-key-123456"}',
    '{"password":"password-value-123456","credential":"credential-value-123456","token":"plain-token-123456"}',
    "ordinary provider timeout",
  ].join("\n");

  const sanitized = runner.sanitizeCommandOutput(output, {
    SELLERSPRITE_SECRET_KEY: secret,
  });

  assert.doesNotMatch(sanitized, new RegExp(secret));
  assert.doesNotMatch(
    sanitized,
    /bearer-token-123456|basic-token-123456|custom-token-123456|secret-key-value-123456|api-key-value-123456|cookie-value-123456|json-auth-token-123456|access-token-123456|refresh-token-123456|client-secret-123456|json-secret-key-123456|json-api-key-123456|password-value-123456|credential-value-123456|plain-token-123456/,
  );
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
  const longLabelFailure = runner.formatCommandFailure("label".repeat(240), {
    status: 1,
    signal: null,
    stdout: "",
    stderr: "provider timeout remains visible",
  });
  assert.ok(longLabelFailure.length <= 1_000);
  assert.match(longLabelFailure, /failed \(exit 1\).*provider timeout remains visible/);
});
