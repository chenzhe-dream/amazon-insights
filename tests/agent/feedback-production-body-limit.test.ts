import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";

const MAX_FEEDBACK_TRANSFER_BYTES =
  3 * Math.ceil((5 * 1024 * 1024) / 3) * 4 + 128 * 1024;
const ABOVE_DEFAULT_LIMIT_BYTES = 1_900_036;
const proxyToken = "feedback-production-test-token";
const rawToken = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const userId = "10000000-0000-4000-8000-000000000001";
const organizationId = "20000000-0000-4000-8000-000000000001";
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "agent_session", secure: false, maxAgeSeconds: 3_600 },
  sessionTtlMs: 3_600_000,
  loginLimiter: { windowMs: 60_000, maxFailures: 5, maxEntries: 100 },
};

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  for (const livePort of [31_900, 31_901, 58_258]) {
    assert.notEqual(address.port, livePort);
  }
  const port = address.port;
  const closed = once(server, "close");
  server.close();
  await closed;
  return port;
}

async function waitForWeb(baseUrl: string, child: ReturnType<typeof spawn>, output: { value: string }) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Built Web exited before readiness: ${output.value}`);
    }
    try {
      await fetch(`${baseUrl}/api/health`);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Built Web did not start: ${output.value}`);
}

async function stopChild(child: ReturnType<typeof spawn>) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (child.exitCode !== null) return;
  child.kill("SIGKILL");
}

async function postDeclaredOversizedFeedback(baseUrl: string) {
  return new Promise<number>((resolve, reject) => {
    let settled = false;
    const request = httpRequest(`${baseUrl}/api/agent/v1/feedback`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(MAX_FEEDBACK_TRANSFER_BYTES + 1),
        "x-feedback-transfer": "1",
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        settled = true;
        resolve(response.statusCode ?? 0);
        request.destroy();
      });
    });
    request.on("error", (error) => {
      if (!settled) reject(error);
    });
    request.setTimeout(10_000, () => {
      request.destroy(new Error("oversized feedback request timed out"));
    });
    request.flushHeaders();
  });
}

function multipartBody(byteLength: number, boundary: string) {
  const prefix = Buffer.from(
    `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="payload.bin"\r\n' +
      "Content-Type: application/octet-stream\r\n\r\n",
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return Buffer.concat([
    prefix,
    Buffer.alloc(byteLength - prefix.byteLength - suffix.byteLength, 0x61),
    suffix,
  ]);
}

test("built Web keeps default multipart isolation and admits only bounded feedback transfer", { timeout: 60_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "feedback-production-limit-"));
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
            sessionId: "30000000-0000-4000-8000-000000000001",
          }
        : null;
    },
  } as AuthenticationService;
  const webPort = await reservePort();
  const webOrigin = `http://127.0.0.1:${webPort}`;
  const agent = buildAgentApp({
    env: {
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: webOrigin,
    },
    authConfig,
    authService,
    repository,
  });
  await agent.listen({ host: "127.0.0.1", port: 0 });
  const agentAddress = agent.server.address();
  assert.ok(agentAddress && typeof agentAddress === "object");
  for (const livePort of [31_900, 31_901, 58_258]) {
    assert.notEqual(agentAddress.port, livePort);
  }
  const output = { value: "" };
  const child = spawn(process.execPath, ["scripts/team-prod-server.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(webPort),
      AGENT_SERVICE_INTERNAL_URL: `http://127.0.0.1:${agentAddress.port}`,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (chunk) => { output.value += chunk; });
  child.stderr.on("data", (chunk) => { output.value += chunk; });
  t.after(async () => {
    await stopChild(child);
    await agent.close();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await waitForWeb(webOrigin, child, output);

  const boundary = "non-feedback-default-limit";
  const nonFeedbackMultipart = await fetch(`${webOrigin}/api/agent/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(ABOVE_DEFAULT_LIMIT_BYTES, boundary),
  });

  const sourceImage = readFileSync(join(process.cwd(), "public", "og.png"));
  assert.ok(sourceImage.byteLength > 1_048_576);
  assert.ok(sourceImage.byteLength <= 5 * 1024 * 1024);
  const feedback = await fetch(`${webOrigin}/api/agent/v1/feedback`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-feedback-transfer": "1",
      cookie: `agent_session=${rawToken}`,
    },
    body: JSON.stringify({
      category: "bug",
      title: "Production upload regression",
      description: "The existing Agent sanitizer must process the real image",
      pagePath: "/projects?private=removed",
      images: [{
        fileName: "og.png",
        mediaType: "image/png",
        byteLength: sourceImage.byteLength,
        contentBase64: sourceImage.toString("base64"),
      }],
    }),
  });

  const oversizedFeedbackStatus = await postDeclaredOversizedFeedback(webOrigin);

  assert.deepEqual(
    [nonFeedbackMultipart.status, feedback.status, oversizedFeedbackStatus],
    [413, 200, 413],
  );
  const created = await feedback.json() as { feedbackId: string };
  const detail = await repository.getOwnFeedbackDetail({
    organizationId,
    actorUserId: userId,
    feedbackId: created.feedbackId,
  });
  assert.equal(detail?.pagePath, "/projects");
  assert.equal(detail?.attachments.length, 1);
  assert.ok((detail?.attachments[0]?.byteSize ?? 0) > 0);
});
