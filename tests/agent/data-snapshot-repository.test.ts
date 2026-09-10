import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  DataSnapshotConflictError,
  DataSnapshotCutoffConflictError,
  DataSnapshotDataError,
  DataSnapshotSubjectNotFoundError,
  type CreateDataSnapshotForRunInput,
  type DataSnapshotRepository,
} from "../../server/db/data-snapshot-repository";
import {
  openSqliteAgentRepository,
  registerVocSnapshotIntegrityFunction,
  type SqliteAgentRepository,
} from "../../server/db/sqlite-repository";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../../server/data/voc-data-snapshot";
import { repositoryVocCandidateFixture } from "./helpers/voc-positioning-fixture";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";

const createdAt = "2026-08-15T00:00:00.000Z";
const targetAsins = ["B09V5RW2VK", "B07VY9Q95Q", "B0BPXRVWYK"];

interface SeededTarget {
  organizationId: string;
  actorId: string;
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
  return { organizationId, actorId: userId, projectId, runId };
}

function snapshotCandidate() {
  return repositoryVocCandidateFixture(targetAsins, createdAt);
}

function reviewMetricCandidate(kind: "legacy" | "new" | "cs-zero" | "partial" | "arithmetic" | "denominator") {
  const candidate = snapshotCandidate();
  const adapt = (records: typeof candidate.payload.records.sorftimeReviewAnalysis) => records.map((record) => {
    const copy = structuredClone(record);
    const row = copy.blocks[0]!.rows[0]! as Record<string, unknown>;
    if (kind === "legacy") return copy;
    if (kind === "cs-zero") {
      copy.sampledReviews = 0;
      Object.assign(row, { sharePct: 60, metricKind: "customers_say_topic_share", numerator: 60, denominator: 100 });
    } else {
      Object.assign(row, { sharePct: 25, metricKind: "review_sample_incidence", numerator: 1, denominator: 4 });
      copy.sampledReviews = 4;
      if (kind === "partial") delete row.denominator;
      if (kind === "arithmetic") row.sharePct = 90;
      if (kind === "denominator") copy.sampledReviews = 5;
    }
    return copy;
  });
  const sorftime = adapt(candidate.payload.records.sorftimeReviewAnalysis);
  const sellerSprite = adapt(candidate.payload.records.sellerSpriteReviewAnalysis);
  return buildVocSnapshotCandidate({ marketplace: candidate.marketplace, asins: candidate.asins, dataCutoffAt: candidate.dataCutoffAt, sourceBundles: [
    { sourceId: "sorftime-review-analysis", type: "connector", reference: VOC_SOURCE_REFERENCES.sorftimeReviewAnalysis, marketplace: candidate.marketplace, capturedAt: candidate.sources[1]!.capturedAt, records: sorftime },
    { sourceId: "seller-sprite-review-analysis", type: "connector", reference: VOC_SOURCE_REFERENCES.sellerSpriteReviewAnalysis, marketplace: candidate.marketplace, capturedAt: candidate.sources[2]!.capturedAt, records: sellerSprite },
  ] });
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
    expectedAsins: targetAsins,
    expectedRunCutoffAt: createdAt,
    candidateId: randomUUID(),
    createdAt,
    candidate: snapshotCandidate(),
    ...overrides,
  };
}

