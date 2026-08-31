import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test, type TestContext } from "node:test";

import {
  ImmutableProjectScopeError,
  LegacyProjectOwnerBindingError,
  ProjectCreationIdempotencyConflictError,
  type AgentRepository,
  type ComparisonProjectRepository,
  type CreateProjectInput,
} from "../../server/db/repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-31T08:00:00.000Z";
const later = "2026-08-31T08:01:00.000Z";
const organizationA = "91000000-0000-4000-8000-000000000001";
const organizationB = "91000000-0000-4000-8000-000000000002";
const operatorA = "91000000-0000-4000-8000-000000000003";
const memberA = "91000000-0000-4000-8000-000000000004";
const disabledA = "91000000-0000-4000-8000-000000000005";
const memberB = "91000000-0000-4000-8000-000000000006";
const projectA = "91000000-0000-4000-8000-000000000007";
const replayProjectA = "91000000-0000-4000-8000-000000000008";
const projectB = "91000000-0000-4000-8000-000000000009";
const idempotencyKey = "comparison.project:0001";
const asins = ["B0AAAA0001", "B0BBBB0002", "B0CCCC0003"];

type ComparisonRepository = AgentRepository & ComparisonProjectRepository;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("SQLite comparison project repository is tenant-scoped, idempotent, and immutable", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "comparison-project-sqlite-"));
  const path = join(directory, "agent.sqlite");
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await exerciseComparisonProjectRepository(t, repository, async () => {
    repository.close();
    repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    return repository;
  });
});

test("PostgreSQL comparison project repository is tenant-scoped, idempotent, and immutable", async (t) => {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  let pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  let repository = new PostgresAgentRepository(pool);
  t.after(async () => {
    await repository.close();
  });

  await exerciseComparisonProjectRepository(t, repository, async () => {
    await repository.close();
    pool = postgres.createPool({ searchPath: schema });
    repository = new PostgresAgentRepository(pool);
    return repository;
  });
});

async function exerciseComparisonProjectRepository(
  _t: TestContext,
  initialRepository: ComparisonRepository,
  reopen: () => Promise<ComparisonRepository>,
): Promise<void> {
  let repository = initialRepository;
  await seedUsers(repository);

  await assert.rejects(
    async () => repository.createProjectOnce({
      idempotencyKey: "short",
      project: projectInput(projectA, organizationA, memberA),
    }),
    TypeError,
  );
  assert.equal(await repository.findProjectById(projectA), null);

  const created = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(projectA, organizationA, memberA),
  });
  assert.equal(created.created, true);
  assert.equal(created.project.id, projectA);

  repository = await reopen();
  const replayed = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(replayProjectA, organizationA, memberA),
  });
  assert.equal(replayed.created, false);
  assert.equal(replayed.project.id, projectA);
  assert.deepEqual(replayed.project.asins, asins);

  await assert.rejects(
    repository.createProjectOnce({
      idempotencyKey,
      project: { ...projectInput(replayProjectA, organizationA, memberA), name: "Changed payload" },
    }),
    ProjectCreationIdempotencyConflictError,
  );

  const isolated = await repository.createProjectOnce({
    idempotencyKey,
    project: projectInput(projectB, organizationB, memberB),
  });
  assert.equal(isolated.created, true);
  assert.equal(isolated.project.organizationId, organizationB);

  await assert.rejects(
    repository.updateProjectMetadata({
      organizationId: organizationA,
      projectId: projectA,
      marketplace: "US",
      updatedAt: later,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableProjectScopeError);
      assert.equal(error.code, "IMMUTABLE_SCOPE");
      return true;
    },
  );
  await assert.rejects(
    repository.updateProjectMetadata({
      organizationId: organizationA,
      projectId: projectA,
      asins: [...asins].reverse(),
      updatedAt: later,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ImmutableProjectScopeError);
      assert.equal(error.code, "IMMUTABLE_SCOPE");
      return true;
    },
  );

  const renamed = await repository.updateProjectMetadata({
    organizationId: organizationA,
    projectId: projectA,
    name: "Renamed comparison",
    updatedAt: later,
  });
  assert.equal(renamed?.name, "Renamed comparison");
  assert.deepEqual(renamed?.asins, asins);

  const bound = await repository.bindLegacyProjectOwnerOnce({
    legacyProjectId: "legacy-project-one",
    organizationId: organizationA,
    ownerUserId: memberA,
    operatorUserId: operatorA,
    boundAt: now,
  });
  assert.equal(bound.created, true);
  const rebound = await repository.bindLegacyProjectOwnerOnce({
    legacyProjectId: "legacy-project-one",
    organizationId: organizationA,
    ownerUserId: memberA,
    operatorUserId: operatorA,
    boundAt: later,
  });
  assert.equal(rebound.created, false);
  assert.deepEqual(await repository.findLegacyProjectOwnerBinding("legacy-project-one"), bound.binding);

  await assert.rejects(
    repository.bindLegacyProjectOwnerOnce({
      legacyProjectId: "legacy-disabled-owner",
      organizationId: organizationA,
      ownerUserId: disabledA,
      operatorUserId: operatorA,
      boundAt: now,
    }),
    LegacyProjectOwnerBindingError,
  );
}

async function seedUsers(repository: ComparisonRepository): Promise<void> {
  await repository.createUser({
    id: operatorA,
    organizationId: organizationA,
    email: "operator-a@example.test",
    displayName: "Operator A",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: memberA,
    organizationId: organizationA,
    email: "member-a@example.test",
    displayName: "Member A",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: disabledA,
    organizationId: organizationA,
    email: "disabled-a@example.test",
    displayName: "Disabled A",
    role: "member",
    status: "disabled",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createUser({
    id: memberB,
    organizationId: organizationB,
    email: "member-b@example.test",
    displayName: "Member B",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

function projectInput(
  id: string,
  organizationId: string,
  createdBy: string,
): CreateProjectInput {
  return {
    id,
    organizationId,
    name: "Comparison project",
    marketplace: "US",
    asins: [...asins],
    createdBy,
    createdAt: now,
    updatedAt: now,
  };
}
