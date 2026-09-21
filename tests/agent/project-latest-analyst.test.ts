import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { startPostgresTestContainer } from "./helpers/postgres-test-container";
import { readLatestProjectAnalysts } from "../../server/db/project-latest-analyst-repository";
import { createDefaultLocalDataBridgeDeps, registerLocalDataRoutes } from "../../server/routes/local-data";
import type { AnalysisProject } from "../../app/lib/project-server";
import type { RequestPrincipal } from "../../server/auth/authorization";
import { LocalDataCreateProjectRequestSchema, LocalDataUpdateProjectRequestSchema } from "../../shared/agent-contracts";

const now = "2026-09-01T00:00:00.000Z";
const later = "2026-09-02T00:00:00.000Z";
const asins = ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"];

for (const driver of ["sqlite", "postgres"] as const) test(`${driver}: project list derives latest analyst from exact same-organization runs before search and paging`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "project-analyst-"));
  const postgres = driver === "postgres" ? await startPostgresTestContainer() : null;
  if (postgres) await runPostgresMigrations(postgres.pool);
  const repository = postgres ? new PostgresAgentRepository(postgres.createPool()) : openSqliteAgentRepository({ path: join(directory, "test.sqlite"), busyTimeoutMs: 5000 });
  const app = Fastify();
  t.after(async () => { await app.close(); await repository.close(); await postgres?.close(); rmSync(directory, { recursive: true, force: true }); });
  const organizationId = randomUUID(), foreignOrg = randomUUID();
  const creator = randomUUID(), analyst = randomUUID(), foreignUser = randomUUID();
  for (const [id, org, displayName] of [[creator, organizationId, "旧分析人"], [analyst, organizationId, "可信分析人"], [foreignUser, foreignOrg, "其他团队秘密姓名"]]) {
    await repository.createUser({ id, organizationId: org, displayName, email: `${id}@example.com`, role: "member", status: "active", createdAt: now, updatedAt: now });
  }
  const analyzed = randomUUID(), noRuns = randomUUID(), crossActor = randomUUID(), crossProject = randomUUID();
  for (const id of [analyzed, noRuns, crossActor, crossProject]) {
    await repository.createProject({ id, organizationId: id === crossProject ? foreignOrg : organizationId, name: "灯具", marketplace: "US", asins, createdBy: id === crossProject ? foreignUser : creator, createdAt: now, updatedAt: now });
  }
  for (const [projectId, createdBy, createdAt] of [[analyzed, analyst, later], [analyzed, creator, now], [crossActor, foreignUser, later], [crossActor, creator, now], [crossProject, foreignUser, now]]) {
    const id = randomUUID();
    await repository.createAnalysisRun({ id, projectId, createdBy: postgres && projectId === crossActor ? creator : createdBy, createdAt, updatedAt: createdAt, mode: "existing-data", status: "queued", dataCutoffAt: createdAt, idempotencyScope: projectId, idempotencyKey: id });
    // Model historical corrupt linkage; normal PostgreSQL writes already reject it.
    if (postgres && projectId === crossActor && createdBy === foreignUser) await postgres.pool.query("UPDATE analysis_runs SET created_by = $1 WHERE id = $2", [foreignUser, id]);
  }
  const projects: AnalysisProject[] = [analyzed, noRuns, crossActor, crossProject, "legacy-non-uuid"].map((id, index) => ({
    id, kind: "analysis", slug: `project-${index}`, name: "灯具", marketplace: "US", asins, majorCategory: null, categoryLabel: null,
    note: null, createdBy: "用户随意填写", latestAnalystName: "文件伪造姓名", createdAt: now, updatedAt: index ? now : later,
  }));
  projects.push({ ...projects[0], id: randomUUID(), kind: "checklist", sourceProjectId: analyzed, updatedAt: now });
  let principal: RequestPrincipal | null = { kind: "user", userId: creator, organizationId, role: "member", email: `${creator}@example.com`, sessionId: randomUUID() };
  app.decorateRequest("authPrincipal", null);
  app.addHook("onRequest", async request => { request.authPrincipal = principal; });
  let writes = 0;
  registerLocalDataRoutes(app, {
    ...createDefaultLocalDataBridgeDeps(repository, { env: { AGENT_DATA_ROOT: directory } }),
    fetchProjects: async () => projects, fetchProject: async id => projects.find(p => p.id === id) ?? null,
    createAnalysisProject: async () => { writes++; return projects[0]; },
    updateAnalysisProject: async () => { writes++; return projects[0]; },
  });
  const listed = await app.inject({ method: "GET", url: "/v1/local-data/projects?page=1&pageSize=2&sort=updated_desc" });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().projects[0].latestAnalystName, "可信分析人");
  assert.equal(listed.json().pagination.total, 6);
  const all = (await app.inject({ method: "GET", url: "/v1/local-data/projects" })).json().projects;
  assert.ok(all.filter((p: AnalysisProject) => p.id !== analyzed).every((p: AnalysisProject) => p.latestAnalystName === null));
  assert.equal(JSON.stringify(all).includes("其他团队秘密姓名"), false);
  assert.equal(JSON.stringify(all).includes("文件伪造姓名"), false);
  const searched = (await app.inject({ method: "GET", url: `/v1/local-data/projects?search=${encodeURIComponent("可信分析人")}&page=3&pageSize=1&sort=created_asc` })).json();
  assert.equal(searched.pagination.total, 1);
  assert.equal(searched.pagination.page, 1);
  assert.equal(searched.projects[0].id, analyzed);
  const batch = await repository.listLatestProjectAnalysts({ organizationId, projectIds: [...Array.from({ length: 401 }, () => randomUUID()), analyzed] });
  assert.deepEqual(batch, [{ projectId: analyzed, displayName: "可信分析人" }]);
  assert.equal((await app.inject({ method: "GET", url: `/v1/local-data/projects/${analyzed}` })).json().project.latestAnalystName, "可信分析人");
  for (const method of ["POST", "PATCH"] as const) {
    const url = `/v1/local-data/projects${method === "PATCH" ? `/${analyzed}` : ""}`;
    const payload = { name: "灯具", asins };
    const forged = await app.inject({ method, url, payload: { ...payload, latestAnalystName: "伪造" } });
    assert.equal(forged.statusCode, 400, forged.body);
    assert.equal(writes, method === "POST" ? 0 : 1);
    const valid = await app.inject({ method, url, payload });
    assert.equal(valid.statusCode, method === "POST" ? 201 : 200, valid.body);
    assert.equal(valid.json().project.latestAnalystName, "可信分析人");
  }
  principal = { kind: "anonymous-loopback" };
  assert.ok((await app.inject({ method: "GET", url: "/v1/local-data/projects" })).json().projects.every((p: AnalysisProject) => p.latestAnalystName === null));
});

test("latest analyst queries deduplicate ids and bound batches without interpolating caller input", async () => {
  for (const dialect of ["sqlite", "postgres"] as const) {
    const sizes: number[] = [];
    const maliciousId = "' OR 1=1 --";
    const projectIds = Array.from({ length: 401 }, (_, i) => String(i));
    await readLatestProjectAnalysts({ organizationId: "organization", projectIds: [...projectIds, ...projectIds, maliciousId] }, dialect, async (sql, values) => {
      assert.equal(sql.includes(maliciousId), false);
      assert.equal(values[0], "organization");
      sizes.push(values.length - 1);
      return [];
    });
    assert.deepEqual(sizes, [200, 200, 2]);
    await readLatestProjectAnalysts({ organizationId: "organization", projectIds: [] }, dialect, async () => { assert.fail("Empty list should not query"); });
  }
});

test("latest analyst is read-only in both project write contracts", () => {
  assert.equal(LocalDataCreateProjectRequestSchema.safeParse({ name: "灯具", asins, latestAnalystName: "伪造" }).success, false);
  assert.equal(LocalDataUpdateProjectRequestSchema.safeParse({ latestAnalystName: "伪造" }).success, false);
});
