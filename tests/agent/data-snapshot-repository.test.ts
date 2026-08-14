import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DataSnapshotConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
  type CreateDataSnapshotForRunInput,
  type DataSnapshotRepository,
} from "../../server/db/data-snapshot-repository";
import {
  openSqliteAgentRepository,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";

const createdAt = "2026-08-15T00:00:00.000Z";
const targetAsins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"];

interface SeededTarget {
  organizationId: string;
  projectId: string;
  runId: string;
}

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-snapshot-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedTarget(
  repository: SqliteAgentRepository,
  overrides: Partial<SeededTarget> = {},
): Promise<SeededTarget> {
  const organizationId = overrides.organizationId ?? randomUUID();
  const projectId = overrides.projectId ?? randomUUID();
  const runId = overrides.runId ?? randomUUID();
  const userId = randomUUID();
  await repository.createUser({
    id: userId,
    organizationId,
    email: `${userId}@example.com`,
    displayName: "Snapshot actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "VOC snapshot target",
    marketplace: "US",
    asins: targetAsins,
    createdBy: userId,
    createdAt,
    updatedAt: createdAt,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: userId,
    dataCutoffAt: createdAt,
    idempotencyScope: `snapshot:${runId}`,
    idempotencyKey: "create",
    createdAt,
    updatedAt: createdAt,
  });
  return { organizationId, projectId, runId };
}

function snapshotCandidate() {
  const candidate = new RepositoryVocSourceReader().read({
    marketplace: "US",
    asins: targetAsins,
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
    actorOrganizationId: target.organizationId,
    runId: target.runId,
    expectedProjectId: target.projectId,
    expectedMarketplace: "US",
    expectedAsins: targetAsins,
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
        capturedAt: candidate.sources[1]!.capturedAt,
        records: candidate.payload.records.sorftimeReviewAnalysis,
      },
      {
        sourceId: "seller-sprite-review-analysis",
        type: "connector",
        reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis,
        capturedAt: candidate.sources[2]!.capturedAt,
        records: candidate.payload.records.sellerSpriteReviewAnalysis,
      },
    ],
  });
}

test("snapshot persistence is strict, deeply immutable, and restart-safe", async (t) => {
  const { directory, path } = temporaryDatabase();
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(repository);
  const input = createInput(target);
  const creation = await repository.createDataSnapshotForRun(input);

  assert.equal(creation.created, true);
  assert.equal(creation.snapshot.id, input.candidateId);
  assert.equal(creation.snapshot.runId, target.runId);
  assert.equal(creation.snapshot.contentHash, input.candidate.contentHash);
  assert.deepEqual(creation.snapshot.asins, targetAsins);
  assert.equal(Object.isFrozen(creation.snapshot), true);
  assert.equal(Object.isFrozen(creation.snapshot.payload.records.alexaVoc[0]), true);

  repository.close();
  const inspector = new DatabaseSync(path, { readOnly: true });
  const row = inspector
    .prepare(
      `SELECT schema_version, marketplace, asins_json, sources_json,
              payload_json, content_hash
       FROM data_snapshots WHERE id = ?`,
    )
    .get(input.candidateId) as Record<string, string>;
  assert.equal(row.schema_version, "1.0.0");
  assert.equal(row.marketplace, "US");
  assert.deepEqual(JSON.parse(row.asins_json), targetAsins);
  assert.deepEqual(JSON.parse(row.sources_json), input.candidate.sources);
  assert.deepEqual(JSON.parse(row.payload_json), input.candidate.payload);
  assert.equal(row.content_hash, input.candidate.contentHash);
  inspector.close();

  repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(
    await repository.findDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: input.candidateId,
    }),
    creation.snapshot,
  );
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [creation.snapshot],
  );
  assert.equal(
    await repository.findDataSnapshotById({
      actorOrganizationId: randomUUID(),
      snapshotId: input.candidateId,
    }),
    null,
  );
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: randomUUID(),
      runId: target.runId,
    }),
    [],
  );
});