test("SQLite snapshot adapter accepts legacy, explicit and Customers Say-only rows and rejects invalid provenance", async () => {
  for (const kind of ["legacy", "new", "cs-zero"] as const) {
    const { directory, path } = temporaryDatabase();
    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    const target = await seedTarget(repository);
    const operation = repository.createDataSnapshotForRun(createInput(target, { candidate: reviewMetricCandidate(kind) }));
    await operation;
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
  for (const kind of ["partial", "arithmetic", "denominator"] as const) {
    assert.throws(() => reviewMetricCandidate(kind));
  }
});

test("SQLite VOC trigger applies the review provenance insertion matrix", async () => {
  for (const kind of ["legacy", "new", "cs-zero", "partial", "arithmetic", "denominator"] as const) {
    const { directory, path } = temporaryDatabase();
    const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    const target = await seedTarget(repository);
    repository.close();
    const database = new DatabaseSync(path);
    registerVocSnapshotIntegrityFunction(database);
    database.exec("PRAGMA foreign_keys = ON");
    const candidate = structuredClone(reviewMetricCandidate(kind === "legacy" || kind === "cs-zero" ? kind : "new"));
    if (kind === "partial" || kind === "arithmetic" || kind === "denominator") {
      for (const records of [candidate.payload.records.sorftimeReviewAnalysis, candidate.payload.records.sellerSpriteReviewAnalysis]) {
        for (const record of records) {
          const row = record.blocks[0]!.rows[0]! as Record<string, unknown>;
          if (kind === "partial") delete row.denominator;
          if (kind === "arithmetic") row.sharePct = 90;
          if (kind === "denominator") record.sampledReviews = 5;
        }
      }
      for (const [index, sourceId, records] of [[0, "sorftime-review-analysis", candidate.payload.records.sorftimeReviewAnalysis], [1, "seller-sprite-review-analysis", candidate.payload.records.sellerSpriteReviewAnalysis]] as const) {
        candidate.sources[index]!.checksum = canonicalJsonSha256({ sourceId, marketplace: "US", records });
      }
      candidate.contentHash = canonicalJsonSha256({ schemaVersion: candidate.schemaVersion, marketplace: candidate.marketplace, asins: candidate.asins, dataCutoffAt: candidate.dataCutoffAt, sources: candidate.sources, payload: candidate.payload });
    }
    const values = [randomUUID(), target.runId, candidate.schemaVersion, candidate.marketplace, JSON.stringify(candidate.asins), candidate.dataCutoffAt, JSON.stringify(candidate.sources), JSON.stringify(candidate.payload), candidate.contentHash, createdAt];
    const operation = () => database.prepare(`INSERT INTO data_snapshots (id,run_id,snapshot_kind,artifact_kind,schema_version,marketplace,asins_json,data_cutoff_at,sources_json,payload_json,content_hash,created_at) VALUES (?,?,'voc','voc',?,?,?,?,?,?,?,?)`).run(...values);
    if (["legacy", "new", "cs-zero"].includes(kind)) operation();
    else assert.throws(operation, /invalid VOC data snapshot/i);
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

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

type SnapshotWorkerResult =
  | Readonly<{
      kind: "success";
      created: boolean;
      id: string;
      contentHash: string;
    }>
  | Readonly<{ kind: "conflict" }>;

function startSnapshotWorker(
  path: string,
  input: CreateDataSnapshotForRunInput,
  barrier: SharedArrayBuffer,
) {
  const worker = new Worker(
    new URL("./helpers/sqlite-data-snapshot-worker.ts", import.meta.url),
    {
      workerData: { path, input, barrier },
      execArgv: ["--import", "tsx", "--conditions=react-server"],
    },
  );
  const result = new Promise<SnapshotWorkerResult>((resolve, reject) => {
    let message: SnapshotWorkerResult | undefined;
    worker.once("message", (value) => {
      message = value as SnapshotWorkerResult;
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`snapshot worker exited with ${code}`));
      } else if (!message) {
        reject(new Error("snapshot worker exited without a result"));
      } else {
        resolve(message);
      }
    });
  });
  return { worker, result };
}

async function releaseSnapshotWorkers(
  barrier: Int32Array,
  workers: ReadonlyArray<ReturnType<typeof startSnapshotWorker>>,
) {
  const ready = new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 5_000;
    const poll = () => {
      if (Atomics.load(barrier, 0) === workers.length) {
        resolve();
      } else if (Date.now() >= deadline) {
        reject(new Error("snapshot worker barrier timed out"));
      } else {
        setImmediate(poll);
      }
    };
    poll();
  });
  await Promise.race([
    ready,
    Promise.all(workers.map(({ result }) => result)).then(() => {
      throw new Error("snapshot workers exited before reaching the barrier");
    }),
  ]);
  Atomics.store(barrier, 1, 1);
  Atomics.notify(barrier, 1, workers.length);
}

