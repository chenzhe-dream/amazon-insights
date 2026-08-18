import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentServiceClient,
  type AgentServiceClient,
} from "../../app/lib/agent-service-client";
import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { ApiErrorResponseSchema } from "../../shared/agent-contracts";

const internalUrl = "http://10.0.0.8:3100";
const proxyToken = "super-secret-proxy-token";

const capabilityResponse = {
  schemaVersion: "1.0.0",
  capabilities: {
    storage: { configured: true, available: true, reason: null },
    openai: { configured: true, available: true, reason: null },
    sif: { configured: true, available: true, reason: null, checkedAt: null },
    sorftime: { configured: true, available: true, reason: null, checkedAt: null },
    sellerSprite: { configured: true, available: true, reason: null, checkedAt: null },
    manualVoc: { configured: true, available: true, reason: null },
  },
};

const loginResponse = {
  user: {
    id: "10000000-0000-4000-8000-000000000001",
    organizationId: "10000000-0000-4000-8000-000000000002",
    email: "member@example.com",
    displayName: "Member",
    role: "member",
    status: "active",
    createdAt: "2026-08-14T08:00:00.000Z",
    updatedAt: "2026-08-14T08:00:00.000Z",
  },
};

const uuidV4Pattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type FetchImplementation = typeof fetch;

function makeClient(
  fetchImplementation: FetchImplementation,
  options: { timeoutMs?: number; maxResponseBytes?: number } = {},
) {
  return createAgentServiceClient({
    env: {
      AGENT_SERVICE_INTERNAL_URL: internalUrl,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    fetchImplementation,
    ...options,
  });
}

async function callProxy({
  method = "GET",
  path,
  client,
  headers,
  body,
}: {
  method?: string;
  path: string[];
  client: AgentServiceClient;
  headers?: HeadersInit;
  body?: string;
}) {
  return proxyAgentRequest(
    new Request(`https://web.example/api/agent/${path.join("/")}`, {
      method,
      headers,
      body,
    }),
    { params: Promise.resolve({ path }) },
    client,
  );
}

test("the same-origin proxy returns JSON while keeping internal configuration private", async () => {
  let upstreamUrl = "";
  let upstreamHeaders = new Headers();
  const client = makeClient(async (input, init) => {
    upstreamUrl = String(input);
    upstreamHeaders = new Headers(init?.headers);
    return new Response(JSON.stringify(capabilityResponse), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-internal-base-url": internalUrl,
      },
    });
  });

  const response = await callProxy({
    path: ["v1", "capabilities"],
    client,
  });
  const serialized = JSON.stringify({
    body: await response.text(),
    headers: Object.fromEntries(response.headers),
  });

  assert.equal(response.status, 200);
  assert.equal(upstreamUrl, `${internalUrl}/v1/capabilities`);
  assert.equal(upstreamHeaders.get("x-agent-proxy-token"), proxyToken);
  assert.doesNotMatch(serialized, /10\.0\.0\.8|super-secret-proxy-token/);
  assert.equal(response.headers.get("x-internal-base-url"), null);
});

test("sensitive internal values are removed from successful report bodies and headers", async () => {
  const reportId = "10000000-0000-4000-8000-000000000008";
  const client = makeClient(async () =>
    Response.json(
      {
        report: {
          schemaVersion: "1.0.0",
          id: reportId,
          runId: "10000000-0000-4000-8000-000000000004",
          agentRunId: "10000000-0000-4000-8000-000000000007",
          version: 1,
          stage: "voc-positioning",
          status: "complete",
          skill: {
            id: "define-amazon-voc-positioning",
            version: "1.0.0",
            contentHash: "a".repeat(64),
          },
          snapshotIds: ["10000000-0000-4000-8000-000000000006"],
          model: { provider: "openai", model: "configured-model" },
          dataCutoffAt: "2026-08-14T08:00:00.000Z",
          evidence: [
            {
              id: "evidence-1",
              type: "snapshot",
              sourceId: "10000000-0000-4000-8000-000000000006",
              capturedAt: "2026-08-14T08:00:00.000Z",
            },
          ],
          result: {
            diagnostic: `contacted ${internalUrl} using ${proxyToken}`,
            [`upstream:${internalUrl}`]: {
              [proxyToken]: "secret appeared in nested property names",
            },
          },
          createdAt: "2026-08-14T08:00:00.000Z",
        },
      },
      {
        headers: {
          "x-debug-url": internalUrl,
          "x-debug-token": proxyToken,
        },
      },
    ),
  );

  const response = await callProxy({
    path: ["v1", "reports", reportId],
    client,
  });
  const serialized = JSON.stringify({
    body: await response.text(),
    headers: Object.fromEntries(response.headers),
  });

  assert.equal(response.status, 200);
  assert.doesNotMatch(serialized, /10\.0\.0\.8|super-secret-proxy-token/);
  assert.match(serialized, /\[redacted\]/);
});

