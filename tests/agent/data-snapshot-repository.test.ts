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
  database.exec("PRAGMA foreign_keys = ON");
  type RawValue = string | null;
  type RawRow = Record<string, RawValue>;
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
    ["payload JSON null", { payload_json: "null" }],
    ["payload missing kind", { payload_json: withPayload((payload) => delete payload.kind) }],
    ["payload extra key", { payload_json: withPayload((payload) => { payload.extra = true; }) }],
    ["payload marketplace mismatch", { payload_json: withPayload((payload) => { payload.marketplace = "CA"; }) }],
    ["payload records null", { payload_json: withPayload((payload) => { payload.records = null; }) }],
    ["payload records extra key", { payload_json: withPayload((payload) => { (payload.records as Record<string, unknown>).extra = []; }) }],
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