async function boundedSnapshotResults(
  workers: ReadonlyArray<ReturnType<typeof startSnapshotWorker>>,
) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.all(workers.map(({ result }) => result)),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("snapshot worker result timed out")),
          10_000,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
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

test("equivalent DateTime spellings canonicalize to one semantic identity", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedTarget(repository);
  const canonical = snapshotCandidate();
  const first = await repository.createDataSnapshotForRun(
    createInput(target, { candidate: canonical }),
  );
  const offset = await repository.createDataSnapshotForRun(
    createInput(target, {
      expectedRunCutoffAt: "2026-08-14T20:00:00-04:00",
      candidate: {
        ...canonical,
        dataCutoffAt: "2026-08-14T20:00:00-04:00",
      },
    }),
  );
  const noMilliseconds = await repository.createDataSnapshotForRun(
    createInput(target, {
      expectedRunCutoffAt: "2026-08-15T00:00:00Z",
      candidate: {
        ...canonical,
        dataCutoffAt: "2026-08-15T00:00:00Z",
      },
    }),
  );

  assert.equal(offset.created, false);
  assert.equal(noMilliseconds.created, false);
  assert.equal(offset.snapshot.id, first.snapshot.id);
  assert.equal(noMilliseconds.snapshot.id, first.snapshot.id);
  assert.equal(offset.snapshot.dataCutoffAt, createdAt);
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

test("two worker isolates create one consistent semantic identity", async () => {
  const { directory, path } = temporaryDatabase();
  const seedRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(seedRepository);
  seedRepository.close();
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers = [
    startSnapshotWorker(path, createInput(target), shared),
    startSnapshotWorker(
      path,
      createInput(target, { createdAt: "2026-08-15T00:00:01.000Z" }),
      shared,
    ),
  ];
  try {
    await releaseSnapshotWorkers(barrier, workers);
    const results = await boundedSnapshotResults(workers);
    assert.deepEqual(
      results.map((result) => result.kind).sort(),
      ["success", "success"],
    );
    const successes = results.filter(
      (result): result is Extract<SnapshotWorkerResult, { kind: "success" }> =>
        result.kind === "success",
    );
    assert.equal(successes.filter(({ created }) => created).length, 1);
    assert.equal(successes.filter(({ created }) => !created).length, 1);
    assert.equal(successes[0]!.id, successes[1]!.id);
    assert.equal(successes[0]!.contentHash, successes[1]!.contentHash);

    const inspector = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    try {
      const snapshots = await inspector.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]!.id, successes[0]!.id);
    } finally {
      inspector.close();
    }
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("different hashes racing in worker isolates close as one drift conflict", async () => {
  const { directory, path } = temporaryDatabase();
  const seedRepository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(seedRepository);
  seedRepository.close();
  const shared = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const barrier = new Int32Array(shared);
  const workers = [
    startSnapshotWorker(path, createInput(target), shared),
    startSnapshotWorker(
      path,
      createInput(target, { candidate: changedCandidate() }),
      shared,
    ),
  ];
  try {
    await releaseSnapshotWorkers(barrier, workers);
    const results = await boundedSnapshotResults(workers);
    assert.deepEqual(
      results.map((result) => result.kind).sort(),
      ["conflict", "success"],
    );
    const success = results.find(
      (result): result is Extract<SnapshotWorkerResult, { kind: "success" }> =>
        result.kind === "success",
    );
    assert.ok(success);
    assert.equal(success.created, true);
    const inspector = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
    try {
      const snapshots = await inspector.listDataSnapshotsByRun({
        actorOrganizationId: target.organizationId,
        runId: target.runId,
      });
      assert.equal(snapshots.length, 1);
      assert.equal(snapshots[0]!.id, success.id);
      assert.equal(snapshots[0]!.contentHash, success.contentHash);
    } finally {
      inspector.close();
    }
  } finally {
    Atomics.store(barrier, 1, 1);
    Atomics.notify(barrier, 1, workers.length);
    await Promise.allSettled(workers.map(({ worker }) => worker.terminate()));
    rmSync(directory, { recursive: true, force: true });
  }
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
  ];

  for (const input of invalidInputs) {
    await assert.rejects(
      repository.createDataSnapshotForRun(input),
      DataSnapshotSubjectNotFoundError,
    );
  }
  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, {
        candidate: {
          ...snapshotCandidate(),
          dataCutoffAt: "2026-08-16T00:00:00.000Z",
        },
      }),
    ),
    DataSnapshotCutoffConflictError,
  );
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
});

