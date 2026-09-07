import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { probeAgentReadiness } from "../../app/api/health/route";
import { webArtifactId } from "../../app/lib/web-artifact-id";

const ARTIFACT_ID = "a".repeat(64);

test("Web health exposes the running code artifact identity without arbitrary environment text", async () => {
  const codeRelease = { sourceCommit: "b".repeat(40), sourceHash: "c".repeat(64), baseArtifactId: ARTIFACT_ID };
  const env = { WEB_CODE_SOURCE_COMMIT: codeRelease.sourceCommit, WEB_CODE_SOURCE_HASH: codeRelease.sourceHash, WEB_CODE_BASE_ARTIFACT_ID: codeRelease.baseArtifactId };
  assert.deepEqual((await (await probeAgentReadiness({ env })).json()).codeRelease, codeRelease);
  assert.equal("codeRelease" in await (await probeAgentReadiness({ env: { ...env, WEB_CODE_SOURCE_HASH: "secret garbage" } })).json(), false);
});

function readyReadiness() {
  return {
    schemaVersion: "1.0.0",
    readiness: { storage: true, openai: true },
  };
}

function healthEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    AGENT_SERVICE_INTERNAL_URL: "http://10.0.0.8:3100",
    AGENT_SERVICE_PROXY_TOKEN: "test-only-proxy-token",
    ...overrides,
  };
}

async function responseText(response: Response) {
  return await response.clone().text();
}

test("Web health returns ok when the Agent Service readiness probe succeeds", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv({ WEB_PUBLICATION_ARTIFACT_ID: ARTIFACT_ID }),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async (input, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(String(input), "http://10.0.0.8:3100/v1/readiness");
      assert.equal(headers.get("origin"), "https://web.example");
      assert.equal(
        headers.get("x-agent-proxy-token"),
        "test-only-proxy-token",
      );
      return Response.json(readyReadiness());
    },
    timeoutMs: 2_000,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "web",
    agent: "ok",
    artifactId: ARTIFACT_ID,
  });
});

test("Web health returns generic degraded when the internal token is rejected", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () =>
      Response.json(
        {
          error: {
            code: "AUTHENTICATION_REQUIRED",
            message: "bad token test-only-proxy-token for http://10.0.0.8:3100",
          },
        },
        { status: 401 },
      ),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /10\.0\.0\.8|3100|test-only-proxy-token|bad token/i);
});

test("Web health returns generic degraded when the trusted origin is rejected", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () =>
      Response.json(
        {
          error: {
            code: "FORBIDDEN",
            message: "origin https://web.example is not trusted",
          },
        },
        { status: 403 },
      ),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /web\.example|FORBIDDEN|origin/i);
});

test("Web health returns generic degraded when required runtime capabilities are unavailable", async () => {
  const degradedReadiness = readyReadiness();
  degradedReadiness.readiness.openai = false;

  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => Response.json(degradedReadiness),
    timeoutMs: 2_000,
  });
  const body = await responseText(response);

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /10\.0\.0\.8|test-only-proxy-token/i);
});

test("Web health rejects readiness payloads with undeclared fields", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => Response.json({
      ...readyReadiness(),
      connectorState: { sif: "configured" },
    }),
    timeoutMs: 2_000,
  });

  assert.equal(response.status, 503);
});

test("Web health returns a generic degraded response without leaking the Agent URL", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv(),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => {
      throw new Error("connect ECONNREFUSED http://10.0.0.8:3100");
    },
    timeoutMs: 2_000,
  });
  const body = await response.text();

  assert.equal(response.status, 503);
  assert.match(body, /degraded/);
  assert.doesNotMatch(body, /10\.0\.0\.8|3100|ECONNREFUSED/i);
});

test("Web health exposes the same strict nonsecret artifact identity when degraded", async () => {
  const response = await probeAgentReadiness({
    env: healthEnv({ WEB_PUBLICATION_ARTIFACT_ID: ARTIFACT_ID }),
    requestUrl: "https://web.example/api/health",
    fetchImplementation: async () => {
      throw new Error("unavailable");
    },
  });

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    status: "degraded",
    service: "web",
    agent: "degraded",
    artifactId: ARTIFACT_ID,
  });
});

test("the shared Web artifact validator accepts only an exact lowercase sha256 identity", () => {
  assert.equal(webArtifactId({ WEB_PUBLICATION_ARTIFACT_ID: ARTIFACT_ID }), ARTIFACT_ID);
  assert.equal(webArtifactId({ WEB_PUBLICATION_ARTIFACT_ID: ` ${ARTIFACT_ID} ` }), ARTIFACT_ID);
  assert.equal(webArtifactId({ WEB_PUBLICATION_ARTIFACT_ID: ARTIFACT_ID.toUpperCase() }), "legacy");
  assert.equal(webArtifactId({ WEB_PUBLICATION_ARTIFACT_ID: `${ARTIFACT_ID}secret` }), "legacy");
  assert.equal(webArtifactId({ WEB_PUBLICATION_ARTIFACT_ID: "secret-token" }), "legacy");
});

test("root layout uses the shared artifact validator without defining another identity regex", async () => {
  const layout = await readFile(new URL("../../app/layout.tsx", import.meta.url), "utf8");

  assert.match(layout, /import \{ webArtifactId \} from "\.\/lib\/web-artifact-id";/);
  assert.match(layout, /const artifactId = webArtifactId\(process\.env\);/);
  assert.match(layout, /<html lang="zh-CN" data-web-artifact-id=\{artifactId\}>/);
  assert.doesNotMatch(layout, /\[a-f0-9\]\{64\}/);
});