test("the proxy rejects unapproved methods, paths, absolute URLs, and health", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return Response.json({ ok: true });
  });

  for (const request of [
    { method: "PUT", path: ["v1", "projects"] },
    { method: "GET", path: ["v1", "admin", "secrets"] },
    {
      method: "GET",
      path: ["v1", "Projects", "10000000-0000-4000-8000-000000000003"],
    },
    {
      method: "POST",
      path: [
        "v1",
        "runs",
        "10000000-0000-4000-8000-000000000004",
        "stages",
        "VOC-positioning",
        "retry",
      ],
    },
    {
      method: "GET",
      path: ["v1", "projects", "------------------------------------"],
    },
    {
      method: "GET",
      path: ["v1", "projects", "10000000-0000-1000-8000-000000000003"],
    },
    { method: "GET", path: ["https:", "evil.example"] },
    { method: "GET", path: ["health"] },
  ]) {
    const response = await callProxy({ ...request, client });
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("content-type"), "application/json");
  }

  assert.equal(calls, 0);
});

test("request IDs flow to the Agent Service and back to the browser", async () => {
  let forwardedRequestId: string | null = null;
  const client = makeClient(async (_input, init) => {
    forwardedRequestId = new Headers(init?.headers).get("x-request-id");
    return Response.json(
      { reports: [] },
      { headers: { "x-request-id": forwardedRequestId ?? "missing" } },
    );
  });

  const response = await callProxy({
    path: ["v1", "runs", "10000000-0000-4000-8000-000000000004", "reports"],
    client,
    headers: { "x-request-id": "browser-request-123" },
  });

  assert.equal(forwardedRequestId, "browser-request-123");
  assert.equal(response.headers.get("x-request-id"), "browser-request-123");
});

test("unsafe browser request IDs are replaced before proxying or responding", async () => {
  for (const unsafeRequestId of ["café", "a".repeat(129), "   "]) {
    let forwardedRequestId: string | null = null;
    const client = makeClient(async (_input, init) => {
      forwardedRequestId = new Headers(init?.headers).get("x-request-id");
      return Response.json(capabilityResponse);
    });

    const response = await callProxy({
      path: ["v1", "capabilities"],
      client,
      headers: { "x-request-id": unsafeRequestId },
    });
    const responseRequestId = response.headers.get("x-request-id");

    assert.match(forwardedRequestId ?? "", uuidV4Pattern);
    assert.equal(responseRequestId, forwardedRequestId);
    assert.notEqual(forwardedRequestId, unsafeRequestId);
    assert.doesNotMatch(
      JSON.stringify({
        body: await response.text(),
        headers: Object.fromEntries(response.headers),
      }),
      new RegExp(unsafeRequestId.trim() || "^$"),
    );
  }
});

test("the service client normalizes unsafe request IDs when called directly", async () => {
  for (const unsafeRequestId of ["café", "a".repeat(129), "   "]) {
    let forwardedRequestId: string | null = null;
    const client = makeClient(async (_input, init) => {
      forwardedRequestId = new Headers(init?.headers).get("x-request-id");
      return Response.json(capabilityResponse);
    });

    const result = await client({
      method: "GET",
      path: "/v1/capabilities",
      requestId: unsafeRequestId,
    });

    assert.match(forwardedRequestId ?? "", uuidV4Pattern);
    assert.equal(result.headers.get("x-request-id"), forwardedRequestId);
    assert.notEqual(forwardedRequestId, unsafeRequestId);
    assert.doesNotMatch(JSON.stringify(result.body), new RegExp(unsafeRequestId));
  }
});