test("atomic create requires the exact active actor in the trusted organization", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedTarget(repository);
  const transientActorId = randomUUID();
  await repository.createUser({
    id: transientActorId,
    organizationId: target.organizationId,
    email: `${transientActorId}@example.com`,
    displayName: "Transient snapshot actor",
    role: "member",
    status: "active",
    createdAt,
    updatedAt: createdAt,
  });
  const database = new DatabaseSync(path);

  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, { actorId: randomUUID() } as Partial<CreateDataSnapshotForRunInput>),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  database
    .prepare("UPDATE users SET status = 'disabled' WHERE id = ?")
    .run(transientActorId);
  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, { actorId: transientActorId } as Partial<CreateDataSnapshotForRunInput>),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  database
    .prepare("UPDATE users SET status = 'active', organization_id = ? WHERE id = ?")
    .run(randomUUID(), transientActorId);
  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, { actorId: transientActorId } as Partial<CreateDataSnapshotForRunInput>),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  database.prepare("DELETE FROM users WHERE id = ?").run(transientActorId);
  await assert.rejects(
    repository.createDataSnapshotForRun(
      createInput(target, { actorId: transientActorId } as Partial<CreateDataSnapshotForRunInput>),
    ),
    DataSnapshotSubjectNotFoundError,
  );
  database.close();
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
  assert.throws(
    () => database.prepare("DELETE FROM projects WHERE id = ?").run(target.projectId),
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

test("database rejects malformed new VOC rows without NULL or JSON-shape bypasses", async (t) => {
  const { directory, path } = temporaryDatabase();
  const repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(repository);
  const candidate = snapshotCandidate();
  repository.close();
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  const database = new DatabaseSync(path);
  registerVocSnapshotIntegrityFunction(database);
  database.exec("PRAGMA foreign_keys = ON");
  type RawValue = string | null;
  type RawColumn =
    | "id"
    | "run_id"
    | "snapshot_kind"
    | "schema_version"
    | "marketplace"
    | "asins_json"
    | "data_cutoff_at"
    | "sources_json"
    | "payload_json"
    | "content_hash"
    | "created_at";
  type RawRow = Record<RawColumn, RawValue>;
  const base: RawRow = {
    id: randomUUID(),
    run_id: target.runId,
    snapshot_kind: "voc",
    schema_version: candidate.schemaVersion,
    marketplace: candidate.marketplace,
    asins_json: JSON.stringify(candidate.asins),
    data_cutoff_at: candidate.dataCutoffAt,
    sources_json: JSON.stringify(candidate.sources),
    payload_json: JSON.stringify(candidate.payload),
    content_hash: candidate.contentHash,
    created_at: createdAt,
  };
  const insert = database.prepare(
    `INSERT INTO data_snapshots
      (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
       data_cutoff_at, sources_json, payload_json, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const withSource = (change: (source: Record<string, unknown>) => void) => {
    const sources = structuredClone(candidate.sources) as unknown as Array<
      Record<string, unknown>
    >;
    change(sources[0]!);
    return JSON.stringify(sources);
  };
  const withPayload = (change: (payload: Record<string, unknown>) => void) => {
    const payload = structuredClone(candidate.payload) as unknown as Record<
      string,
      unknown
    >;
    change(payload);
    return JSON.stringify(payload);
  };
  type RecordArrayKey =
    | "alexaVoc"
    | "sorftimeReviewAnalysis"
    | "sellerSpriteReviewAnalysis";
  const withRecords = (
    change: (records: Record<string, unknown>) => void,
  ) =>
    withPayload((payload) =>
      change(payload.records as Record<string, unknown>),
    );
  const withRecordValue = (key: RecordArrayKey, value: unknown) =>
    withRecords((records) => {
      const sourceRecords = [...(records[key] as unknown[])];
      sourceRecords[0] = value;
      records[key] = sourceRecords;
    });
  const withRecord = (
    key: RecordArrayKey,
    change: (record: Record<string, unknown>) => void,
  ) =>
    withRecords((records) => {
      const sourceRecords = [...(records[key] as unknown[])];
      const record = structuredClone(sourceRecords[0]) as Record<string, unknown>;
      change(record);
      sourceRecords[0] = record;
      records[key] = sourceRecords;
    });
  const malformedElementCases = ([
    "alexaVoc",
    "sorftimeReviewAnalysis",
    "sellerSpriteReviewAnalysis",
  ] as const).flatMap((key) => [
    [`${key} null element`, { payload_json: withRecordValue(key, null) }],
    [`${key} scalar element`, { payload_json: withRecordValue(key, 7) }],
    [`${key} array element`, { payload_json: withRecordValue(key, []) }],
    [
      `${key} missing ASIN`,
      { payload_json: withRecord(key, (record) => delete record.asin) },
    ],
    [
      `${key} extra field`,
      { payload_json: withRecord(key, (record) => { record.extra = true; }) },
    ],
    [
      `${key} wrong ASIN type`,
      { payload_json: withRecord(key, (record) => { record.asin = 7; }) },
    ],
  ] as ReadonlyArray<readonly [string, Partial<RawRow>]>);
  const withAlexaRecord = (change: (record: Record<string, unknown>) => void) =>
    withRecord("alexaVoc", change);
  const withAlexaReport = (change: (report: Record<string, unknown>) => void) =>
    withAlexaRecord((record) => {
      const report = structuredClone(record.alexaReport) as Record<string, unknown>;
      change(report);
      record.alexaReport = report;
    });
  const withReviewRecord = (
    key: "sorftimeReviewAnalysis" | "sellerSpriteReviewAnalysis",
    change: (record: Record<string, unknown>) => void,
  ) => withRecord(key, change);
  const withReviewBlock = (
    change: (block: Record<string, unknown>) => void,
  ) =>
    withReviewRecord("sorftimeReviewAnalysis", (record) => {
      const blocks = [...(record.blocks as unknown[])];
      const block = structuredClone(blocks[0]) as Record<string, unknown>;
      change(block);
      blocks[0] = block;
      record.blocks = blocks;
    });
  const withReviewRow = (change: (row: Record<string, unknown>) => void) =>
    withReviewBlock((block) => {
      const rows = [...(block.rows as unknown[])];
      const row = structuredClone(rows[0]) as Record<string, unknown>;
      change(row);
      rows[0] = row;
      block.rows = rows;
    });
  const cases: ReadonlyArray<readonly [string, Partial<RawRow>]> = [
    ["noncanonical cutoff", { data_cutoff_at: "2026-08-14T20:00:00-04:00" }],
    ["noncanonical creation", { created_at: "2026-08-15T00:00:00Z" }],
    ["closed kind", { snapshot_kind: "review" }],
    ["null schema", { schema_version: null }],
    ["bad content hash", { content_hash: "A".repeat(64) }],
    ["asins JSON null", { asins_json: "null" }],
    ["sources JSON null", { sources_json: "null" }],
    ["source missing checksum", { sources_json: withSource((source) => delete source.checksum) }],
    ["source checksum JSON null", { sources_json: withSource((source) => { source.checksum = null; }) }],
    ["source wrong type", { sources_json: withSource((source) => { source.type = 7; }) }],
    ["source invalid enum", { sources_json: withSource((source) => { source.type = "repository-data"; }) }],
    ["source extra key", { sources_json: withSource((source) => { source.extra = true; }) }],
    ["source blank reference", { sources_json: withSource((source) => { source.reference = ""; }) }],
    ["source oversized reference", { sources_json: withSource((source) => { source.reference = "x".repeat(501); }) }],
    ["source marketplace mismatch", { sources_json: withSource((source) => { source.marketplace = "CA"; }) }],
    ["source invalid capturedAt", { sources_json: withSource((source) => { source.capturedAt = "not-a-date"; }) }],
    ["source noncanonical capturedAt", { sources_json: withSource((source) => { source.capturedAt = "2026-08-12T19:59:59.999-04:00"; }) }],
    ["source after cutoff", { sources_json: withSource((source) => { source.capturedAt = "2026-08-15T00:00:00.001Z"; }) }],
    ["source bad checksum", { sources_json: withSource((source) => { source.checksum = "g".repeat(64); }) }],
    ["source stale checksum", { sources_json: withSource((source) => { source.checksum = "0".repeat(64); }) }],
    ["stale content hash", { content_hash: "0".repeat(64) }],
    ["payload JSON null", { payload_json: "null" }],
    ["payload missing kind", { payload_json: withPayload((payload) => delete payload.kind) }],
    ["payload extra key", { payload_json: withPayload((payload) => { payload.extra = true; }) }],
    ["payload marketplace mismatch", { payload_json: withPayload((payload) => { payload.marketplace = "CA"; }) }],
    ["payload records null", { payload_json: withPayload((payload) => { payload.records = null; }) }],
    ["payload records extra key", { payload_json: withPayload((payload) => { (payload.records as Record<string, unknown>).extra = []; }) }],
    ...malformedElementCases,
    ["Alexa invalid capture status", { payload_json: withAlexaRecord((record) => { record.captureStatus = "ready"; }) }],
    ["Alexa empty thematic array", { payload_json: withAlexaRecord((record) => { record.attention = []; }) }],
    ["Alexa thematic scalar", { payload_json: withAlexaRecord((record) => { record.positives = "good"; }) }],
    ["Alexa thematic null item", { payload_json: withAlexaRecord((record) => { record.negatives = [null]; }) }],
    ["Alexa thematic empty text", { payload_json: withAlexaRecord((record) => { record.unmet = [""]; }) }],
    ["Alexa report null", { payload_json: withAlexaRecord((record) => { record.alexaReport = null; }) }],
    ["Alexa report missing title", { payload_json: withAlexaReport((report) => delete report.title) }],
    ["Alexa report extra field", { payload_json: withAlexaReport((report) => { report.extra = true; }) }],
    ["Alexa report ASIN mismatch", { payload_json: withAlexaReport((report) => { report.asin = "B000000000"; }) }],
    ["Alexa report rating range", { payload_json: withAlexaReport((report) => { report.rating = 6; }) }],
    ["Alexa report review count integer", { payload_json: withAlexaReport((report) => { report.reviewCount = 1.5; }) }],
    ["Alexa report empty prompt", { payload_json: withAlexaReport((report) => { report.prompt = ""; }) }],
    ["Alexa report invalid optional capture status", { payload_json: withAlexaReport((report) => { report.captureStatus = "ready"; }) }],
    ["review marketplace mismatch", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.marketplace = "CA"; }) }],
    ["review sampled count nonnegative", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.sampledReviews = -1; }) }],
    ["review mention count integer", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.mentionTopics = 1.5; }) }],
    ["review invalid repository date", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.fetchedAt = "2026-02-30"; }) }],
    ["review invalid status", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.status = "pending"; }) }],
    ["review empty optional status message", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.statusMessage = ""; }) }],
    ["review invalid family", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.family = "other"; }) }],
    ["review blocks wrong type", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.blocks = null; }) }],
    ["review block scalar", { payload_json: withReviewRecord("sorftimeReviewAnalysis", (record) => { record.blocks = [7]; }) }],
    ["review block missing key", { payload_json: withReviewBlock((block) => delete block.key) }],
    ["review block extra field", { payload_json: withReviewBlock((block) => { block.extra = true; }) }],
    ["review block invalid key", { payload_json: withReviewBlock((block) => { block.key = "themes"; }) }],
    ["review block empty label", { payload_json: withReviewBlock((block) => { block.label = ""; }) }],
    ["review block rows wrong type", { payload_json: withReviewBlock((block) => { block.rows = null; }) }],
    ["review row null", { payload_json: withReviewBlock((block) => { block.rows = [null]; }) }],
    ["review row missing reason", { payload_json: withReviewRow((row) => delete row.reason) }],
    ["review row extra field", { payload_json: withReviewRow((row) => { row.extra = true; }) }],
    ["review row empty label", { payload_json: withReviewRow((row) => { row.label = ""; }) }],
    ["review row share range", { payload_json: withReviewRow((row) => { row.sharePct = 101; }) }],
    ["review row reason wrong type", { payload_json: withReviewRow((row) => { row.reason = null; }) }],
    ["record outside target ASIN", { payload_json: withAlexaRecord((record) => { record.asin = "B000000000"; (record.alexaReport as Record<string, unknown>).asin = "B000000000"; }) }],
    ["record duplicate ASIN", { payload_json: withRecords((records) => { const rows = [...(records.alexaVoc as unknown[])]; rows[1] = structuredClone(rows[0]); records.alexaVoc = rows; }) }],
    ["record target order reversed", { payload_json: withRecords((records) => { const rows = [...(records.alexaVoc as unknown[])]; [rows[0], rows[1]] = [rows[1], rows[0]]; records.alexaVoc = rows; }) }],
    ["source order swapped", { sources_json: JSON.stringify([candidate.sources[1], candidate.sources[0], candidate.sources[2]]) }],
    ["payload source without provenance", { sources_json: JSON.stringify(candidate.sources.slice(1)) }],
    ["provenance without payload source", { payload_json: withRecords((records) => { records.alexaVoc = []; }) }],
    ["source reference/type mismatch", { sources_json: withSource((source) => { source.type = "connector"; }) }],
    ["source unknown reference", { sources_json: withSource((source) => { source.reference = "app/unknown.ts#data"; }) }],
  ];

  for (const [label, overrides] of cases) {
    const row = { ...base, id: randomUUID(), ...overrides };
    database.exec("SAVEPOINT invalid_voc_row");
    let error: unknown;
    try {
      insert.run(
        row.id,
        row.run_id,
        row.snapshot_kind,
        row.schema_version,
        row.marketplace,
        row.asins_json,
        row.data_cutoff_at,
        row.sources_json,
        row.payload_json,
        row.content_hash,
        row.created_at,
      );
    } catch (caught) {
      error = caught;
    } finally {
      database.exec("ROLLBACK TO invalid_voc_row");
      database.exec("RELEASE invalid_voc_row");
    }
    assert.ok(error, `${label} must be rejected by SQLite`);
    assert.equal(
      (database.prepare("SELECT COUNT(*) AS count FROM data_snapshots WHERE snapshot_kind = 'voc'").get() as { count: number }).count,
      0,
      `${label} must leave no VOC row`,
    );
  }
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

test("VOC reads ignore malformed legacy discriminator rows", async (t) => {
  const { directory, path } = temporaryDatabase();
  let repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  const target = await seedTarget(repository);
  repository.close();

  const database = new DatabaseSync(path);
  const legacySnapshotId = randomUUID();
  registerVocSnapshotIntegrityFunction(database);
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("DROP TRIGGER data_snapshots_legacy_insert_closed");
  database
    .prepare(
      `INSERT INTO data_snapshots
       (id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
        data_cutoff_at, sources_json, payload_json, content_hash, created_at)
       VALUES (?, ?, NULL, 'legacy', 'ZZ', '[]',
               'not-a-date', '[]', '{"poison":true}', 'legacy', ?)`,
    )
    .run(legacySnapshotId, target.runId, createdAt);
  database.close();

  repository = openSqliteAgentRepository({ path, busyTimeoutMs: 5_000 });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  assert.deepEqual(
    await repository.listDataSnapshotsByRun({
      actorOrganizationId: target.organizationId,
      runId: target.runId,
    }),
    [],
  );
  assert.equal(
    await repository.findDataSnapshotById({
      actorOrganizationId: target.organizationId,
      snapshotId: legacySnapshotId,
    }),
    null,
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
