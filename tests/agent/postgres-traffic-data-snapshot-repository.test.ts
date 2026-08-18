import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import { buildTrafficSnapshotCandidate } from "../../server/data/traffic-data-snapshot";
import {
  DataSnapshotCutoffConflictError,
  DataSnapshotSubjectNotFoundError,
} from "../../server/db/data-snapshot-repository";
import {
  PostgresCoreStore,
} from "../../server/db/postgres/core-store";
import { PostgresDataSnapshotStore } from "../../server/db/postgres/data-snapshot-store";
import { PostgresTrafficDataSnapshotStore } from "../../server/db/postgres/traffic-data-snapshot-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import {
  TrafficDataSnapshotConflictError,
  TrafficDataSnapshotDataError,
  type CreateTrafficDataSnapshotForRunInput,
} from "../../server/db/traffic-data-snapshot-repository";
import { buildDeterministicTrafficInput } from "../../server/domain/traffic/traffic-analysis-contracts";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const createdAt = "2026-08-15T00:00:00.000Z";
const targetAsins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"] as const;

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

interface RepositoryBundle {
  pool: Pool;
  queries: PostgresQueryContext;
  core: PostgresCoreStore;
  trafficSnapshots: PostgresTrafficDataSnapshotStore;
  vocSnapshots: PostgresDataSnapshotStore;
}

interface SeededTarget {
  organizationId: string;
  actorId: string;
  projectId: string;
  runId: string;
}

async function freshRepository(): Promise<RepositoryBundle> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  const pool = postgres.createPool({ searchPath: schema });
  await runPostgresMigrations(pool);
  const queries = new PostgresQueryContext(pool);
  return {
    pool,
    queries,
    core: new PostgresCoreStore(queries),
    trafficSnapshots: new PostgresTrafficDataSnapshotStore(queries),
    vocSnapshots: new PostgresDataSnapshotStore(queries),
  };
}

function siblingRepository(pool: Pool): Pick<RepositoryBundle, "queries" | "core" | "trafficSnapshots"> {
  const queries = new PostgresQueryContext(pool);
  return {
    queries,
    core: new PostgresCoreStore(queries),
    trafficSnapshots: new PostgresTrafficDataSnapshotStore(queries),
  };
}

