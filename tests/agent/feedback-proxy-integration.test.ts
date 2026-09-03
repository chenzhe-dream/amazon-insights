import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { proxyAgentRequest } from "../../app/api/agent/[...path]/route";
import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const proxyToken = "feedback-proxy-integration-token";
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const sessionId = "30000000-0000-4000-8000-000000000001";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "agent_session", secure: false, maxAgeSeconds: 3_600 },
  sessionTtlMs: 3_600_000,
  loginLimiter: { windowMs: 60_000, maxFailures: 5, maxEntries: 100 },
};

async function bodyOf(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const reserved of [3_000, 31_900, 31_901, 58_258]) {
    assert.notEqual(address.port, reserved);
  }
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: ReturnType<typeof createServer>) {
  server.close();
  await once(server, "close");
}

async function writeWebResponse(response: Response, target: ServerResponse) {
  target.statusCode = response.status;
  response.headers.forEach((value, name) => target.setHeader(name, value));
  target.end(Buffer.from(await response.arrayBuffer()));
}

test("real same-origin feedback proxy preserves multipart and streams an authorized attachment", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "feedback-proxy-integration-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  await repository.createInitialAdmin({
    id: userId,
    organizationId,
    email: "member@example.com",
    displayName: "Member",
    passwordHash: "test-only-hash",
    createdAt: "2026-08-22T00:00:00.000Z",
  });
  const authService = {
    async authenticate(token: string | null) {
      return token === rawToken
        ? {
            kind: "user" as const,
            userId,
            organizationId,
            email: "member@example.com",
            role: "member" as const,
            sessionId,
          }
        : null;
    },
  } as AuthenticationService;

  let agentOrigin = "";
  let webOrigin = "";
  let observedMultipartType = "";
  let observedMultipartBody = Buffer.alloc(0);
  const web = createServer(async (incoming, outgoing) => {
    try {
      const rawBody = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await bodyOf(incoming);
      const request = new Request(`${webOrigin}${incoming.url}`, {
        method: incoming.method,
        headers: incoming.headers as HeadersInit,
        body: rawBody ? Uint8Array.from(rawBody).buffer : undefined,
      });
      const path = new URL(request.url).pathname
        .replace(/^\/api\/agent\//, "")
        .split("/")
        .filter(Boolean);
      const response = await Reflect.apply(proxyAgentRequest, undefined, [
        request,
        { params: Promise.resolve({ path }) },
        undefined,
        {
          env: {
            AGENT_SERVICE_INTERNAL_URL: agentOrigin,
            AGENT_SERVICE_PROXY_TOKEN: proxyToken,
          },
          fetchImplementation: async (input: string | URL | Request, init?: RequestInit) => {
            if (init?.method === "POST") {
              observedMultipartType = new Headers(init.headers).get("content-type") ?? "";
              observedMultipartBody = Buffer.from(await new Response(init.body).arrayBuffer());
            }
            return fetch(input, init);
          },
        },
      ]) as Response;
      await writeWebResponse(response, outgoing);
    } catch {
      outgoing.statusCode = 500;
      outgoing.end("test same-origin proxy failed");
    }
  });
  webOrigin = await listen(web);
  const app = buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: webOrigin,
    },
    authConfig,
    authService,
    repository: repository as unknown as RuntimeAgentRepository,
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  agentOrigin = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close();
    repository.close();
    await close(web);
    rmSync(directory, { recursive: true, force: true });
  });

  const form = new FormData();
  form.set("category", "bug");
  form.set("title", "真实同源代理上传");
  form.set("description", "浏览器生成的 boundary 和正文必须完整到达 Agent");
  form.set("pagePath", "/projects?secret=removed");
  form.append("images", new File([png], "截图.png", { type: "image/png" }));
  const browserRequest = new Request(`${webOrigin}/api/agent/v1/feedback`, {
    method: "POST",
    headers: { cookie: `agent_session=${rawToken}` },
    body: form,
  });
  const expectedContentType = browserRequest.headers.get("content-type");
  const expectedBody = Buffer.from(await browserRequest.clone().arrayBuffer());
  const created = await fetch(browserRequest);

  assert.equal(created.status, 200);
  const feedbackId = String((await created.json()).feedbackId);
  assert.equal(observedMultipartType, expectedContentType);
  assert.deepEqual(observedMultipartBody, expectedBody);
  const detail = await repository.getOwnFeedbackDetail({
    organizationId,
    actorUserId: userId,
    feedbackId,
  });
  assert.equal(detail?.attachments.length, 1);
  const attachmentId = detail!.attachments[0]!.id;
  const stored = await repository.readOwnFeedbackAttachment({
    organizationId,
    actorUserId: userId,
    feedbackId,
    attachmentId,
  });
  assert.ok(stored);
  assert.equal(stored.fileName, "截图.png");

  const unauthorized = await fetch(
    `${webOrigin}/api/agent/v1/feedback/mine/${feedbackId}/attachments/${attachmentId}`,
  );
  assert.equal(unauthorized.status, 401);
  assert.equal(unauthorized.headers.get("content-type"), "application/json");

  const attachment = await fetch(
    `${webOrigin}/api/agent/v1/feedback/mine/${feedbackId}/attachments/${attachmentId}`,
    { headers: { cookie: `agent_session=${rawToken}` } },
  );
  assert.equal(attachment.status, 200);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), stored.imageContent);
  assert.equal(attachment.headers.get("content-type"), stored.mediaType);
  assert.equal(attachment.headers.get("content-length"), String(stored.byteSize));
  assert.equal(
    attachment.headers.get("content-disposition"),
    "inline; filename=\"__.png\"; filename*=UTF-8''%E6%88%AA%E5%9B%BE.png",
  );
  assert.equal(attachment.headers.get("x-content-type-options"), "nosniff");
  assert.equal(attachment.headers.get("cache-control"), "private, max-age=300, no-transform");
});
