import assert from "node:assert/strict";
import test from "node:test";

import {
  createAgentServiceClient,
  type AgentServiceClient,
} from "../../app/lib/agent-service-client";
import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";

const internalUrl = "http://10.0.0.8:3100";
const proxyToken = "super-secret-proxy-token";

const capabilityResponse = {
  schemaVersion: "1.0.0",
  capabilities: {
    storage: { configured: true, available: true, reason: null },
    openai: { configured: true, available: true, reason: null },
    sif: { configured: true, available: true, reason: null },
    sorftime: { configured: true, available: true, reason: null },
    sellerSprite: { configured: true, available: true, reason: null },
    manualVoc: { configured: true, available: true, reason: null },
  },
};

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
