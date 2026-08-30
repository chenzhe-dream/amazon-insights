import assert from "node:assert/strict";
import test from "node:test";

import Fastify from "fastify";

import {
  createAgentServiceClient,
  type AgentServiceClient,
} from "../../app/lib/agent-service-client";
import {
  DELETE,
  PATCH,
  PUT,
  proxyAgentRequest,
} from "../../app/api/agent/[...path]/route";
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

const localDataProjectResponse = {
  project: {
    id: "project-1",
    kind: "analysis" as const,
    slug: "local-bridge",
    name: "Local bridge",
    majorCategory: null,
    categoryLabel: null,
    marketplace: "US" as const,
    asins: ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"],
    note: null,
    createdBy: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
};

const localDataProjectsResponse = {
  projects: [localDataProjectResponse.project],
};

const localDataDeleteResponse = { ok: true };

const syncResumeResponse = {
  job: {
    jobId: "job-1",
    asins: ["B07VY9Q95Q"],
    marketplace: "US" as const,
    status: "queued",
    message: "Failed stages queued for explicit resume",
    currentStageId: "keywords",
    stages: [{ id: "keywords", label: "Keywords", kind: "auto" as const, status: "pending", estimatedSeconds: 1 }],
    asinProgress: {},
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
  },
  resumedStages: ["keywords"],
  reused: false,
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
  search = "",
  client,
  headers,
  body,
}: {
  method?: string;
  path: string[];
  search?: string;
  client: AgentServiceClient;
  headers?: HeadersInit;
  body?: string;
}) {
  return proxyAgentRequest(
    new Request(`https://web.example/api/agent/${path.join("/")}${search}`, {
      method,
      headers,
      body,
    }),
    { params: Promise.resolve({ path }) },
    client,
  );
}

async function callFeedbackProxy(
  request: Request,
  path: string[],
  options: {
    env: Readonly<Record<string, string | undefined>>;
    fetchImplementation: typeof fetch;
    timeoutMs?: number;
  },
) {
  return Reflect.apply(proxyAgentRequest, undefined, [
    request,
    { params: Promise.resolve({ path }) },
    undefined,
    options,
  ]) as Promise<Response>;
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

test("credential PUT is contract-validated and forwards JSON without echoing the secret", async () => {
  const secret = "proxy-credential-secret-sentinel";
  let upstreamMethod = "";
  let upstreamBody = "";
  let upstreamContentType: string | null = null;
  const client = makeClient(async (_input, init) => {
    upstreamMethod = init?.method ?? "";
    upstreamBody = String(init?.body);
    upstreamContentType = new Headers(init?.headers).get("content-type");
    return Response.json({
      connectorId: "sif",
      configured: true,
      managed: true,
      version: 1,
      updatedAt: "2026-08-19T08:00:00.000Z",
    });
  });
  const request = new Request(
    "https://web.example/api/agent/v1/connectors/sif/credential",
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret }),
    },
  );
  const response = await PUT(
    request,
    { params: Promise.resolve({ path: ["v1", "connectors", "sif", "credential"] }) },
    client,
  );

  assert.equal(response.status, 200);
  assert.equal(upstreamMethod, "PUT");
  assert.equal(upstreamContentType, "application/json");
  assert.deepEqual(JSON.parse(upstreamBody), { secret });
  assert.doesNotMatch(await response.text(), new RegExp(secret));

  const rejected = await callProxy({
    method: "PUT",
    path: ["v1", "connectors", "sif", "credential"],
    client,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret, unexpected: true }),
  });
  assert.equal(rejected.status, 400);
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

test("bodyless admin resume crosses the Web proxy without an empty JSON content type", async (t) => {
  const upstream = Fastify();
  let handlerCalls = 0;
  upstream.post("/v1/admin/sync-asins/:jobId/resume", async (_request, reply) => {
    handlerCalls += 1;
    return reply.status(202).send(syncResumeResponse);
  });
  t.after(() => upstream.close());
  let upstreamStatus = 0;

  const client = makeClient(async (input, init) => {
    const response = await upstream.inject({
      method: "POST",
      url: new URL(String(input)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: init?.body == null ? undefined : String(init.body),
    });
    upstreamStatus = response.statusCode;
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as HeadersInit,
    });
  });

  const response = await callProxy({
    method: "POST",
    path: ["v1", "admin", "sync-asins", "job-1", "resume"],
    client,
    headers: { "content-type": "application/json" },
  });

  assert.equal(upstreamStatus, 202);
  assert.equal(response.status, 202);
  assert.equal(handlerCalls, 1);
  assert.deepEqual(await response.json(), syncResumeResponse);
});

