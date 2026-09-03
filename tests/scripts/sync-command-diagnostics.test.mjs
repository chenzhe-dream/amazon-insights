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

test("database URLs and URI userinfo are redacted without treating ordinary master or session names as secrets", () => {
  const agentDatabaseUrl = "postgresql://agent_user:agent-db-password-456789@db.internal:5432/app";
  const compatibleDatabaseUrl = "postgres://compat_user:compat-db-password-987654@compat.internal:5432/app";
  const sanitizedEnv = runner.sanitizeCommandOutput(
    `agent=${agentDatabaseUrl}\ncompatible=${compatibleDatabaseUrl}\nbranch=feature/master-visible\nmanager=windows-session-manager`,
    {
      AGENT_DATABASE_URL: agentDatabaseUrl,
      DATABASE_URL: compatibleDatabaseUrl,
      MASTER_BRANCH: "feature/master-visible",
      SESSION_MANAGER: "windows-session-manager",
    },
  );

  assert.doesNotMatch(sanitizedEnv, /agent-db-password-456789|compat-db-password-987654/);
  assert.doesNotMatch(sanitizedEnv, new RegExp(agentDatabaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(sanitizedEnv, new RegExp(compatibleDatabaseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(sanitizedEnv, /branch=feature\/master-visible/);
  assert.match(sanitizedEnv, /manager=windows-session-manager/);

  const sanitizedUris = runner.sanitizeCommandOutput([
    "postgres://pg_user:pg-password-123456@pg.internal:5432/app",
    "postgresql://pg2_user:pg2-password-234567@pg2.internal:5432/app",
    "http://proxy_user:proxy-password-345678@proxy.internal:8080/path",
    "https://proxy2_user:proxy2-password-456789@proxy2.internal:8443/path",
  ].join("\n"), {});

  assert.doesNotMatch(sanitizedUris, /pg_user:|pg2_user:|proxy_user:|proxy2_user:|password-[0-9]+/);
  assert.match(sanitizedUris, /postgres:\/\/\[REDACTED\]@pg\.internal:5432\/app/);
  assert.match(sanitizedUris, /postgresql:\/\/\[REDACTED\]@pg2\.internal:5432\/app/);
  assert.match(sanitizedUris, /http:\/\/\[REDACTED\]@proxy\.internal:8080\/path/);
  assert.match(sanitizedUris, /https:\/\/\[REDACTED\]@proxy2\.internal:8443\/path/);
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
