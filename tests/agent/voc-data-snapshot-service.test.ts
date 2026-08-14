import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import { deepFreeze } from "../../server/data/voc-data-snapshot";
import {
  VocDataSnapshotService,
  VocDataSnapshotServiceError,
  type VocDataSnapshotLogSummary,
} from "../../server/services/voc-data-snapshot-service";

const cutoff = "2026-08-15T00:00:00.000Z";
const readyAsins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"];
const partialAsins = ["B0D48BPKRH", "B08Z36X6B4", "B0D77D5WKD"];
const missingAsins = ["B000000001", "B000000002", "B000000003"];

function temporaryDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-service-"));
  return { directory, path: join(directory, "agent.sqlite") };
}

async function seedRun(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  asins = readyAsins,
) {
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `snapshot-${actorId}@example.com`,
    displayName: "VOC actor",
    role: "member",
    status: "active",
    createdAt: cutoff,
    updatedAt: cutoff,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "Trusted VOC project",
    marketplace: "US",
    asins,
    createdBy: actorId,
    createdAt: cutoff,
    updatedAt: cutoff,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: cutoff,
    idempotencyScope: `service:${runId}`,
    idempotencyKey: "create",
    createdAt: cutoff,
    updatedAt: cutoff,
  });
  return { organizationId, actorId, projectId, runId, asins };
}

function createService(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  target: Awaited<ReturnType<typeof seedRun>>,
  overrides: Partial<ConstructorParameters<typeof VocDataSnapshotService>[0]> = {},
) {
  return new VocDataSnapshotService({
    repository,
    executionContext: {
      actorId: target.actorId,
      organizationId: target.organizationId,
    },
    now: () => cutoff,
    createId: () => "50000000-0000-4000-8000-000000000001",
    ...overrides,
  });
}

async function createUnreferencedActor(
  repository: ReturnType<typeof openSqliteAgentRepository>,
  organizationId: string,
) {
  const actorId = randomUUID();
  await repository.createUser({
    id: actorId,
    organizationId,
    email: `runtime-${actorId}@example.com`,
    displayName: "Runtime VOC actor",
    role: "member",
    status: "active",
    createdAt: cutoff,
    updatedAt: cutoff,
  });
  return actorId;
}

test("service derives target and cutoff from the trusted run and project", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository);
  const result = await createService(repository, target).createForRun(target.runId);

  assert.equal(result.status, "ready");
  assert.deepEqual(result.missingSources, []);
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.runId, target.runId);
  assert.equal(result.snapshot.marketplace, "US");
  assert.deepEqual(result.snapshot.asins, readyAsins);
  assert.equal(result.snapshot.dataCutoffAt, cutoff);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.snapshot.payload), true);
  assert.equal(createService(repository, target).createForRun.length, 1);
});

test("missing or cross-organization runs are rejected before reading sources", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository);
  let readCount = 0;
  const sourceReader = {
    read() {
      readCount += 1;
      throw new Error("source reader must not be reached");
    },
  };
  const service = createService(repository, target, { sourceReader });
  await assert.rejects(
    service.createForRun(randomUUID()),
    (error: unknown) =>
      error instanceof VocDataSnapshotServiceError && error.code === "NOT_FOUND",
  );

  const otherOrganizationId = randomUUID();
  const otherActorId = randomUUID();
  await repository.createUser({
    id: otherActorId,
    organizationId: otherOrganizationId,
    email: `other-${otherActorId}@example.com`,
    displayName: "Other actor",
    role: "member",
    status: "active",
    createdAt: cutoff,
    updatedAt: cutoff,
  });
  const crossOrganization = new VocDataSnapshotService({
    repository,
    executionContext: {
      actorId: otherActorId,
      organizationId: otherOrganizationId,
    },
    sourceReader,
  });
  await assert.rejects(
    crossOrganization.createForRun(target.runId),
    (error: unknown) =>
      error instanceof VocDataSnapshotServiceError && error.code === "NOT_FOUND",
  );
  assert.equal(readCount, 0);
});

test("partial data persists only available records and returns waiting-input", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository, partialAsins);
  const result = await createService(repository, target).createForRun(target.runId);

  assert.equal(result.status, "waiting-input");
  assert.ok(result.snapshot);
  assert.equal(result.snapshot.sources.length, 1);
  assert.equal(result.snapshot.payload.records.alexaVoc.length, 0);
  assert.equal(result.snapshot.payload.records.sorftimeReviewAnalysis.length, 3);
  assert.equal(result.snapshot.payload.records.sellerSpriteReviewAnalysis.length, 0);
  assert.equal(result.missingSources.length, 6);
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [result.snapshot],
  );
});

test("total data absence returns waiting-input and does not fabricate a snapshot", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository, missingAsins);
  const result = await createService(repository, target).createForRun(target.runId);

  assert.deepEqual(
    { status: result.status, snapshot: result.snapshot },
    { status: "waiting-input", snapshot: null },
  );
  assert.equal(result.missingSources.length, 9);
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("atomic repository revalidation catches project drift after source reading", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository);
  const delegate = new RepositoryVocSourceReader();
  const sourceReader = {
    read(input: Parameters<RepositoryVocSourceReader["read"]>[0]) {
      const result = delegate.read(input);
      const database = new DatabaseSync(path);
      database
        .prepare("UPDATE projects SET asins_json = ? WHERE id = ?")
        .run(JSON.stringify([...readyAsins].reverse()), target.projectId);
      database.close();
      return result;
    },
  };

  await assert.rejects(
    createService(repository, target, { sourceReader }).createForRun(target.runId),
    (error: unknown) =>
      error instanceof VocDataSnapshotServiceError && error.code === "CONFLICT",
  );
});