test("only feedback multipart crosses the proxy with its browser boundary and bytes intact", async () => {
  const form = new FormData();
  form.set("category", "bug");
  form.set("title", "Boundary preservation");
  form.set("description", "The browser-generated multipart body must remain byte exact");
  form.set("pagePath", "/projects");
  form.append(
    "images",
    new File([Buffer.from([0x89, 0x50, 0x4e, 0x47])], "screen.png", {
      type: "image/png",
    }),
  );
  const browserRequest = new Request(
    "https://web.example/api/agent/v1/feedback",
    {
      method: "POST",
      headers: {
        cookie: "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        "x-agent-proxy-token": "browser-spoofed-token",
        "x-forwarded-for": "198.51.100.20",
      },
      body: form,
    },
  );
  const browserContentType = browserRequest.headers.get("content-type");
  const browserBytes = Buffer.from(await browserRequest.clone().arrayBuffer());
  let upstreamHeaders = new Headers();
  let upstreamBytes = Buffer.alloc(0);

  const response = await callFeedbackProxy(
    browserRequest,
    ["v1", "feedback"],
    {
      env: {
        AGENT_SERVICE_INTERNAL_URL: internalUrl,
        AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      },
      fetchImplementation: async (_input, init) => {
        upstreamHeaders = new Headers(init?.headers);
        upstreamBytes = Buffer.from(await new Response(init?.body).arrayBuffer());
        return Response.json({
          feedbackId: "40000000-0000-4000-8000-000000000010",
          createdAt: "2026-08-22T00:00:00.000Z",
        });
      },
    },
  );

  assert.equal(response.status, 200);
  assert.match(browserContentType ?? "", /^multipart\/form-data; boundary=/i);
  assert.equal(upstreamHeaders.get("content-type"), browserContentType);
  assert.deepEqual(upstreamBytes, browserBytes);
  assert.equal(upstreamHeaders.get("cookie"), "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(upstreamHeaders.get("origin"), "https://web.example");
  assert.equal(upstreamHeaders.get("x-agent-proxy-token"), proxyToken);
  assert.equal(upstreamHeaders.get("x-forwarded-for"), null);
  assert.equal(upstreamHeaders.get("x-agent-client-ip"), "unknown-source");
});

test("dedicated feedback JSON is byte-bounded and limited to the exact feedback route", async () => {
  const body = JSON.stringify({
    category: "bug",
    title: "Dedicated transfer",
    description: "A bounded body",
    pagePath: "/projects",
    images: [{
      fileName: "screen.png",
      mediaType: "image/png",
      byteLength: 8,
      contentBase64: "AAAAAAAAAAA=",
    }],
  });
  let upstreamBody = "";
  let upstreamType = "";
  let upstreamTransfer = "";
  let rawCalls = 0;
  const options = {
    env: {
      AGENT_SERVICE_INTERNAL_URL: internalUrl,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    fetchImplementation: async (_input: string | URL | Request, init?: RequestInit) => {
      rawCalls += 1;
      upstreamType = new Headers(init?.headers).get("content-type") ?? "";
      upstreamTransfer = new Headers(init?.headers).get("x-agent-feedback-transfer") ?? "";
      upstreamBody = await new Response(init?.body).text();
      return Response.json({
        feedbackId: "40000000-0000-4000-8000-000000000011",
        createdAt: "2026-08-22T00:00:00.000Z",
      });
    },
  };
  const accepted = await callFeedbackProxy(
    new Request("https://web.example/api/agent/v1/feedback", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feedback-transfer": "1" },
      body,
    }),
    ["v1", "feedback"],
    options,
  );
  assert.equal(accepted.status, 200);
  assert.equal(upstreamType, "application/json");
  assert.equal(upstreamTransfer, "1");
  assert.equal(upstreamBody, body);

  const maxTransferBytes =
    3 * Math.ceil((5 * 1024 * 1024) / 3) * 4 + 128 * 1024;
  const oversized = await callFeedbackProxy(
    new Request("https://web.example/api/agent/v1/feedback", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-feedback-transfer": "1",
        "content-length": String(maxTransferBytes + 1),
      },
      body: "{}",
    }),
    ["v1", "feedback"],
    options,
  );
  assert.equal(oversized.status, 413);

  const wrongRouteClient: AgentServiceClient = async () => {
    throw new Error("dedicated feedback JSON must not reach another route");
  };
  const wrongRoute = await proxyAgentRequest(
    new Request("https://web.example/api/agent/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-feedback-transfer": "1" },
      body,
    }),
    { params: Promise.resolve({ path: ["v1", "auth", "login"] }) },
    wrongRouteClient,
  );
  assert.equal(wrongRoute.status, 400);
  assert.equal(rawCalls, 1);
});

