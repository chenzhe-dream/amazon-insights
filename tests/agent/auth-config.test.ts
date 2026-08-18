import assert from "node:assert/strict";
import test from "node:test";

import { loadAgentAuthenticationConfig } from "../../server/config";

const loopback = {
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
};

test("agent authentication defaults to authenticated secure mode", () => {
  const config = loadAgentAuthenticationConfig(loopback);

  assert.equal(config.mode, "authenticated");
  assert.deepEqual(config.cookie, {
    name: "__Host-agent_session",
    secure: true,
    maxAgeSeconds: 28_800,
  });
  assert.equal(config.sessionTtlMs, 28_800_000);
  assert.deepEqual(config.loginLimiter, {
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  });
});

test("agent authentication accepts each loopback-only compatibility flag independently", () => {
  assert.equal(
    loadAgentAuthenticationConfig({
      ...loopback,
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    }).mode,
    "anonymous-loopback",
  );

  const insecureOnly = loadAgentAuthenticationConfig({
    ...loopback,
    AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1",
  });
  assert.equal(insecureOnly.mode, "authenticated");
  assert.deepEqual(insecureOnly.cookie, {
    name: "agent_session",
    secure: false,
    maxAgeSeconds: 28_800,
  });
});

test("agent authentication rejects loopback-only compatibility flags outside a closed local matrix", () => {
  const invalidEnvironments = [
    {
      ...loopback,
      NODE_ENV: "production",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      AGENT_SERVICE_HOST: "0.0.0.0",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      AGENT_SERVICE_HOST: "192.168.1.20",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      AGENT_SERVICE_HOST: "203.0.113.10",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_TRUSTED_ORIGINS: "",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_TRUSTED_ORIGINS:
        "http://127.0.0.1:31900,https://example.com",
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    },
    {
      ...loopback,
      AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "yes",
    },
    {
      ...loopback,
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "true",
    },
  ];

  for (const env of invalidEnvironments) {
    assert.throws(
      () => loadAgentAuthenticationConfig(env),
      /Agent authentication configuration is invalid/,
    );
  }
});

test("agent authentication treats explicit zero flags as secure authenticated mode", () => {
  const config = loadAgentAuthenticationConfig({
    ...loopback,
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "0",
    AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0",
  });

  assert.equal(config.mode, "authenticated");
  assert.equal(config.cookie.name, "__Host-agent_session");
  assert.equal(config.cookie.secure, true);
});

test("agent authentication ignores the old misspelled insecure cookie flag", () => {
  const config = loadAgentAuthenticationConfig({
    ...loopback,
    AGENT_AUTH_ALLOW_INSECURE_COOKIE_LOOPBACK: "1",
  });

  assert.equal(config.mode, "authenticated");
  assert.equal(config.cookie.name, "__Host-agent_session");
  assert.equal(config.cookie.secure, true);
});
