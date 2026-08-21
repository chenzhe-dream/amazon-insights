import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import type { Pool } from "pg";

import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
  type CreateDataSnapshotForRunInput,
} from "../../server/db/data-snapshot-repository";
import { PostgresAgentRunStore } from "../../server/db/postgres/agent-run-store";
import { PostgresCoreStore } from "../../server/db/postgres/core-store";
import { PostgresDataSnapshotStore } from "../../server/db/postgres/data-snapshot-store";
import { PostgresJobStore } from "../../server/db/postgres/job-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import { PostgresQueryContext } from "../../server/db/postgres/query-context";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
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
  snapshots: PostgresDataSnapshotStore;
  core: PostgresCoreStore;
  jobs: PostgresJobStore;
  agentRuns: PostgresAgentRunStore;
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
    snapshots: new PostgresDataSnapshotStore(queries),
    core: new PostgresCoreStore(queries),
    jobs: new PostgresJobStore(queries),
    agentRuns: new PostgresAgentRunStore(queries),
  };
}

function siblingRepository(pool: Pool): Omit<RepositoryBundle, "pool"> {
  const queries = new PostgresQueryContext(pool);
  return {
    queries,
    snapshots: new PostgresDataSnapshotStore(queries),
    core: new PostgresCoreStore(queries),
    jobs: new PostgresJobStore(queries),
    agentRuns: new PostgresAgentRunStore(queries),
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
    displayName: "Snapshot actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.core.createProject({
    id: projectId,
    organizationId,
    name: "VOC snapshot target",
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
    idempotencyScope: `snapshot:${runId}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  return { organizationId, actorId, projectId, runId };
}

function snapshotCandidate() {
  const candidate = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins: [...targetAsins],
    dataCutoffAt: createdAt,
  }).candidate;
  assert.ok(candidate);
  return candidate;
}

function createInput(
  target: SeededTarget,
  overrides: Partial<CreateDataSnapshotForRunInput> = {},
): CreateDataSnapshotForRunInput {
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
    candidate: snapshotCandidate(),
    ...overrides,
  };
}

function changedCandidate() {
  const candidate = snapshotCandidate();
  return buildVocSnapshotCandidate({
    marketplace: candidate.marketplace,
    asins: candidate.asins,
    dataCutoffAt: candidate.dataCutoffAt,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: candidate.sources[0]!.marketplace,
        capturedAt: candidate.sources[0]!.capturedAt,
        records: [
          {
            ...candidate.payload.records.alexaVoc[0]!,
            positives: ["semantic drift"],
          },
          ...candidate.payload.records.alexaVoc.slice(1),
        ],
      },
      {
        sourceId: "sorftime-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: candidate.sources[1]!.marketplace,
        capturedAt: candidate.sources[1]!.capturedAt,
        records: candidate.payload.records.sorftimeReviewAnalysis,
      },
      {
        sourceId: "seller-sprite-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: candidate.sources[2]!.marketplace,
        capturedAt: candidate.sources[2]!.capturedAt,
        records: candidate.payload.records.sellerSpriteReviewAnalysis,
      },
    ],
  });
}

function validCandidateAt(dataCutoffAt: string) {
  const candidate = snapshotCandidate();
  return buildVocSnapshotCandidate({
    marketplace: candidate.marketplace,
    asins: candidate.asins,
    dataCutoffAt,
    sourceBundles: [
      {
        sourceId: "alexa-voc",
        type: "manual-voc",
        reference: VOC_SOURCE_REFERENCES.alexaVoc,
        marketplace: candidate.sources[0]!.marketplace,
        capturedAt: candidate.sources[0]!.capturedAt,
        records: candidate.payload.records.alexaVoc,
      },
      {
        sourceId: "sorftime-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis,
        marketplace: candidate.sources[1]!.marketplace,
        capturedAt: candidate.sources[1]!.capturedAt,
        records: candidate.payload.records.sorftimeReviewAnalysis,
      },
      {
        sourceId: "seller-sprite-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        marketplace: candidate.sources[2]!.marketplace,
        capturedAt: candidate.sources[2]!.capturedAt,
        records: candidate.payload.records.sellerSpriteReviewAnalysis,
      },
    ],
  });
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

test("PostgreSQL VOC snapshots persist, canonicalize, freeze, and isolate reads by organization", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const first = await repository.snapshots.createDataSnapshotForRun(
    createInput(target),
  );
  const offsetReplay = await repository.snapshots.createDataSnapshotForRun(
    createInput(target, {
      expectedRunCutoffAt: "2026-08-14T20:00:00-04:00",
      candidate: {
        ...snapshotCandidate(),
        dataCutoffAt: "2026-08-15T00:00:00Z",
      },
    }),
  );

  assert.equal(first.created, true);
  assert.equal(offsetReplay.created, false);
  assert.equal(offsetReplay.snapshot.id, first.snapshot.id);
  assert.equal(first.snapshot.dataCutoffAt, createdAt);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.equal(
    Object.isFrozen(first.snapshot.payload.records.alexaVoc[0]),
    true,
  );
  assert.deepEqual(
    await repository.snapshots.findDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: first.snapshot.id,
    }),
    first.snapshot,
  );
  assert.deepEqual(
    await repository.snapshots.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [first.snapshot],
  );
  assert.equal(
    await repository.snapshots.findDataSnapshotById({
      actorOrganizationId: randomUUID(),
      snapshotId: first.snapshot.id,
    }),
    null,
  );
  assert.deepEqual(
    await repository.snapshots.listDataSnapshotsByRun({
      actorOrganizationId: randomUUID(),
      runId: target.runId,
    }),
    [],
  );
});

test("PostgreSQL VOC snapshot semantic identity is idempotent and detects content drift", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const first = await repository.snapshots.createDataSnapshotForRun(
    createInput(target),
  );
  const replay = await repository.snapshots.createDataSnapshotForRun(
    createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
  );

  assert.equal(replay.created, false);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(replay.snapshot.createdAt, first.snapshot.createdAt);
  await assert.rejects(
    repository.snapshots.createDataSnapshotForRun(
      createInput(target, { candidate: changedCandidate() }),
    ),
    DataSnapshotConflictError,
  );
  assert.equal(
    (
      await repository.snapshots.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      })
    ).length,
    1,
  );
});

test("two PostgreSQL pools serialize same-hash and different-hash snapshot races", async () => {
  const repository = await freshRepository();
  const competitorPool = postgres.createPool({
    searchPath: await currentSchema(repository.pool),
  });
  const competitor = siblingRepository(competitorPool);
  const target = await seedTarget(repository);

  const sameHash = await Promise.allSettled([
    repository.snapshots.createDataSnapshotForRun(createInput(target)),
    competitor.snapshots.createDataSnapshotForRun(
      createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
    ),
  ]);
  assert.equal(sameHash.filter(({ status }) => status === "fulfilled").length, 2);
  const sameSuccesses = sameHash.map((result) => {
    assert.equal(result.status, "fulfilled");
    return result.value;
  });
  assert.equal(sameSuccesses.filter(({ created }) => created).length, 1);
  assert.equal(sameSuccesses.filter(({ created }) => !created).length, 1);
  assert.equal(sameSuccesses[0]!.snapshot.id, sameSuccesses[1]!.snapshot.id);

  const driftTarget = await seedTarget(repository);
  const differentHash = await Promise.allSettled([
    repository.snapshots.createDataSnapshotForRun(createInput(driftTarget)),
    competitor.snapshots.createDataSnapshotForRun(
      createInput(driftTarget, { candidate: changedCandidate() }),
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
        result.reason instanceof DataSnapshotConflictError,
    ),
  );
  assert.equal(
    (
      await repository.snapshots.listDataSnapshotsByRun({
        actorOrganizationId: driftTarget.organizationId,
        runId: driftTarget.runId,
      })
    ).length,
    1,
  );
});

test("PostgreSQL VOC snapshots fail closed for untrusted subjects and participate in rollback", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const transientActorId = randomUUID();
  await repository.core.createUser({
    id: transientActorId,
    organizationId: target.organizationId,
    email: `${transientActorId}@example.com`,
    displayName: "Transient actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  const invalidInputs: CreateDataSnapshotForRunInput[] = [
    createInput(target, { actorOrganizationId: randomUUID() }),
    createInput(target, { runId: randomUUID() }),
    createInput(target, { expectedProjectId: randomUUID() }),
    createInput(target, { expectedMarketplace: "CA" }),
    createInput(target, {
      expectedAsins: [targetAsins[1]!, targetAsins[0]!, targetAsins[2]!],
    }),
    createInput(target, { expectedRunCutoffAt: "2026-08-16T00:00:00.000Z" }),
    createInput(target, { actorId: randomUUID() }),
  ];
  await repository.pool.query(
    "UPDATE users SET status = 'disabled' WHERE id = $1",
    [transientActorId],
  );
  invalidInputs.push(createInput(target, { actorId: transientActorId }));

  for (const input of invalidInputs) {
    await assert.rejects(
      repository.snapshots.createDataSnapshotForRun(input),
      DataSnapshotSubjectNotFoundError,
    );
  }
  await assert.rejects(
    repository.snapshots.createDataSnapshotForRun(
      createInput(target, {
        candidate: validCandidateAt("2026-08-16T00:00:00.000Z"),
      }),
    ),
    DataSnapshotCutoffConflictError,
  );
  await assert.rejects(
    repository.queries.transaction(async () => {
      await repository.snapshots.createDataSnapshotForRun(createInput(target));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.deepEqual(
    await repository.snapshots.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("PostgreSQL VOC snapshot reader rejects tampered stored rows after trigger bypass and restore", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const created = await repository.snapshots.createDataSnapshotForRun(
    createInput(target),
  );
  await repository.pool.query("DROP TRIGGER data_snapshots_update_immutable ON data_snapshots");
  try {
    await repository.pool.query(
      "UPDATE data_snapshots SET payload_json = '{}'::jsonb WHERE id = $1",
      [created.snapshot.id],
    );
    await assert.rejects(
      repository.snapshots.findDataSnapshotById({
        actorOrganizationId: target.organizationId,
        snapshotId: created.snapshot.id,
      }),
      DataSnapshotDataError,
    );
  } finally {
    await repository.pool.query(
      `CREATE TRIGGER data_snapshots_update_immutable
       BEFORE UPDATE ON data_snapshots
       FOR EACH ROW EXECUTE FUNCTION prevent_data_snapshot_mutation()`,
    );
  }
});

test("PostgreSQL lineage traces snapshot to Job claim to AgentRun audit", async () => {
  const repository = await freshRepository();
  const target = await seedTarget(repository);
  const stageId = randomUUID();
  const jobId = randomUUID();
  await repository.core.createRunStage({
    id: stageId,
    runId: target.runId,
    stage: "voc-positioning",
    status: "queued",
    progress: 0,
    attemptCount: 0,
    startedAt: null,
    completedAt: null,
    lastError: null,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.jobs.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: createdAt,
    createdAt,
  });
  const snapshot = await repository.snapshots.createDataSnapshotForRun(
    createInput(target),
  );
  const claimed = await repository.jobs.claimNextJob({
    ownerId: "snapshot-lineage-worker",
    claimedAt: "2026-08-15T00:00:01.000Z",
    leaseDurationMs: 60_000,
  });
  assert.ok(claimed);
  const skill = await repository.agentRuns.registerSkillVersion({
    id: randomUUID(),
    skillId: "define-amazon-voc-positioning",
    version: "1.0.0",
    contentHash: "c".repeat(64),
    manifest: {
      id: "define-amazon-voc-positioning",
      version: "1.0.0",
      entry: "SKILL.md",
      allowedReferences: ["references/priority-rules.md"],
      inputSchema: "VocPositioningInput@1.0.0",
      outputSchema: "VocPositioningOutput@1.0.0",
      fixtures: ["postgres-snapshot-lineage"],
      contentHash: "c".repeat(64),
    },
    createdAt,
  });
  const begun = await repository.agentRuns.beginAgentRun({
    id: randomUUID(),
    organizationId: target.organizationId,
    runId: target.runId,
    stageId,
    jobAttemptId: claimed.id,
    skillVersionId: skill.id,
    snapshotIds: [snapshot.snapshot.id],
    executionFingerprint: "d".repeat(64),
    logicalExecutionLineage: sha256(`lineage:${stageId}`),
    logicalExecutionCycleId: claimed.logicalExecutionCycleId,
    outputSchemaDigest: "e".repeat(64),
    provider: "fake",
    model: "configured-test-model",
    inputSummary: { contentHash: "f".repeat(64), recordCount: 3 },
    outputSchemaVersion: "1.0.0",
    dataCutoffAt: createdAt,
    startedAt: "2026-08-15T00:00:01.000Z",
    leaseOwnerId: claimed.leasedBy!,
    leaseGeneration: claimed.leaseGeneration,
    claimToken: `claim-${randomUUID()}`,
    claimAcquiredAt: "2026-08-15T00:00:01.000Z",
    claimExpiresAt: "2026-08-15T00:01:00.000Z",
  });
  assert.equal(begun.created, true);
  assert.deepEqual(begun.record.snapshotIds, [snapshot.snapshot.id]);
  const link = await repository.pool.query<{ snapshot_id: string }>(
    "SELECT snapshot_id FROM agent_run_snapshots WHERE agent_run_id = $1",
    [begun.record.id],
  );
  assert.deepEqual(
    link.rows.map(({ snapshot_id }) => snapshot_id),
    [snapshot.snapshot.id],
  );
});

async function currentSchema(pool: Pool): Promise<string> {
  const result = await pool.query<{ schema: string }>(
    "SELECT current_schema() AS schema",
  );
  const schema = result.rows[0]?.schema;
  assert.ok(schema);
  return schema;
}