test("multipart and binary proxy exceptions stay limited to approved feedback surfaces", async () => {
  let rawCalls = 0;
  const options = {
    env: {
      AGENT_SERVICE_INTERNAL_URL: internalUrl,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    fetchImplementation: (async () => {
      rawCalls += 1;
      return Response.json({ ok: true });
    }) as typeof fetch,
  };
  const oversized = await callFeedbackProxy(
    new Request("https://web.example/api/agent/v1/feedback", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=bounded-feedback",
        "content-length": String(3 * 5 * 1_048_576 + 128 * 1_024 + 1),
      },
      body: "--bounded-feedback--\r\n",
    }),
    ["v1", "feedback"],
    options,
  );
  const malformedBoundary = await callFeedbackProxy(
    new Request("https://web.example/api/agent/v1/feedback", {
      method: "POST",
      headers: { "content-type": "multipart/form-data" },
      body: "missing boundary",
    }),
    ["v1", "feedback"],
    options,
  );
  const otherRouteClient: AgentServiceClient = async () => {
    throw new Error("non-feedback multipart must not reach the JSON client");
  };
  const otherRoute = await proxyAgentRequest(
    new Request("https://web.example/api/agent/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=scope-expansion" },
      body: "--scope-expansion--\r\n",
    }),
    { params: Promise.resolve({ path: ["v1", "auth", "login"] }) },
    otherRouteClient,
  );

  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).error.code, "VALIDATION_ERROR");
  assert.equal(malformedBoundary.status, 400);
  assert.equal(otherRoute.status, 400);
  assert.equal(rawCalls, 0);
});

test("feedback transfer body stalls keep the existing generic timeout error", async () => {
  const outcome = await Promise.race([
    callFeedbackProxy(
      new Request("https://web.example/api/agent/v1/feedback", {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=stall" },
        body: "--stall--\r\n",
      }),
      ["v1", "feedback"],
      {
        env: {
          AGENT_SERVICE_INTERNAL_URL: internalUrl,
          AGENT_SERVICE_PROXY_TOKEN: proxyToken,
        },
        timeoutMs: 5,
        fetchImplementation: async () =>
          new Response(new ReadableStream({ start() {} }), {
            headers: { "content-type": "application/json" },
          }),
      },
    ),
    new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 50)),
  ]);

  assert.notEqual(outcome, "hung");
  assert.equal((outcome as Response).status, 504);
  assert.match(await (outcome as Response).text(), /AGENT_SERVICE_TIMEOUT/);
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