async function seedTarget(
  repository: Pick<RepositoryBundle, "core">,
  overrides: Partial<SeededTarget> = {},
): Promise<SeededTarget> {
  const organizationId = overrides.organizationId ?? randomUUID();
  const actorId = overrides.actorId ?? randomUUID();
  const projectId = overrides.projectId ?? randomUUID();
  const runId = overrides.runId ?? randomUUID();
  await repository.core.createUser({
    id: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    displayName: "Traffic snapshot actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createProject({
    id: projectId,
    organizationId,
    name: "Traffic snapshot target",
    marketplace: "US",
    asins: [...targetAsins],
    createdBy: actorId,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: createdAt,
    idempotencyScope: `traffic-snapshot:${runId}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  return { organizationId, actorId, projectId, runId };
}

function trafficCandidate() {
  return trafficCandidateAt(createdAt);
}

function trafficCandidateAt(dataCutoffAt: string) {
  return buildTrafficSnapshotCandidate({
    asins: targetAsins,
    trafficInput: buildDeterministicTrafficInput({
      marketplace: "US",
      asins: targetAsins,
      dataCutoffAt,
    }),
  });
}

function changedTrafficCandidate() {
  const candidate = trafficCandidate();
  return buildTrafficSnapshotCandidate({
    asins: candidate.asins,
    trafficInput: candidate.payload.input,
    sources: [
      { ...candidate.sources[0]!, checksum: "a".repeat(64) },
      candidate.sources[1]!,
    ],
  });
}

function createInput(
  target: SeededTarget,
  overrides: Partial<CreateTrafficDataSnapshotForRunInput> = {},
): CreateTrafficDataSnapshotForRunInput {
  return {
    actorId: target.actorId,
    actorOrganizationId: target.organizationId,
    runId: target.runId,
    expectedProjectId: target.projectId,
    expectedMarketplace: "US",
    expectedAsins: [...targetAsins],
    expectedRunCutoffAt: createdAt,
    candidateId: randomUUID(),
    createdAt,
    candidate: trafficCandidate(),
    ...overrides,
  };
}

test("PostgreSQL traffic snapshots persist, freeze, and isolate by organization and kind", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const first = await repository.trafficSnapshots.createTrafficDataSnapshotForRun(
    createInput(target),
  );
  const replay = await repository.trafficSnapshots.createTrafficDataSnapshotForRun(
    createInput(target, {
      expectedRunCutoffAt: "2026-08-14T20:00:00-04:00",
    }),
  );

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(first.snapshot.kind, "traffic");
  assert.equal(first.snapshot.dataCutoffAt, createdAt);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(Object.isFrozen(first.snapshot.payload.input.competitors[0]), true);
  assert.deepEqual(
    await repository.trafficSnapshots.findTrafficDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: first.snapshot.id,
    }),
    first.snapshot,
  );
  assert.deepEqual(
    await repository.trafficSnapshots.listTrafficDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [first.snapshot],
  );
  assert.equal(
    await repository.trafficSnapshots.findTrafficDataSnapshotById({
      actorOrganizationId: randomUUID(),
      snapshotId: first.snapshot.id,
    }),
    null,
  );
  assert.deepEqual(
    await repository.trafficSnapshots.listTrafficDataSnapshotsByRun({
      actorOrganizationId: randomUUID(),
      runId: target.runId,
    }),
    [],
  );

  assert.equal(
    await repository.vocSnapshots.findDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: first.snapshot.id,
    }),
    null,
  );
});

test("PostgreSQL traffic snapshots are idempotent and detect semantic hash conflicts across pools", async () => {
  const repository = await freshRepository();
  const competitorPool = postgres.createPool({
    searchPath: await currentSchema(repository.pool),
  });
  const competitor = siblingRepository(competitorPool);
  const target = await seedTarget(repository);

  const sameHash = await Promise.allSettled([
    repository.trafficSnapshots.createTrafficDataSnapshotForRun(createInput(target)),
    competitor.trafficSnapshots.createTrafficDataSnapshotForRun(
      createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
    ),
  ]);
  assert.equal(sameHash.filter(({ status }) => status === "fulfilled").length, 2);
  const successes = sameHash.map((result) => {
    assert.equal(result.status, "fulfilled");
    return result.value;
  });
  assert.equal(successes.filter(({ created }) => created).length, 1);
  assert.equal(successes.filter(({ created }) => !created).length, 1);
  assert.equal(successes[0]!.snapshot.id, successes[1]!.snapshot.id);

  const driftTarget = await seedTarget(repository);
  const differentHash = await Promise.allSettled([
    repository.trafficSnapshots.createTrafficDataSnapshotForRun(createInput(driftTarget)),
    competitor.trafficSnapshots.createTrafficDataSnapshotForRun(
      createInput(driftTarget, { candidate: changedTrafficCandidate() }),
    ),
  ]);
  assert.equal(
    differentHash.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  assert.ok(
    differentHash.some(
      (result) =>
        result.status === "rejected" &&
        result.reason instanceof TrafficDataSnapshotConflictError,
    ),
  );
});

test("PostgreSQL traffic snapshots validate trusted subject, cutoff, and rollback", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);

  for (const input of [
    createInput(target, { actorOrganizationId: randomUUID() }),
    createInput(target, { runId: randomUUID() }),
    createInput(target, { expectedProjectId: randomUUID() }),
    createInput(target, { expectedMarketplace: "CA" }),
    createInput(target, {
      expectedAsins: [targetAsins[1]!, targetAsins[0]!, targetAsins[2]!],
    }),
    createInput(target, { actorId: randomUUID() }),
  ]) {
    await assert.rejects(
      repository.trafficSnapshots.createTrafficDataSnapshotForRun(input),
      DataSnapshotSubjectNotFoundError,
    );
  }
  await assert.rejects(
    repository.trafficSnapshots.createTrafficDataSnapshotForRun(
      createInput(target, {
        expectedRunCutoffAt: "2026-08-16T00:00:00.000Z",
      }),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  await assert.rejects(
    repository.trafficSnapshots.createTrafficDataSnapshotForRun(
      createInput(target, {
        candidate: trafficCandidateAt("2026-08-16T00:00:00.000Z"),
      }),
    ),
    DataSnapshotCutoffConflictError,
  );
  await assert.rejects(
    repository.queries.transaction(async () => {
      await repository.trafficSnapshots.createTrafficDataSnapshotForRun(
        createInput(target),
      );
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.deepEqual(
    await repository.trafficSnapshots.listTrafficDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("PostgreSQL traffic snapshot reader rejects tampered JSON rows", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const created = await repository.trafficSnapshots.createTrafficDataSnapshotForRun(
    createInput(target),
  );
  await repository.pool.query("DROP TRIGGER data_snapshots_update_immutable ON data_snapshots");
  try {
    await repository.pool.query(
      "UPDATE data_snapshots SET payload_json = '{}'::jsonb WHERE id = $1",
      [created.snapshot.id],
    );
    await assert.rejects(
      repository.trafficSnapshots.findTrafficDataSnapshotById({
        actorOrganizationId: target.organizationId,
        snapshotId: created.snapshot.id,
      }),
      TrafficDataSnapshotDataError,
    );
  } finally {
    await repository.pool.query(
      `CREATE TRIGGER data_snapshots_update_immutable
       BEFORE UPDATE ON data_snapshots
       FOR EACH ROW EXECUTE FUNCTION prevent_data_snapshot_mutation()`,
    );
  }
});

async function currentSchema(pool: Pool): Promise<string> {
  const result = await pool.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  );
  const schema = result.rows[0]?.schema;
  assert.ok(schema);
  return schema;
}
