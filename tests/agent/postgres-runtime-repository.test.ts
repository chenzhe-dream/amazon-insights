import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  PostgresAgentRepository,
  openPostgresAgentRepository,
} from "../../server/db/postgres-repository";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const now = "2026-08-19T10:00:00.000Z";
const actorId = "81000000-0000-4000-8000-000000000001";
const organizationId = "81000000-0000-4000-8000-000000000002";
const projectId = "81000000-0000-4000-8000-000000000003";
const runId = "81000000-0000-4000-8000-000000000004";
const stageId = "81000000-0000-4000-8000-000000000005";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("PostgreSQL runtime facade opens migrations and shares one transaction context", async () => {
  const schema = await createSchema();
  const repository = await openPostgresAgentRepository({
    connectionString: databaseUrl(postgres.pool, schema),
  });
  assert.ok(repository instanceof PostgresAgentRepository);
  try {
    await seedProject(repository);
    await assert.rejects(
      repository.transaction(async (transactional) => {
        await transactional.createAnalysisRun({
          id: runId,
          projectId,
          mode: "existing-data",
          status: "queued",
          createdBy: actorId,
          dataCutoffAt: now,
          idempotencyScope: "pg-runtime-rollback",
          idempotencyKey: "create",
          createdAt: now,
          updatedAt: now,
        });
        await transactional.createRunStage({
          id: stageId,
          runId,
          stage: "voc-positioning",
          status: "queued",
          progress: 0,
          attemptCount: 0,
          startedAt: null,
          completedAt: null,
          lastError: null,
          createdAt: now,
          updatedAt: now,
        });
        await transactional.enqueueJob({
          id: "81000000-0000-4000-8000-000000000006",
          stageId,
          attemptNumber: 1,
          maxAttempts: 3,
          availableAt: now,
          createdAt: now,
        });
        throw new Error("force rollback");
      }),
      /force rollback/,
    );
    assert.equal(await repository.findAnalysisRun(runId), null);

    const run = await repository.createAnalysisRun({
      id: runId,
      projectId,
      mode: "existing-data",
      status: "queued",
      createdBy: actorId,
      dataCutoffAt: now,
      idempotencyScope: "pg-runtime-create",
      idempotencyKey: "create",
      createdAt: now,
      updatedAt: now,
    });
    await repository.createRunStage({
      id: stageId,
      runId: run.id,
      stage: "voc-positioning",
      status: "queued",
      progress: 0,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    await repository.enqueueJob({
      id: "81000000-0000-4000-8000-000000000007",
      stageId,
      attemptNumber: 1,
      maxAttempts: 3,
      availableAt: now,
      createdAt: now,
    });
    assert.equal(
      (await repository.claimNextJob({
        ownerId: "pg-runtime-worker",
        claimedAt: "2026-08-19T10:00:01.000Z",
        leaseDurationMs: 30_000,
      }))?.stageId,
      stageId,
    );
  } finally {
    await repository.close();
  }
  await assert.rejects(repository.findAnalysisRun(runId));
});

test("PostgreSQL runtime facade fails closed without leaking database URLs", async () => {
  const secretUrl =
    "postgresql://postgres:super-secret-value@127.0.0.1:1/agent";

  await assert.rejects(
    openPostgresAgentRepository({ connectionString: secretUrl }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /super-secret-value/);
      assert.doesNotMatch(error.message, /postgresql:\/\/postgres/i);
      return true;
    },
  );
});

async function seedProject(repository: PostgresAgentRepository) {
  await repository.createUser({
    id: actorId,
    organizationId,
    email: "pg-runtime@example.com",
    displayName: "PG runtime",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "PostgreSQL runtime repository",
    marketplace: "US",
    asins: ["B0RT000001", "B0RT000002", "B0RT000003"],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
}

async function createSchema() {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

function databaseUrl(pool: Pool, schema: string) {
  const options = pool.options as {
    host?: string;
    port?: number;
    user?: string;
    database?: string;
  };
  const url = new URL("postgresql://localhost");
  url.hostname = options.host ?? "127.0.0.1";
  url.port = String(options.port);
  url.username = options.user ?? "postgres";
  url.pathname = `/${options.database}`;
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}
