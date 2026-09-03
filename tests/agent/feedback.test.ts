import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";

import { buildAgentApp } from "../../server/app";
import type { AuthenticationService } from "../../server/auth/authentication-service";
import type { AgentAuthenticationConfig } from "../../server/config";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  CreateFeedbackRequestSchema,
  findHttpContract,
} from "../../shared/agent-contracts";

const directories: string[] = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const NOW = "2026-08-20T00:00:00.000Z";
const USER_ID = "10000000-0000-4000-8000-000000000001";
const OTHER_USER_ID = "10000000-0000-4000-8000-000000000002";
const THIRD_USER_ID = "10000000-0000-4000-8000-000000000003";
const ORG_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_ORG_ID = "20000000-0000-4000-8000-000000000099";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const PROXY_TOKEN = "feedback-proxy-token";
const ORIGIN = "http://127.0.0.1:31900";
const RAW_TOKEN = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const authConfig: AgentAuthenticationConfig = {
  mode: "authenticated",
  cookie: { name: "agent_session", secure: false, maxAgeSeconds: 3600 },
  sessionTtlMs: 3_600_000,
  loginLimiter: { windowMs: 60_000, maxFailures: 5, maxEntries: 100 },
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "agent-feedback-"));
  directories.push(directory);
  const path = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  return { path, repository };
}