test("validated POST JSON always reaches the service as application/json", async () => {
  for (const browserContentType of [undefined, "text/plain"]) {
    let upstreamHeaders = new Headers();
    let upstreamBody: BodyInit | null | undefined;
    const client = makeClient(async (_input, init) => {
      upstreamHeaders = new Headers(init?.headers);
      upstreamBody = init?.body;
      return Response.json(loginResponse);
    });
    const headers = browserContentType
      ? { "content-type": browserContentType }
      : undefined;

    const response = await callProxy({
      method: "POST",
      path: ["v1", "auth", "login"],
      client,
      headers,
      body: '{  "password": "correct horse", "email": "member@example.com" }',
    });

    assert.equal(response.status, 200);
    assert.equal(upstreamHeaders.get("content-type"), "application/json");
    assert.equal(
      upstreamBody,
      JSON.stringify({
        email: "member@example.com",
        password: "correct horse",
      }),
    );
  }
});

test("the same-origin proxy strips browser forwarding headers and forwards only trusted source metadata", async () => {
  let serviceHeaders = new Headers();
  const client: AgentServiceClient = async (request) => {
    serviceHeaders = new Headers(request.headers);
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: capabilityResponse,
    };
  };

  const response = await callProxy({
    path: ["v1", "capabilities"],
    client,
    headers: {
      cookie: "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "x-agent-proxy-token": "browser-spoofed-proxy-token",
      "x-agent-client-ip": "198.51.100.9",
      "x-forwarded-for": "198.51.100.10",
      forwarded: "for=198.51.100.11",
    },
  });

  assert.equal(response.status, 200);
  assert.equal(serviceHeaders.get("cookie"), "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(serviceHeaders.get("origin"), "https://web.example");
  assert.equal(serviceHeaders.get("x-agent-proxy-token"), null);
  assert.equal(serviceHeaders.get("x-forwarded-for"), null);
  assert.equal(serviceHeaders.get("forwarded"), null);
  assert.equal(serviceHeaders.get("x-agent-client-ip"), "unknown-source");
});

test("the service client forwards only the trusted client source header from its allowlist", async () => {
  let upstreamHeaders = new Headers();
  const client = makeClient(async (_input, init) => {
    upstreamHeaders = new Headers(init?.headers);
    return Response.json(capabilityResponse);
  });

  const result = await client({
    method: "GET",
    path: "/v1/capabilities",
    headers: {
      "x-agent-client-ip": "unknown-source",
      "x-forwarded-for": "198.51.100.10",
      forwarded: "for=198.51.100.11",
    },
  });

  assert.equal(result.status, 200);
  assert.equal(upstreamHeaders.get("x-agent-proxy-token"), proxyToken);
  assert.equal(upstreamHeaders.get("x-agent-client-ip"), "unknown-source");
  assert.equal(upstreamHeaders.get("x-forwarded-for"), null);
  assert.equal(upstreamHeaders.get("forwarded"), null);
});

test("timeouts are normalized and redact upstream exception details", async () => {
  const client = makeClient(
    async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(
            new Error(
              `timeout contacting ${internalUrl} with ${proxyToken}`,
            ),
          );
        });
      }),
    { timeoutMs: 5 },
  );

  const response = await callProxy({
    path: ["v1", "capabilities"],
    client,
  });
  const payload = await response.text();

  assert.equal(response.status, 504);
  assert.match(payload, /AGENT_SERVICE_TIMEOUT/);
  assert.doesNotMatch(payload, /10\.0\.0\.8|super-secret-proxy-token/);
});

