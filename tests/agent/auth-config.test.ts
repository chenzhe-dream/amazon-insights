import assert from "node:assert/strict";
import test from "node:test";

import { loadAgentAuthenticationConfig } from "../../server/config";

const loopback = {
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
};

const privateLan = {
  NODE_ENV: "development",
  WEB_HOST: "0.0.0.0",
  WEB_PORT: "31900",
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_PORT: "31901",
  AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31901",
  AGENT_SERVICE_PROXY_TOKEN: "private-lan-proxy-token-sentinel",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900",
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "0",
  AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0",
  AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "1",
};

const assignedLanInterfaces = () => ({
  Ethernet: [{
    address: "192.168.1.109",
    netmask: "255.255.255.0",
    family: "IPv4" as const,
    mac: "00:00:00:00:00:01",
    internal: false,
    cidr: "192.168.1.109/24",
  }],
});

function assignedPrivateInterface(address: string) {
  return () => ({
    Ethernet: [{
      address,
      netmask: "255.255.255.0",
      family: "IPv4" as const,
      mac: "00:00:00:00:00:01",
      internal: false,
      cidr: `${address}/24`,
    }],
  });
}

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

test("agent authentication accepts the exact private-LAN development matrix", () => {
  const config = loadAgentAuthenticationConfig(
    privateLan,
    assignedLanInterfaces,
  );
  assert.equal(config.mode, "authenticated");
  assert.deepEqual(config.cookie, {
    name: "agent_session",
    secure: false,
    maxAgeSeconds: 28_800,
  });
});

test("agent authentication accepts explicit loopback origins beside the exact LAN origin", () => {
  for (const loopbackOrigin of [
    "http://localhost:31900",
    "http://127.0.0.1:31900",
    "http://[::1]:31900",
  ]) {
    const config = loadAgentAuthenticationConfig(
      {
        ...privateLan,
        AGENT_SERVICE_TRUSTED_ORIGINS:
          `${privateLan.AGENT_SERVICE_TRUSTED_ORIGINS},${loopbackOrigin}`,
      },
      assignedLanInterfaces,
    );
    assert.equal(config.cookie.name, "agent_session");
    assert.equal(config.cookie.secure, false);
  }
});

test("agent authentication accepts matching 10/8 and 172.16/12 assigned LAN origins", () => {
  for (const address of ["10.0.0.8", "172.16.0.8"]) {
    const config = loadAgentAuthenticationConfig(
      {
        ...privateLan,
        WEB_HOST: address,
        AGENT_SERVICE_TRUSTED_ORIGINS: `http://${address}:31900`,
      },
      assignedPrivateInterface(address),
    );
    assert.equal(config.cookie.name, "agent_session");
    assert.equal(config.cookie.secure, false);
  }
});

test("agent authentication rejects unsafe private-LAN cookie matrices", () => {
  const invalid = [
    { ...privateLan, NODE_ENV: "production" },
    { ...privateLan, AGENT_SERVICE_HOST: "0.0.0.0" },
    { ...privateLan, AGENT_SERVICE_HOST: "192.168.1.109" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "http://192.168.1.109:31901" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "https://127.0.0.1:31901" },
    { ...privateLan, AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:31902" },
    { ...privateLan, AGENT_SERVICE_PROXY_TOKEN: "" },
    { ...privateLan, WEB_HOST: "203.0.113.9" },
    { ...privateLan, WEB_HOST: "192.168.1.110" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "https://192.168.1.109:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://203.0.113.9:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://lan-host:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://*.example:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://user:pass@192.168.1.109:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900/path" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900?query=1" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:31900#fragment" },
    {
      ...privateLan,
      AGENT_SERVICE_TRUSTED_ORIGINS:
        "http://192.168.1.109:31900,http://203.0.113.9:31900",
    },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://172.15.255.255:31900" },
    { ...privateLan, AGENT_SERVICE_TRUSTED_ORIGINS: "http://172.32.0.0:31900" },
    { ...privateLan, AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1" },
    { ...privateLan, AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1" },
    { ...privateLan, AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "yes" },
  ];

  for (const env of invalid) {
    assert.throws(
      () => loadAgentAuthenticationConfig(env, assignedLanInterfaces),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Agent authentication configuration is invalid",
        );
        assert.doesNotMatch(
          error.message,
          /private-lan-proxy-token-sentinel|192\.168\.1\.109|AGENT_DATABASE_URL/,
        );
        return true;
      },
    );
  }
});
