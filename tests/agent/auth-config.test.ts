import assert from "node:assert/strict";
import test from "node:test";

import {
  loadAgentAuthenticationConfig,
  loadDingTalkAuthenticationConfig,
} from "../../server/config";

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
    {
      ...privateLan,
      WEB_PORT: undefined,
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:3001",
    },
    {
      ...privateLan,
      WEB_PORT: undefined,
      PORT: "31900",
    },
    {
      ...privateLan,
      AGENT_SERVICE_PORT: undefined,
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:3100",
    },
    {
      ...privateLan,
      WEB_PORT: "3001",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:3001",
    },
    {
      ...privateLan,
      AGENT_SERVICE_PORT: "3100",
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:3100",
    },
    {
      ...privateLan,
      WEB_PORT: "4567",
      AGENT_SERVICE_TRUSTED_ORIGINS: "http://192.168.1.109:4567",
    },
    {
      ...privateLan,
      AGENT_SERVICE_PORT: "4568",
      AGENT_SERVICE_INTERNAL_URL: "http://127.0.0.1:4568",
    },
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

test("agent authentication safely rejects failed or malformed interface reads", () => {
  const invalidReaders = [
    () => {
      throw new Error("network-interface-reader-sentinel");
    },
    () => null as never,
    () => ({ Ethernet: [null] }) as never,
  ];

  for (const readNetworkInterfaces of invalidReaders) {
    assert.throws(
      () => loadAgentAuthenticationConfig(privateLan, readNetworkInterfaces),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Agent authentication configuration is invalid",
        );
        assert.doesNotMatch(
          error.message,
          /network-interface-reader-sentinel|private-lan-proxy-token-sentinel/,
        );
        return true;
      },
    );
  }
});

const completeDingTalkEnv = {
  NODE_ENV: "development",
  DINGTALK_ENABLED: "1",
  DINGTALK_CLIENT_ID: "ding-client-id",
  DINGTALK_CLIENT_SECRET: "ding-client-secret-sentinel",
  DINGTALK_CORP_ID: "ding-corp-id",
  DINGTALK_AGENT_ID: "ding-agent-id",
  DINGTALK_LOCAL_ORGANIZATION_ID: "20000000-0000-4000-8000-000000000001",
  DINGTALK_REDIRECT_URI:
    "http://127.0.0.1:31900/api/auth/dingtalk/callback",
  AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1",
};

test("DingTalk authentication defaults off and accepts one complete development application", () => {
  assert.deepEqual(loadDingTalkAuthenticationConfig({}), { enabled: false });
  assert.deepEqual(loadDingTalkAuthenticationConfig({ DINGTALK_ENABLED: "0" }), {
    enabled: false,
  });

  const config = loadDingTalkAuthenticationConfig(completeDingTalkEnv);
  assert.equal(config.enabled, true);
  if (!config.enabled) return;
  assert.equal(config.clientId, "ding-client-id");
  assert.equal(config.clientSecret, "ding-client-secret-sentinel");
  assert.equal(config.corpId, "ding-corp-id");
  assert.equal(config.agentId, "ding-agent-id");
  assert.equal(
    config.localOrganizationId,
    "20000000-0000-4000-8000-000000000001",
  );
  assert.equal(
    config.redirectUri,
    "http://127.0.0.1:31900/api/auth/dingtalk/callback",
  );
  assert.equal(config.oauthStateTtlMs, 300_000);

  const privateNetworkConfig = loadDingTalkAuthenticationConfig({
    ...completeDingTalkEnv,
    NODE_ENV: undefined,
    AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0",
    AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE: "1",
  });
  assert.equal(privateNetworkConfig.enabled, true);
});

test("DingTalk authentication rejects partial, unsafe, and secret-bearing invalid configuration", () => {
  const invalid = [
    { DINGTALK_ENABLED: "1" },
    { ...completeDingTalkEnv, DINGTALK_CLIENT_ID: "" },
    { ...completeDingTalkEnv, DINGTALK_LOCAL_ORGANIZATION_ID: "not-a-uuid" },
    { ...completeDingTalkEnv, DINGTALK_REDIRECT_URI: "ftp://example.com/callback" },
    { ...completeDingTalkEnv, DINGTALK_REDIRECT_URI: "https://user:pass@example.com/callback" },
    { ...completeDingTalkEnv, DINGTALK_REDIRECT_URI: "https://example.com/callback#fragment" },
    { ...completeDingTalkEnv, NODE_ENV: "production" },
    { ...completeDingTalkEnv, AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "0" },
    { ...completeDingTalkEnv, DINGTALK_ENABLED: "true" },
  ];

  for (const env of invalid) {
    assert.throws(
      () => loadDingTalkAuthenticationConfig(env),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /DingTalk authentication configuration is (?:incomplete|invalid)/);
        assert.doesNotMatch(error.message, /ding-client-secret-sentinel/);
        return true;
      },
    );
  }
});