test("missing Web configuration and an offline Agent Service are distinct", async () => {
  const missingConfigClient = createAgentServiceClient({ env: {} });
  const missingConfig = await missingConfigClient({
    method: "GET",
    path: "/v1/capabilities",
  });
  const offlineClient = makeClient(async () => {
    throw new TypeError("connect ECONNREFUSED 127.0.0.1:3100");
  });
  const offline = await offlineClient({
    method: "GET",
    path: "/v1/capabilities",
  });
  const missingConfigError = ApiErrorResponseSchema.parse(missingConfig.body);
  const offlineError = ApiErrorResponseSchema.parse(offline.body);

  assert.equal(missingConfig.status, 503);
  assert.equal(missingConfigError.error.code, "CONFIGURATION_ERROR");
  assert.match(missingConfigError.error.message, /not configured/i);
  assert.equal(offline.status, 502);
  assert.equal(offlineError.error.code, "AGENT_SERVICE_UNAVAILABLE");
  assert.match(offlineError.error.message, /is unavailable/i);
});

test("the timeout covers a response body that stalls after headers", async () => {
  const client = makeClient(
    async (_input, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(new Error("body read aborted"));
            });
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    { timeoutMs: 5 },
  );

  const outcome = await Promise.race([
    callProxy({ path: ["v1", "capabilities"], client }),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.equal((outcome as Response).status, 504);
  assert.match(
    await (outcome as Response).text(),
    /AGENT_SERVICE_TIMEOUT/,
  );
});

test("oversized responses are rejected with a normalized safe error", async () => {
  const client = makeClient(
    async () =>
      new Response(JSON.stringify({ data: "x".repeat(200) }), {
        headers: { "content-type": "application/json" },
      }),
    { maxResponseBytes: 64 },
  );

  const response = await callProxy({
    path: ["v1", "capabilities"],
    client,
  });

  assert.equal(response.status, 502);
  assert.match(await response.text(), /AGENT_SERVICE_RESPONSE_TOO_LARGE/);
});

test("invalid and declared-oversized responses cancel their upstream body", async () => {
  for (const response of [
    { contentType: "text/plain", contentLength: undefined },
    { contentType: "application/json", contentLength: "1000" },
  ]) {
    let cancelled = false;
    const client = makeClient(
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          {
            headers: {
              "content-type": response.contentType,
              ...(response.contentLength
                ? { "content-length": response.contentLength }
                : {}),
            },
          },
        ),
      { maxResponseBytes: 64 },
    );

    await callProxy({ path: ["v1", "capabilities"], client });
    assert.equal(cancelled, true);
  }
});

test("the Agent Service client rejects paths outside the declared contract registry", async () => {
  let calls = 0;
  const client = makeClient(async () => {
    calls += 1;
    return Response.json(capabilityResponse);
  });

  const result = await client({
    method: "GET",
    // @ts-expect-error arbitrary /v1 paths are not part of the typed client API
    path: "/v1/internal/secrets",
  });

  assert.equal(result.status, 502);
  assert.equal(calls, 0);
});

test("non-JSON and malformed JSON responses are normalized", async () => {
  for (const upstream of [
    new Response("plain text", {
      headers: { "content-type": "text/plain" },
    }),
    new Response("{broken", {
      headers: { "content-type": "application/json" },
    }),
  ]) {
    const client = makeClient(async () => upstream.clone());
    const response = await callProxy({
      path: ["v1", "capabilities"],
      client,
    });

    assert.equal(response.status, 502);
    assert.match(await response.text(), /AGENT_SERVICE_INVALID_RESPONSE/);
  }
});

test("upstream 5xx responses are normalized without reflecting sensitive content", async () => {
  const client = makeClient(async () =>
    Response.json(
      {
        error: {
          code: "INTERNAL_SERVER_ERROR",
          message: `database at ${internalUrl} rejected ${proxyToken}`,
          requestId: "upstream-request",
        },
      },
      {
        status: 500,
        headers: {
          "x-request-id": "upstream-request",
          "x-debug-token": proxyToken,
        },
      },
    ),
  );

  const response = await callProxy({
    path: ["v1", "capabilities"],
    client,
  });
  const serialized = JSON.stringify({
    body: await response.text(),
    headers: Object.fromEntries(response.headers),
  });

  assert.equal(response.status, 502);
  assert.match(serialized, /AGENT_SERVICE_UPSTREAM_ERROR/);
  assert.doesNotMatch(serialized, /10\.0\.0\.8|super-secret-proxy-token/);
});
