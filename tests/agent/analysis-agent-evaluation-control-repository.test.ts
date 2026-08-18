import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS,
  createAnalysisAgentHumanRating,
  createAnalysisAgentModuleModeEvent,
  resolveAnalysisAgentModuleMode,
} from "../../server/evaluation/analysis-agent-human-review";

const CREATED_AT = "2026-08-18T10:00:00.000Z";
const ORGANIZATION_A = "20000000-0000-4000-8000-000000000001";
const ORGANIZATION_B = "20000000-0000-4000-8000-000000000002";
const ACTOR_A = "20000000-0000-4000-8000-000000000003";
const ACTOR_B = "20000000-0000-4000-8000-000000000004";
const DISABLED_ACTOR_A = "20000000-0000-4000-8000-000000000005";

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-agent-evaluation-control-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedActors(repository: ReturnType<typeof openSqliteAgentRepository>) {
  await repository.createUser({
    id: ACTOR_A,
    organizationId: ORGANIZATION_A,
    email: "reviewer-a@example.com",
    displayName: "Reviewer A",
    role: "admin",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createUser({
    id: DISABLED_ACTOR_A,
    organizationId: ORGANIZATION_A,
    email: "disabled-reviewer-a@example.com",
    displayName: "Disabled Reviewer A",
    role: "admin",
    status: "disabled",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  await repository.createUser({
    id: ACTOR_B,
    organizationId: ORGANIZATION_B,
    email: "reviewer-b@example.com",
    displayName: "Reviewer B",
    role: "admin",
    status: "active",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
}

function humanRating(id: string, organizationId = ORGANIZATION_A, actorUserId = ACTOR_A) {
  return createAnalysisAgentHumanRating({
    id,
    organizationId,
    actorUserId,
    module: "voc-positioning",
    evalSetVersion: "openspec-9.1.0",
    caseId: "scooter-complete",
    skill: {
      id: "define-amazon-voc-positioning",
      version: "1.0.0",
      contentHash: "a".repeat(64),
    },
    model: { provider: "fixture", model: "deterministic" },
    reportId: "20000000-0000-4000-8000-000000000010",
    scores: Object.fromEntries(
      ANALYSIS_AGENT_HUMAN_RATING_DIMENSIONS.map((dimension) => [dimension, 4]),
    ),
    comment: "Approved baseline",
    createdAt: CREATED_AT,
  });
}

function modeEvent(
  id: string,
  mode: "legacy-primary" | "agent-shadow",
  organizationId = ORGANIZATION_A,
  actorUserId = ACTOR_A,
  createdAt = CREATED_AT,
) {
  return createAnalysisAgentModuleModeEvent({
    id,
    organizationId,
    actorUserId,
    module: "voc-positioning",
    mode,
    reason: mode === "agent-shadow" ? "Start background comparison" : "Immediate rollback",
    createdAt,
  });
}

test("SQLite appends immutable human ratings and lists only the requested organization", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);

  const first = humanRating("20000000-0000-4000-8000-000000000011");
  const second = humanRating(
    "20000000-0000-4000-8000-000000000012",
    ORGANIZATION_B,
    ACTOR_B,
  );
  assert.deepEqual(await repository.appendAnalysisAgentHumanRating(first), first);
  assert.deepEqual(await repository.appendAnalysisAgentHumanRating(second), second);
  await assert.rejects(() => repository.appendAnalysisAgentHumanRating(first));

  assert.deepEqual(
    await repository.listAnalysisAgentHumanRatings({
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    [first],
  );
  assert.deepEqual(
    await repository.listAnalysisAgentHumanRatings({
      organizationId: ORGANIZATION_B,
      module: "voc-positioning",
    }),
    [second],
  );
});

test("latest module event follows append order and rollback takes effect immediately", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);

  const shadow = modeEvent(
    "20000000-0000-4000-8000-000000000021",
    "agent-shadow",
    ORGANIZATION_A,
    ACTOR_A,
    "2026-08-18T10:02:00.000Z",
  );
  const rollback = modeEvent("20000000-0000-4000-8000-000000000020", "legacy-primary");
  await repository.appendAnalysisAgentModuleMode(shadow);
  assert.deepEqual(
    await resolveAnalysisAgentModuleMode(repository, {
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    { module: "voc-positioning", mode: "agent-shadow", source: "event" },
  );

  // IDs and timestamps deliberately sort in the opposite order. Database
  // append order must win so an emergency rollback is visible immediately
  // even when a prior writer's clock was ahead.
  await repository.appendAnalysisAgentModuleMode(rollback);
  assert.deepEqual(
    await repository.findLatestAnalysisAgentModuleMode({
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    rollback,
  );
  assert.deepEqual(
    await resolveAnalysisAgentModuleMode(repository, {
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    { module: "voc-positioning", mode: "legacy-primary", source: "event" },
  );
  assert.equal(
    await repository.findLatestAnalysisAgentModuleMode({
      organizationId: ORGANIZATION_B,
      module: "voc-positioning",
    }),
    null,
  );
});

test("malformed latest mode metadata fails closed without using an older shadow event", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);
  await repository.appendAnalysisAgentModuleMode(
    modeEvent("20000000-0000-4000-8000-000000000031", "agent-shadow"),
  );

  const inspector = new DatabaseSync(path);
  inspector.prepare(
    `INSERT INTO audit_events
     (id, organization_id, actor_user_id, action, target_type, target_id,
      metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "20000000-0000-4000-8000-000000000032",
    ORGANIZATION_A,
    ACTOR_A,
    "analysis-agent.module-mode-set",
    "analysis-module",
    "voc-positioning",
    JSON.stringify({ mode: "agent-primary", reason: "damaged state" }),
    "2026-08-18T10:01:00.000Z",
  );
  inspector.close();

  assert.equal(
    await repository.findLatestAnalysisAgentModuleMode({
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    null,
  );
  assert.deepEqual(
    await resolveAnalysisAgentModuleMode(repository, {
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    { module: "voc-positioning", mode: "legacy-primary", source: "default" },
  );
});

test("cross-organization and disabled actors cannot append ratings or module modes", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await seedActors(repository);
  const baseline = modeEvent(
    "20000000-0000-4000-8000-000000000040",
    "legacy-primary",
  );
  await repository.appendAnalysisAgentModuleMode(baseline);

  await assert.rejects(() => repository.appendAnalysisAgentHumanRating(
    humanRating("20000000-0000-4000-8000-000000000041", ORGANIZATION_A, ACTOR_B),
  ));
  await assert.rejects(() => repository.appendAnalysisAgentModuleMode(
    modeEvent("20000000-0000-4000-8000-000000000042", "agent-shadow", ORGANIZATION_A, ACTOR_B),
  ));
  await assert.rejects(() => repository.appendAnalysisAgentHumanRating(
    humanRating(
      "20000000-0000-4000-8000-000000000043",
      ORGANIZATION_A,
      DISABLED_ACTOR_A,
    ),
  ));
  await assert.rejects(() => repository.appendAnalysisAgentModuleMode(
    modeEvent(
      "20000000-0000-4000-8000-000000000044",
      "agent-shadow",
      ORGANIZATION_A,
      DISABLED_ACTOR_A,
    ),
  ));

  const inspector = new DatabaseSync(path, { readOnly: true });
  const eventCount = Number((inspector.prepare(
    `SELECT COUNT(*) AS count FROM audit_events WHERE organization_id = ?`,
  ).get(ORGANIZATION_A) as { count: number }).count);
  inspector.close();
  assert.equal(eventCount, 1);
  assert.deepEqual(
    await repository.findLatestAnalysisAgentModuleMode({
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    baseline,
  );
  assert.deepEqual(
    await repository.listAnalysisAgentHumanRatings({
      organizationId: ORGANIZATION_A,
      module: "voc-positioning",
    }),
    [],
  );
});
