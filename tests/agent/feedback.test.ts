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
const ORG_ID = "20000000-0000-4000-8000-000000000001";
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
      return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, role: "member" as const, sessionId: SESSION_ID } : null;
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