test("same semantic identity is idempotent and content drift conflicts", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedTarget(repository);
  const first = await repository.createDataSnapshotForRun(createInput(target));
  const replay = await repository.createDataSnapshotForRun(
    createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
  );

  assert.equal(first.created, true);
  assert.equal(replay.created, false);
  assert.equal(replay.snapshot.id, first.snapshot.id);
  assert.equal(replay.snapshot.createdAt, first.snapshot.createdAt);
  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, { candidate: changedCandidate() }),
    ),
    DataSnapshotConflictError,
  );
  assert.equal(
    (
      await repository.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      })
    ).length,
    1,
  );
});

test("two SQLite connections create one consistent semantic identity", async (t) => {
  const { directory, path } = temporaryDatabase();
  const firstRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(firstRepository);
  const secondRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    firstRepository.close();
    secondRepository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const [first, second] = await Promise.all([
    firstRepository.createDataSnapshotForRun(createInput(target)),
    secondRepository.createDataSnapshotForRun(
      createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
    ),
  ]);

  assert.equal(Number(first.created) + Number(second.created), 1);
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal(first.snapshot.contentHash, second.snapshot.contentHash);
  assert.equal(
    (
      await firstRepository.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      })
    ).length,
    1,
  );
});

test("atomic create revalidates organization, project target, and cutoff", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedTarget(repository);
  const invalidInputs: CreateDataSnapshotForRunInput[] = [
    createInput(target, { actorOrganizationId: randomUUID() }),
    createInput(target, { runId: randomUUID() }),
    createInput(target, { expectedProjectId: randomUUID() }),
    createInput(target, { expectedMarketplace: "CA" }),
    createInput(target, {
      expectedAsins: [targetAsins[1]!, targetAsins[0]!, targetAsins[2]!],
    }),
    createInput(target, { expectedRunCutoffAt: "2026-08-16T00:00:00.000Z" }),
    createInput(target, {
      candidate: {
        ...snapshotCandidate(),
        dataCutoffAt: "2026-08-16T00:00:00.000Z",
      },
    }),
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      repository.createDataSnapshotForRun(input),
      DataSnapshotSubjectNotFoundError,
    );
  }
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("snapshot insertion participates in caller rollback", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedTarget(repository);

  await assert.rejects(
    repository.transaction(async () => {
      await repository.createDataSnapshotForRun(createInput(target));
      throw new Error("force rollback");
    }),
    /force rollback/,
  );
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("database triggers reject mutation, deletion, and parent cascade", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(repository);
  const creation = await repository.createDataSnapshotForRun(createInput(target));
  repository.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const database = new DatabaseSync(path);
  database.exec("PRAGMA foreign_keys = ON");
  assert.throws(
    () =>
      database
        .prepare("UPDATE data_snapshots SET payload_json = '{}' WHERE id = ?")
        .run(creation.snapshot.id),
    /data snapshots are immutable/i,
  );
  assert.throws(
    () =>
      database
        .prepare("DELETE FROM data_snapshots WHERE id = ?")
        .run(creation.snapshot.id),
    /data snapshots are immutable/i,
  );
  assert.throws(
    () =>
      database.prepare("DELETE FROM analysis_runs WHERE id = ?").run(target.runId),
    /data snapshots are immutable/i,
  );
  assert.equal(
    (
      database
        .prepare("SELECT COUNT(*) AS count FROM data_snapshots")
        .get() as { count: number }
    ).count,
    1,
  );
  database.close();
});

test("strict reader rejects stored payload tampering even if a trigger is bypassed", async (t) => {
  const { directory, path } = temporaryDatabase();
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(repository);
  const creation = await repository.createDataSnapshotForRun(createInput(target));
  repository.close();
  const database = new DatabaseSync(path);
  database.exec("DROP TRIGGER data_snapshots_update_immutable");
  database
    .prepare("UPDATE data_snapshots SET payload_json = '{}' WHERE id = ?")
    .run(creation.snapshot.id);
  database.close();

  repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await assert.rejects(
    repository.findDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: creation.snapshot.id,
    }),
    DataSnapshotDataError,
  );
});

test("SQLite repository exposes the domain snapshot contract without diagnostics", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-contract-"));
  const repository: DataSnapshotRepository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  assert.equal(typeof repository.createDataSnapshotForRun, "function");
  assert.equal(typeof repository.findDataSnapshotById, "function");
  assert.equal(typeof repository.listDataSnapshotsByRun, "function");
  (repository as SqliteAgentRepository).close();
});
