import assert from "node:assert/strict";
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

test("authenticated route derives actor and org, strips URL query, and never stores request secrets", async (t) => {
  const { path, repository } = fixture();
  await repository.createInitialAdmin({ id: USER_ID, organizationId: ORG_ID, email: "admin@example.test", displayName: "Admin", passwordHash: "hash", createdAt: NOW });
  const authService = {
    async authenticate(raw: string | null) {
      return raw === RAW_TOKEN ? { kind: "user" as const, userId: USER_ID, organizationId: ORG_ID, role: "admin" as const, sessionId: SESSION_ID } : null;
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

  repository.close();
  const database = new DatabaseSync(path, { readOnly: true });
  const rows = database.prepare("SELECT * FROM user_feedback").all();
  database.close();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.organization_id, ORG_ID);
  assert.equal(rows[0]!.actor_user_id, USER_ID);
  assert.equal(rows[0]!.page_path, "/projects");
  assert.doesNotMatch(JSON.stringify(rows), /must-never-store|token=/);
});