test("the same-origin proxy forwards safe query strings without trusting spoofed headers", async () => {
  let servicePath = "";
  let serviceHeaders = new Headers();
  const client: AgentServiceClient = async (request) => {
    servicePath = request.path;
    serviceHeaders = new Headers(request.headers);
    return {
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: localDataProjectsResponse,
    };
  };

  const response = await callProxy({
    path: ["v1", "local-data", "projects"],
    search: "?kind=analysis",
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
  assert.equal(
    servicePath,
    "/v1/local-data/projects?kind=analysis",
  );
  assert.equal(serviceHeaders.get("cookie"), "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(serviceHeaders.get("x-agent-proxy-token"), null);
  assert.equal(serviceHeaders.get("x-forwarded-for"), null);
  assert.equal(serviceHeaders.get("forwarded"), null);
  assert.equal(serviceHeaders.get("x-agent-client-ip"), "unknown-source");
});

test("the service client sends query strings only to the configured Agent Service origin", async () => {
  let upstreamUrl = "";
  const client = makeClient(async (input) => {
    upstreamUrl = String(input);
    return Response.json(localDataProjectsResponse);
  });

  const result = await client({
    method: "GET",
    path: "/v1/local-data/projects?kind=analysis",
  });

  assert.equal(result.status, 200);
  assert.equal(
    upstreamUrl,
    `${internalUrl}/v1/local-data/projects?kind=analysis`,
  );
});

test("the service client accepts auth session, local VOC submission, and VOC import routes", async () => {
  const runId = "10000000-0000-4000-8000-000000000004";
  let upstreamUrl = "";
  const client = makeClient(async (input) => {
    upstreamUrl = String(input);
    if (String(input).endsWith("/v1/auth/session")) {
      return Response.json({ authenticated: false, user: null, sessionIdentity: null });
    }
    if (String(input).endsWith("/v1/local-voc")) {
      return Response.json({
        projectId: "10000000-0000-4000-8000-000000000003",
        runId,
      });
    }
    return Response.json({
      runId,
      snapshotId: "10000000-0000-4000-8000-000000000006",
      stageId: "10000000-0000-4000-8000-000000000005",
      jobId: "10000000-0000-4000-8000-000000000007",
      importMode: "paste",
    });
  });

  assert.equal((await client({ method: "GET", path: "/v1/auth/session" })).status, 200);
  assert.equal(upstreamUrl, `${internalUrl}/v1/auth/session`);
  assert.equal(
    (await client({
      method: "POST",
      path: "/v1/local-voc",
      body: JSON.stringify({ asins: ["B07VY9Q95Q", "B0BPXRVWYK", "B07DYG1C9B"], marketplace: "US" }),
    })).status,
    200,
  );
  assert.equal(upstreamUrl, `${internalUrl}/v1/local-voc`);
  assert.equal(
    (await client({
      method: "POST",
      path: `/v1/runs/${runId}/voc-import`,
      body: JSON.stringify({ importMode: "paste", candidate: { sections: [] } }),
    })).status,
    200,
  );
  assert.equal(upstreamUrl, `${internalUrl}/v1/runs/${runId}/voc-import`);
});

test("PATCH and DELETE local-data routes proxy with header sanitization and cookie handling", async () => {
  for (const request of [
    {
      method: "PATCH",
      responseBody: localDataProjectResponse,
      requestBody: JSON.stringify({ name: "Renamed" }),
    },
    {
      method: "DELETE",
      responseBody: localDataDeleteResponse,
      requestBody: undefined,
    },
  ] as const) {
    let servicePath = "";
    let serviceMethod = "";
    let serviceHeaders = new Headers();
    let serviceBody: string | undefined;
    const client = makeClient(async (input, init) => {
      servicePath = new URL(String(input)).pathname;
      serviceMethod = init?.method ?? "";
      serviceHeaders = new Headers(init?.headers);
      serviceBody = typeof init?.body === "string" ? init.body : undefined;
      return Response.json(request.responseBody, {
        headers: {
          "set-cookie": "agent_session=updated; Domain=agent.internal; Path=/; HttpOnly",
        },
      });
    });

    const routeRequest = new Request(
      "https://web.example/api/agent/v1/local-data/projects/project-1",
      {
        method: request.method,
        headers: {
          cookie: "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          "content-type": "application/json",
          "x-agent-proxy-token": "browser-spoofed-proxy-token",
          "x-agent-client-ip": "198.51.100.9",
          "x-forwarded-for": "198.51.100.10",
          forwarded: "for=198.51.100.11",
        },
        body: request.requestBody,
      },
    );
    const response = request.method === "PATCH"
      ? await PATCH(
          routeRequest,
          { params: Promise.resolve({ path: ["v1", "local-data", "projects", "project-1"] }) },
          client,
        )
      : await DELETE(
          routeRequest,
          { params: Promise.resolve({ path: ["v1", "local-data", "projects", "project-1"] }) },
          client,
        );

    assert.equal(response.status, 200);
    assert.equal(serviceMethod, request.method);
    assert.equal(servicePath, "/v1/local-data/projects/project-1");
    assert.equal(serviceHeaders.get("cookie"), "__Host-agent_session=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    assert.equal(serviceHeaders.get("x-agent-proxy-token"), proxyToken);
    assert.equal(serviceHeaders.get("x-forwarded-for"), null);
    assert.equal(serviceHeaders.get("forwarded"), null);
    assert.equal(serviceHeaders.get("x-agent-client-ip"), "unknown-source");
    assert.doesNotMatch(response.headers.get("set-cookie") ?? "", /Domain=/i);
    if (request.method === "PATCH") {
      assert.equal(serviceBody, JSON.stringify({ name: "Renamed" }));
    } else {
      assert.equal(serviceBody, undefined);
    }
  }
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