for (const mutation of ["disable", "delete", "move-organization"] as const) {
  test(`source-time actor ${mutation} is rejected with no snapshot`, async (t) => {
    const { directory, path } = temporaryDatabase();
    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    t.after(() => {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const target = await seedRun(repository);
    const runtimeActorId = await createUnreferencedActor(
      repository,
      target.organizationId,
    );
    const delegate = new RepositoryVocSourceReader();
    const sourceReader = {
      read(input: Parameters<RepositoryVocSourceReader["read"]>[0]) {
        const result = delegate.read(input);
        const database = new DatabaseSync(path);
        if (mutation === "disable") {
          database
            .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
            .run(runtimeActorId);
        } else if (mutation === "delete") {
          database.prepare("DELETE FROM users WHERE id = ?").run(runtimeActorId);
        } else {
          database
            .prepare("UPDATE users SET organization_id = ? WHERE id = ?")
            .run(randomUUID(), runtimeActorId);
        }
        database.close();
        return result;
      },
    };
    const service = createService(repository, target, {
      executionContext: {
        actorId: runtimeActorId,
        organizationId: target.organizationId,
      },
      sourceReader,
    });

    await assert.rejects(
      service.createForRun(target.runId),
      (error: unknown) =>
        error instanceof VocDataSnapshotServiceError && error.code === "CONFLICT",
    );
    assert.deepEqual(
      await repository.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      }),
      [],
    );
  });
}

test("all-missing source reads revalidate actor and project before returning", async (t) => {
  const driftCases = ["actor", "project"] as const;
  for (const drift of driftCases) {
    const { directory, path } = temporaryDatabase();
    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    try {
      const target = await seedRun(repository, missingAsins);
      const runtimeActorId = await createUnreferencedActor(
        repository,
        target.organizationId,
      );
      const delegate = new RepositoryVocSourceReader();
      const sourceReader = {
        read(input: Parameters<RepositoryVocSourceReader["read"]>[0]) {
          const result = delegate.read(input);
          assert.equal(result.candidate, null);
          const database = new DatabaseSync(path);
          if (drift === "actor") {
            database
              .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
              .run(runtimeActorId);
          } else {
            database
              .prepare("UPDATE projects SET marketplace = 'CA' WHERE id = ?")
              .run(target.projectId);
          }
          database.close();
          return result;
        },
      };
      const service = createService(repository, target, {
        executionContext: {
          actorId: runtimeActorId,
          organizationId: target.organizationId,
        },
        sourceReader,
      });

      await assert.rejects(
        service.createForRun(target.runId),
        (error: unknown) =>
          error instanceof VocDataSnapshotServiceError && error.code === "CONFLICT",
      );
      assert.deepEqual(
        await repository.listDataSnapshotsByRun({
          actorOrganizationId: target.organizationId,
          runId: target.runId,
        }),
        [],
      );
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("ordinary logs contain only summary metadata and logger failures are harmless", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository);
  const summaries: VocDataSnapshotLogSummary[] = [];
  const result = await createService(repository, target, {
    logger(summary) {
      summaries.push(summary);
    },
  }).createForRun(target.runId);

  assert.equal(result.status, "ready");
  assert.deepEqual(Object.keys(summaries[0]!).sort(), [
    "contentHashPrefix",
    "recordCount",
    "runId",
    "snapshotId",
    "sourceCount",
  ]);
  assert.deepEqual(summaries[0], {
    runId: target.runId,
    snapshotId: result.snapshot.id,
    sourceCount: 3,
    recordCount: 9,
    contentHashPrefix: result.snapshot.contentHash.slice(0, 12),
  });
  const serialized = JSON.stringify(summaries);
  assert.doesNotMatch(serialized, /结构稳固|review evidence|@example\.com/i);
  assert.equal(serialized.includes(target.organizationId), false);
  assert.equal(serialized.includes(result.snapshot.contentHash), false);

  const replay = await createService(repository, target, {
    logger() {
      throw new Error("logger unavailable");
    },
  }).createForRun(target.runId);
  assert.ok(replay.snapshot);
  assert.equal(replay.snapshot.id, result.snapshot.id);
});

test("waiting-input log is closed and contains no fake hash", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedRun(repository, missingAsins);
  const summaries: VocDataSnapshotLogSummary[] = [];
  const result = await createService(repository, target, {
    logger: (summary) => summaries.push(deepFreeze(summary)),
  }).createForRun(target.runId);

  assert.equal(result.status, "waiting-input");
  assert.deepEqual(summaries, [
    {
      runId: target.runId,
      snapshotId: null,
      sourceCount: 0,
      recordCount: 0,
      contentHashPrefix: null,
    },
  ]);
});