function multipartBody(
  fields: readonly (readonly [string, string])[],
  files: readonly { name: string; type: string; content: Buffer }[],
) {
  const boundary = "feedback-test-boundary";
  const chunks: Buffer[] = [];
  for (const [name, value] of fields) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="images"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`));
    chunks.push(file.content, Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

test("feedback contract is strict and bounded", () => {
  assert.equal(findHttpContract("POST", "/v1/feedback")?.path, "/v1/feedback");
  assert.equal(CreateFeedbackRequestSchema.safeParse({ category: "bug", title: "Title", description: "Detail", pagePath: "/projects?token=secret" }).success, true);
  assert.equal(CreateFeedbackRequestSchema.safeParse({ category: "invalid", title: "Title", description: "Detail", pagePath: "/" }).success, false);
  assert.equal(CreateFeedbackRequestSchema.safeParse({ category: "bug", title: "", description: "Detail", pagePath: "/" }).success, false);
  assert.equal(CreateFeedbackRequestSchema.safeParse({ category: "bug", title: "Title", description: "x".repeat(4001), pagePath: "/" }).success, false);
  assert.equal(CreateFeedbackRequestSchema.safeParse({ category: "bug", title: "Title", description: "Detail", pagePath: "/", organizationId: ORG_ID }).success, false);
});

test("repository creates same-org feedback and rejects cross-org actors", async () => {
  const { repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "admin@example.test", displayName: "Admin", passwordHash: "hash", createdAt: NOW });
  const saved = await repository.createUserFeedback({
    id: "40000000-0000-4000-8000-000000000001",
    organizationId: ORG_ID,
    actorUserId: USER_ID,
    category: "suggestion",
    title: "Improve this",
    description: "Detailed suggestion",
    pagePath: "/projects",
    appVersion: "0.1.0",
    createdAt: NOW,
  });
  assert.equal(saved?.organizationId, ORG_ID);
  assert.equal(await repository.createUserFeedback({ ...saved!, id: "40000000-0000-4000-8000-000000000002", organizationId: "20000000-0000-4000-8000-000000000099" }), null);
  repository.close();
});

test("SQLite feedback aggregates are atomic, metadata-only, tenant scoped, and CAS-driven", async () => {
  const { path, repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "admin@example.test", displayName: "Admin", passwordHash: "hash", createdAt: NOW });
  await repository.createUser({
    id: OTHER_USER_ID,
    organizationId: ORG_ID,
    email: "other@example.test",
    displayName: "Other",
    role: "member",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });

  const feedbackId = "40000000-0000-4000-8000-000000000010";
  const attachmentId = "50000000-0000-4000-8000-000000000010";
  const imageContent = Buffer.from("sanitized-image");
  const attachment = {
    id: attachmentId,
    fileName: "shot.png",
    mediaType: "image/png" as const,
    byteSize: imageContent.byteLength,
    sha256: createHash("sha256").update(imageContent).digest("hex"),
    imageContent,
    createdAt: NOW,
  };
  const saved = await repository.createUserFeedback({
    id: feedbackId,
    organizationId: ORG_ID,
    actorUserId: USER_ID,
    category: "bug",
    title: "Screenshot issue",
    description: "The screenshot explains it",
    pagePath: "/projects",
    appVersion: "0.1.0",
    createdAt: NOW,
    initialEventId: "60000000-0000-4000-8000-000000000010",
    attachments: [attachment],
  });
  assert.equal(saved?.id, feedbackId);

  const ownList = await repository.listOwnFeedback({ organizationId: ORG_ID, actorUserId: USER_ID });
  assert.equal(ownList.length, 1);
  assert.equal(ownList[0]?.attachmentCount, 1);
  assert.equal("imageContent" in ownList[0]!, false);
  assert.deepEqual(await repository.listOwnFeedback({ organizationId: ORG_ID, actorUserId: OTHER_USER_ID }), []);
  assert.deepEqual(await repository.listOwnFeedback({ organizationId: "20000000-0000-4000-8000-000000000099", actorUserId: USER_ID }), []);

  const ownDetail = await repository.getOwnFeedbackDetail({ organizationId: ORG_ID, actorUserId: USER_ID, feedbackId });
  assert.equal(ownDetail?.status, "new");
  assert.equal(ownDetail?.workflowVersion, 1);
  assert.equal(ownDetail?.attachments[0]?.id, attachmentId);
  assert.equal("imageContent" in ownDetail!.attachments[0]!, false);
  assert.equal(await repository.getOwnFeedbackDetail({ organizationId: ORG_ID, actorUserId: OTHER_USER_ID, feedbackId }), null);
  assert.equal(await repository.getOwnFeedbackDetail({ organizationId: "20000000-0000-4000-8000-000000000099", actorUserId: USER_ID, feedbackId }), null);

  assert.equal((await repository.listOrganizationFeedback({ organizationId: ORG_ID, status: "new" })).length, 1);
  assert.deepEqual(await repository.listOrganizationFeedback({ organizationId: ORG_ID, status: "resolved" }), []);
  assert.equal((await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId }))?.id, feedbackId);
  assert.equal(await repository.getOrganizationFeedbackDetail({ organizationId: "20000000-0000-4000-8000-000000000099", feedbackId }), null);

  assert.deepEqual(
    (await repository.readOwnFeedbackAttachment({ organizationId: ORG_ID, actorUserId: USER_ID, feedbackId, attachmentId }))?.imageContent,
    imageContent,
  );
  assert.equal(await repository.readOwnFeedbackAttachment({ organizationId: ORG_ID, actorUserId: OTHER_USER_ID, feedbackId, attachmentId }), null);
  assert.equal(await repository.readOrganizationFeedbackAttachment({ organizationId: "20000000-0000-4000-8000-000000000099", feedbackId, attachmentId }), null);

  assert.equal(await repository.countUnreadOrganizationFeedback(ORG_ID), 1);
  assert.equal(await repository.markOrganizationFeedbackSeen({ organizationId: "20000000-0000-4000-8000-000000000099", feedbackId, seenAt: "2026-08-20T00:01:00.000Z" }), null);
  const seen = await Promise.all([
    repository.markOrganizationFeedbackSeen({ organizationId: ORG_ID, feedbackId, seenAt: "2026-08-20T00:01:00.000Z" }),
    repository.markOrganizationFeedbackSeen({ organizationId: ORG_ID, feedbackId, seenAt: "2026-08-20T00:02:00.000Z" }),
  ]);
  assert.deepEqual(seen.sort(), ["changed", "unchanged"]);
  assert.equal(await repository.countUnreadOrganizationFeedback(ORG_ID), 0);

  const unchanged = await repository.changeOrganizationFeedbackStatus({
    organizationId: ORG_ID,
    feedbackId,
    actorUserId: USER_ID,
    expectedVersion: 1,
    status: "new",
    eventId: "60000000-0000-4000-8000-000000000011",
    changedAt: "2026-08-20T00:03:00.000Z",
  });
  assert.equal(unchanged?.workflowVersion, 1);
  assert.equal((await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId }))?.events.length, 1);

  const transitions = await Promise.all([
    repository.changeOrganizationFeedbackStatus({ organizationId: ORG_ID, feedbackId, actorUserId: USER_ID, expectedVersion: 1, status: "processing", eventId: "60000000-0000-4000-8000-000000000012", changedAt: "2026-08-20T00:04:00.000Z" }),
    repository.changeOrganizationFeedbackStatus({ organizationId: ORG_ID, feedbackId, actorUserId: USER_ID, expectedVersion: 1, status: "resolved", eventId: "60000000-0000-4000-8000-000000000013", changedAt: "2026-08-20T00:04:00.000Z" }),
  ]);
  assert.equal(transitions.filter(Boolean).length, 1);
  const current = await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId });
  assert.equal(current?.workflowVersion, 2);
  assert.equal(current?.events.length, 2);

  const beforeCounts = new DatabaseSync(path, { readOnly: true });
  const tableCounts = () => ["user_feedback", "user_feedback_workflow", "user_feedback_events", "user_feedback_attachments"].map((table) =>
    Number((beforeCounts.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
  assert.deepEqual(tableCounts(), [1, 1, 2, 1]);
  beforeCounts.close();

  const failedFeedbackId = "40000000-0000-4000-8000-000000000020";
  await assert.rejects(repository.createUserFeedback({
    id: failedFeedbackId,
    organizationId: ORG_ID,
    actorUserId: USER_ID,
    category: "bug",
    title: "Must roll back",
    description: "A late attachment failure must roll back the aggregate",
    pagePath: "/projects",
    appVersion: null,
    createdAt: NOW,
    initialEventId: "60000000-0000-4000-8000-000000000020",
    attachments: [attachment, { ...attachment, createdAt: "2026-08-20T00:05:00.000Z" }],
  }));
  repository.close();

  const database = new DatabaseSync(path);
  const countsAfter = ["user_feedback", "user_feedback_workflow", "user_feedback_events", "user_feedback_attachments"].map((table) =>
    Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count));
  assert.deepEqual(countsAfter, [1, 1, 2, 1]);
  assert.throws(() => database.prepare("UPDATE user_feedback_events SET created_at = ? WHERE feedback_id = ?").run(NOW, feedbackId), /immutable/i);
  assert.throws(() => database.prepare("DELETE FROM user_feedback_events WHERE feedback_id = ?").run(feedbackId), /immutable/i);
  database.close();
});

test("authenticated route derives actor and org, strips URL query, and never stores request secrets", async (t) => {
  const { path, repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "admin@example.test", displayName: "Admin", passwordHash: "hash", createdAt: NOW });
  const authService = {
    async authenticate(raw: string | null) {
      return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, email: "member@example.com", role: "member" as const, sessionId: SESSION_ID } : null;
    },
  } as AuthenticationService;
  const app = buildAgentApp({
    env: { AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN, AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN },
    authConfig,
    authService,
    repository,
  });
  t.after(() => app.close());
  const headers = {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    cookie: `agent_session=${RAW_TOKEN}; private=must-never-store`,
    authorization: "Bearer must-never-store",
  };
  const anonymous = await app.inject({ method: "POST", url: "/v1/feedback", headers: { origin: ORIGIN, "x-agent-proxy-token": PROXY_TOKEN }, payload: { category: "bug", title: "Title", description: "Detail", pagePath: "/" } });
  assert.equal(anonymous.statusCode, 401);
  const spoof = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: { category: "bug", title: "Title", description: "Detail", pagePath: "/", organizationId: "20000000-0000-4000-8000-000000000099" } });
  assert.equal(spoof.statusCode, 400);
  const response = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: { category: "bug", title: "Broken button", description: "Click does nothing", pagePath: "/projects?token=must-never-store#fragment" } });
  assert.equal(response.statusCode, 200);
  assert.match(response.json().feedbackId, /^[0-9a-f-]{36}$/);
  for (let index = 2; index <= 5; index += 1) {
    const allowed = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: { category: "suggestion", title: `Member feedback ${index}`, description: "Allowed inside the per-user window", pagePath: "/" } });
    assert.equal(allowed.statusCode, 200);
  }
  const limited = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: { category: "other", title: "Sixth feedback", description: "Must be rate limited", pagePath: "/" } });
  assert.equal(limited.statusCode, 429);

  repository.close();
  const database = new DatabaseSync(path, { readOnly: true });
  const rows = database.prepare("SELECT * FROM user_feedback").all();
  database.close();
  assert.equal(rows.length, 5);
  assert.equal(rows[0]!.organization_id, ORG_ID);
  assert.equal(rows[0]!.actor_user_id, USER_ID);
  assert.equal(rows[0]!.page_path, "/projects");
  assert.doesNotMatch(JSON.stringify(rows), /must-never-store|token=/);
});

test("feedback routes conceal other users and tenants and reserve workflow writes for the primary administrator", async (t) => {
  const { repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "admin@example.com", displayName: "Primary Admin", passwordHash: "hash", createdAt: NOW });
  await repository.createUser({
    id: OTHER_USER_ID,
    organizationId: ORG_ID,
    email: "ordinary@example.com",
    displayName: "Ordinary Admin",
    role: "admin",
    status: "active",
    createdAt: NOW,
    updatedAt: NOW,
  });
  const feedbackId = "40000000-0000-4000-8000-000000000030";
  const attachmentId = "50000000-0000-4000-8000-000000000030";
  const imageContent = Buffer.from("sanitized-feedback-route-image");
  await repository.createUserFeedback({
    id: feedbackId,
    organizationId: ORG_ID,
    actorUserId: OTHER_USER_ID,
    category: "bug",
    title: "Scoped workflow",
    description: "Only the owner or primary administrator may read this",
    pagePath: "/projects",
    appVersion: "0.1.0",
    createdAt: NOW,
    initialEventId: "60000000-0000-4000-8000-000000000030",
    attachments: [{
      id: attachmentId,
      fileName: "截图.png",
      mediaType: "image/png",
      byteSize: imageContent.byteLength,
      sha256: createHash("sha256").update(imageContent).digest("hex"),
      imageContent,
      createdAt: NOW,
    }],
  });

  const tokens = {
    primary: RAW_TOKEN,
    ordinary: "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
    member: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
    crossTenantPrimary: "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE",
  } as const;
  const authService = {
    async authenticate(raw: string | null) {
      if (raw === tokens.primary) return { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, email: " ADMIN@Example.COM ", role: "admin" as const, sessionId: SESSION_ID };
      if (raw === tokens.ordinary) return { kind: "user" as const, userId: OTHER_USER_ID, organizationId: ORG_ID, email: "ordinary@example.com", role: "admin" as const, sessionId: SESSION_ID };
      if (raw === tokens.member) return { kind: "user" as const, userId: THIRD_USER_ID, organizationId: ORG_ID, email: "member@example.com", role: "member" as const, sessionId: SESSION_ID };
      if (raw === tokens.crossTenantPrimary) return { kind: "user" as const, userId: USER_ID, organizationId: OTHER_ORG_ID, email: "admin@example.com", role: "admin" as const, sessionId: SESSION_ID };
      return null;
    },
  } as AuthenticationService;
  const app = buildAgentApp({
    env: { AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN, AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN },
    authConfig,
    authService,
    repository,
  });
  t.after(async () => { await app.close(); repository.close(); });
  const headers = (token?: string) => ({
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    ...(token ? { cookie: `agent_session=${token}` } : {}),
  });

  assert.equal((await app.inject({ method: "GET", url: "/v1/feedback/mine", headers: headers() })).statusCode, 401);
  const ownList = await app.inject({ method: "GET", url: "/v1/feedback/mine", headers: headers(tokens.ordinary) });
  assert.equal(ownList.statusCode, 200);
  assert.deepEqual(ownList.json().feedback.map((item: { id: string }) => item.id), [feedbackId]);
  const ownDetail = await app.inject({ method: "GET", url: `/v1/feedback/mine/${feedbackId}`, headers: headers(tokens.ordinary) });
  assert.equal(ownDetail.statusCode, 200);
  assert.equal(ownDetail.json().feedback.attachments[0].id, attachmentId);
  const ownAttachment = await app.inject({ method: "GET", url: `/v1/feedback/mine/${feedbackId}/attachments/${attachmentId}`, headers: headers(tokens.ordinary) });
  assert.equal(ownAttachment.statusCode, 200);
  assert.deepEqual(ownAttachment.rawPayload, imageContent);
  assert.equal(ownAttachment.headers["content-type"], "image/png");
  assert.equal(ownAttachment.headers["x-content-type-options"], "nosniff");
  assert.equal(
    ownAttachment.headers["content-disposition"],
    "inline; filename=\"__.png\"; filename*=UTF-8''%E6%88%AA%E5%9B%BE.png",
  );
  assert.match(String(ownAttachment.headers["cache-control"]), /private/);

  for (const url of [
    `/v1/feedback/mine/${feedbackId}`,
    `/v1/feedback/mine/${feedbackId}/attachments/${attachmentId}`,
  ]) {
    assert.equal((await app.inject({ method: "GET", url, headers: headers(tokens.member) })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url, headers: headers(tokens.crossTenantPrimary) })).statusCode, 404);
  }

  assert.equal((await app.inject({ method: "GET", url: "/v1/feedback/admin", headers: headers(tokens.member) })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: "/v1/feedback/admin", headers: headers(tokens.ordinary) })).statusCode, 403);
  assert.deepEqual((await app.inject({ method: "GET", url: "/v1/feedback/admin", headers: headers(tokens.crossTenantPrimary) })).json().feedback, []);
  assert.equal((await app.inject({ method: "GET", url: `/v1/feedback/admin/${feedbackId}`, headers: headers(tokens.crossTenantPrimary) })).statusCode, 404);

  const adminList = await app.inject({ method: "GET", url: "/v1/feedback/admin?status=new", headers: headers(tokens.primary) });
  assert.equal(adminList.statusCode, 200);
  assert.deepEqual(adminList.json().feedback.map((item: { id: string }) => item.id), [feedbackId]);
  const adminDetail = await app.inject({ method: "GET", url: `/v1/feedback/admin/${feedbackId}`, headers: headers(tokens.primary) });
  assert.equal(adminDetail.statusCode, 200);
  const adminAttachment = await app.inject({ method: "GET", url: `/v1/feedback/admin/${feedbackId}/attachments/${attachmentId}`, headers: headers(tokens.primary) });
  assert.equal(adminAttachment.statusCode, 200);
  assert.deepEqual(adminAttachment.rawPayload, imageContent);
  assert.equal((await app.inject({ method: "GET", url: "/v1/feedback/admin/unread-count", headers: headers(tokens.primary) })).json().count, 1);
  assert.equal((await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId }))?.adminSeenAt, null);
  assert.equal((await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId }))?.events.length, 1);

  const seen = await app.inject({ method: "POST", url: `/v1/feedback/admin/${feedbackId}/mark-seen`, headers: headers(tokens.primary), payload: {} });
  assert.deepEqual(seen.json(), { seen: true });
  const seenAgain = await app.inject({ method: "POST", url: `/v1/feedback/admin/${feedbackId}/mark-seen`, headers: headers(tokens.primary), payload: {} });
  assert.deepEqual(seenAgain.json(), { seen: false });
  const changed = await app.inject({ method: "POST", url: `/v1/feedback/admin/${feedbackId}/status`, headers: headers(tokens.primary), payload: { status: "processing", expectedVersion: 1 } });
  assert.equal(changed.statusCode, 200);
  assert.equal(changed.json().feedback.workflowVersion, 2);
  assert.equal(changed.json().feedback.events.at(-1).actorUserId, USER_ID);
  const stale = await app.inject({ method: "POST", url: `/v1/feedback/admin/${feedbackId}/status`, headers: headers(tokens.primary), payload: { status: "resolved", expectedVersion: 1 } });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().error.code, "CONFLICT");
  assert.equal((await repository.getOrganizationFeedbackDetail({ organizationId: ORG_ID, feedbackId }))?.events.length, 2);
  const sameStatus = await app.inject({ method: "POST", url: `/v1/feedback/admin/${feedbackId}/status`, headers: headers(tokens.primary), payload: { status: "processing", expectedVersion: 2 } });
  assert.equal(sameStatus.statusCode, 200);
  assert.equal(sameStatus.json().feedback.workflowVersion, 2);
  assert.equal(sameStatus.json().feedback.events.length, 2);
});

test("multipart feedback is narrowly bounded, sanitized before persistence, and keeps generic failures", async (t) => {
  const { repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "member@example.com", displayName: "Member", passwordHash: "hash", createdAt: NOW });
  const authService = {
    async authenticate(raw: string | null) {
      return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, email: "member@example.com", role: "member" as const, sessionId: SESSION_ID } : null;
    },
  } as AuthenticationService;
  const app = buildAgentApp({ env: { AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN, AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN }, authConfig, authService, repository });
  t.after(async () => { await app.close(); repository.close(); });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const baseFields = [
    ["category", "bug"],
    ["title", "Screenshot"],
    ["description", "中".repeat(2_000)],
    ["pagePath", "/projects?secret=must-not-persist"],
  ] as const;
  const multipart = multipartBody(baseFields, [{ name: "shot.png", type: "image/png", content: image }]);
  const headers = { origin: ORIGIN, "x-agent-proxy-token": PROXY_TOKEN, cookie: `agent_session=${RAW_TOKEN}`, "content-type": multipart.contentType };
  const created = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: multipart.payload });
  assert.equal(created.statusCode, 200);
  const feedbackId = created.json().feedbackId as string;
  const detail = (await app.inject({ method: "GET", url: `/v1/feedback/mine/${feedbackId}`, headers: { ...headers, "content-type": "application/json" } })).json().feedback;
  assert.equal(detail.description, "中".repeat(2_000));
  assert.equal(detail.pagePath, "/projects");
  assert.equal(detail.attachments.length, 1);
  assert.equal("imageContent" in detail.attachments[0], false);

  const fourFiles = multipartBody(baseFields, Array.from({ length: 4 }, (_, index) => ({ name: `shot-${index}.png`, type: "image/png", content: image })));
  const tooMany = await app.inject({ method: "POST", url: "/v1/feedback", headers: { ...headers, "content-type": fourFiles.contentType }, payload: fourFiles.payload });
  assert.equal(tooMany.statusCode, 400);
  assert.equal(tooMany.json().error.message, "Request validation failed");

  const duplicateField = multipartBody([...baseFields, ["title", "spoofed"]], []);
  assert.equal((await app.inject({ method: "POST", url: "/v1/feedback", headers: { ...headers, "content-type": duplicateField.contentType }, payload: duplicateField.payload })).statusCode, 400);
  const truncatedName = multipartBody([["x".repeat(101), "value"], ...baseFields], []);
  assert.equal((await app.inject({ method: "POST", url: "/v1/feedback", headers: { ...headers, "content-type": truncatedName.contentType }, payload: truncatedName.payload })).statusCode, 400);
  const invalidImage = multipartBody(baseFields, [{ name: "forged.png", type: "image/png", content: Buffer.from("not-an-image") }]);
  const invalid = await app.inject({ method: "POST", url: "/v1/feedback", headers: { ...headers, "content-type": invalidImage.contentType }, payload: invalidImage.payload });
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.json().error.message, "Request validation failed");
  assert.doesNotMatch(JSON.stringify(invalid.json()), /sharp|decode|stack|imageContent/i);
  assert.equal((await repository.listOwnFeedback({ organizationId: ORG_ID, actorUserId: USER_ID })).length, 1);
});

test("dedicated feedback JSON accepts at most three raw images of at most 5 MiB", async (t) => {
  const { repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "member@example.com", displayName: "Member", passwordHash: "hash", createdAt: NOW });
  const authService = {
    async authenticate(raw: string | null) {
      return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, email: "member@example.com", role: "member" as const, sessionId: SESSION_ID } : null;
    },
  } as AuthenticationService;
  const app = buildAgentApp({ env: { AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN, AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN }, authConfig, authService, repository });
  t.after(async () => { await app.close(); repository.close(); });
  const image = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const transferImage = {
    fileName: "shot.png",
    mediaType: "image/png",
    byteLength: image.byteLength,
    contentBase64: image.toString("base64"),
  };
  const headers = {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    "x-agent-feedback-transfer": "1",
    cookie: `agent_session=${RAW_TOKEN}`,
    "content-type": "application/json",
  };
  const fields = {
    category: "bug",
    title: "Dedicated transfer",
    description: "Reuse the existing sanitizer and repository",
    pagePath: "/projects?secret=removed",
  };

  const created = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: JSON.stringify({ ...fields, images: [transferImage] }) });
  assert.equal(created.statusCode, 200);
  const detail = await repository.getOwnFeedbackDetail({ organizationId: ORG_ID, actorUserId: USER_ID, feedbackId: created.json().feedbackId });
  assert.equal(detail?.pagePath, "/projects");
  assert.equal(detail?.attachments.length, 1);

  const tooMany = await app.inject({ method: "POST", url: "/v1/feedback", headers, payload: JSON.stringify({ ...fields, images: Array.from({ length: 4 }, () => transferImage) }) });
  assert.equal(tooMany.statusCode, 400);
  const oversizedSource = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
  const oversized = await app.inject({
    method: "POST",
    url: "/v1/feedback",
    headers,
    payload: JSON.stringify({
      ...fields,
      images: [{ ...transferImage, byteLength: oversizedSource.byteLength, contentBase64: oversizedSource.toString("base64") }],
    }),
  });
  assert.equal(oversized.statusCode, 400, oversized.payload);
  const wrongRoute = await app.inject({
    method: "POST",
    url: "/v1/auth/login",
    headers,
    payload: JSON.stringify({ ...fields, images: [transferImage] }),
  });
  assert.equal(wrongRoute.statusCode, 400);
  assert.equal((await repository.listOwnFeedback({ organizationId: ORG_ID, actorUserId: USER_ID })).length, 1);
});

test("feedback repository failures return safe generic errors", async (t) => {
  const { repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "member@example.com", displayName: "Member", passwordHash: "hash", createdAt: NOW });
  const authService = { async authenticate(raw: string | null) { return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, email: "member@example.com", role: "member" as const, sessionId: SESSION_ID } : null; } } as AuthenticationService;
  const failingRepository = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "listOwnFeedback") return async () => { throw new Error("postgres://user:password@internal/feedback SQL SELECT secret"); };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const app = buildAgentApp({ env: { AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN, AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN }, authConfig, authService, repository: failingRepository });
  t.after(async () => { await app.close(); repository.close(); });
  const response = await app.inject({ method: "GET", url: "/v1/feedback/mine", headers: { origin: ORIGIN, "x-agent-proxy-token": PROXY_TOKEN, cookie: `agent_session=${RAW_TOKEN}` } });
  assert.equal(response.statusCode, 500);
  assert.equal(response.json().error.message, "Internal server error");
  assert.doesNotMatch(JSON.stringify(response.json()), /postgres|password|SELECT|secret/i);
});
