import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";

import type { RequestPrincipal } from "../../server/auth/authorization";
import {
  DataSnapshotDataError,
  type DataSnapshotRepository,
} from "../../server/db/data-snapshot-repository";
import {
  IdempotencyKeyReusedError,
  ManualAlexaVocRepositoryError,
  type ManualAlexaVocRepository,
} from "../../server/db/manual-alexa-voc-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { PostgresCoreStoreError } from "../../server/db/postgres/core-store";
import { PostgresJobStoreError } from "../../server/db/postgres/job-store";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import type {
  AgentRepository,
  ManualAlexaVocRepositoryCapability,
} from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { RepositoryVocSourceReader } from "../../server/data/repository-voc-source";
import type {
  RepositoryVocReadInput,
  RepositoryVocReadResult,
} from "../../server/data/repository-voc-source";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  AnalysisLifecycleError,
  AnalysisRunService,
} from "../../server/services/analysis-run-service";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

type AtomicRepository = AgentRepository &
  DataSnapshotRepository &
  ManualAlexaVocRepositoryCapability;

type RunCreationFaultPhase =
  | "run"
  | "stage"
  | "job"
  | "snapshot"
  | "idempotency-completion";

type AtomicWriteCounts = Readonly<{
  runs: number;
  stages: number;
  jobs: number;
  snapshots: number;
  idempotency: number;
  manualHeads: number;
}>;

const runCreationFaultKinds: Readonly<
  Record<RunCreationFaultPhase, string>
> = Object.freeze({
  run: "connection",
  stage: "permission",
  job: "schema",
  snapshot: "transaction",
  "idempotency-completion": "idempotency-transaction",
});

const ASINS = ["B0ATOM0001", "B0ATOM0002", "B0ATOM0003"] as const;
const SQLITE_CLOCK = "2026-08-31T09:10:11.123Z";
const CREATED_AT = "2026-08-31T08:00:00.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
  await runPostgresMigrations(postgres.pool);
});

after(async () => {
  await postgres?.close();
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function principal(actorId: string, organizationId: string): RequestPrincipal {
  return {
    kind: "user",
    userId: actorId,
    organizationId,
    email: `${actorId}@example.com`,
    role: "member",
    sessionId: randomUUID(),
  };
}

async function seedProject(
  repository: AtomicRepository,
  input: Readonly<{
    organizationId?: string;
    actorId?: string;
    projectId?: string;
    asins?: readonly string[];
    createActor?: boolean;
  }> = {},
) {
  const organizationId = input.organizationId ?? randomUUID();
  const actorId = input.actorId ?? randomUUID();
  const projectId = input.projectId ?? randomUUID();
  const asins = [...(input.asins ?? ASINS)];
  if (input.createActor !== false) {
    await repository.createUser({
      id: actorId,
      organizationId,
      email: `${actorId}@example.com`,
      displayName: "Atomic run actor",
      role: "member",
      status: "active",
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    });
  }
  const project = await repository.createProject({
    id: projectId,
    organizationId,
    name: "Atomic Manual VOC run",
    marketplace: "US",
    asins,
    createdBy: actorId,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  });
  return { organizationId, actorId, projectId, asins, project };
}

function normalizedRecord(asin: string, marker: string) {
  return {
    asin,
    attention: [`attention-${marker}`],
    positives: [`positive-${marker}`],
    negatives: [`negative-${marker}`],
    unmet: [`unmet-${marker}`],
    audiences: [`audience-${marker}`],
    scenarios: [`scenario-${marker}`],
    motives: [`motive-${marker}`],
    captureStatus: "dialog" as const,
    alexaReport: {
      title: `Report ${marker}`,
      asin,
      rating: 4.5,
      reviewCount: 42,
      prompt: "fixture prompt",
      overallConclusion: `conclusion-${marker}`,
    },
  };
}

async function putManualVoc(
  repository: AtomicRepository,
  input: Readonly<{
    organizationId: string;
    actorId: string;
    asin?: string;
    marker: string;
  }>,
) {
  const asin = input.asin ?? ASINS[0];
  const record = normalizedRecord(asin, input.marker);
  return repository.transaction(async (transactionRepository) => {
    const scoped = transactionRepository as AtomicRepository;
    await scoped.manualAlexaVoc.lockScopes({
      organizationId: input.organizationId,
      marketplace: "US",
      asins: [asin],
    });
    const expectedRevision = await scoped.manualAlexaVoc.peekNextRevision({
      organizationId: input.organizationId,
      marketplace: "US",
      asin,
    });
    return scoped.manualAlexaVoc.put({
      organizationId: input.organizationId,
      marketplace: "US",
      asin,
      createdBy: input.actorId,
      expectedRevision,
      normalizedRecord: record,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
      contentHash: canonicalJsonSha256({ record, marker: input.marker }),
      raw: {
        algVersion: "AES-256-GCM/v1",
        keyId: `task-8-${randomUUID()}`,
        wrappedDek: randomBytes(60),
        nonce: randomBytes(12),
        ciphertext: randomBytes(48),
        tag: randomBytes(16),
        aadSha256: canonicalJsonSha256({ asin, marker: input.marker }),
        plaintextBytes: 48,
        plaintextSha256: canonicalJsonSha256(input.marker),
      },
    });
  });
}

function repositoryReader(
  repository: AtomicRepository,
  hook?: (result: RepositoryVocReadResult) => Promise<void> | void,
) {
  const reader = new RepositoryVocSourceReader({
    manualVoc: repository.manualAlexaVoc,
    legacySource: {
      async readIfEligible() {
        return { status: "missing" as const, reason: "not-found" as const };
      },
    },
    reviewSources: {
      sorftime: { meta: { marketplace: "US" }, data: {} },
      sellerSprite: { meta: { marketplace: "US" }, data: {} },
    },
  });
  return {
    async read(input: RepositoryVocReadInput) {
      const result = await reader.read(input);
      await hook?.(result);
      return result;
    },
  };
}

function instrumentRepository(
  repository: AtomicRepository,
  hooks: Readonly<{
    onClock?: () => void;
    onListAtCutoff?: () => void;
    onLockScopes?: () => void;
  }>,
): AtomicRepository {
  const baseManual = repository.manualAlexaVoc;
  const overrides: Pick<
    ManualAlexaVocRepository,
    "readDatabaseClock" | "listAtCutoff" | "lockScopes"
  > = {
    async readDatabaseClock() {
      hooks.onClock?.();
      return baseManual.readDatabaseClock();
    },
    async listAtCutoff(input) {
      hooks.onListAtCutoff?.();
      return baseManual.listAtCutoff(input);
    },
    async lockScopes(input) {
      hooks.onLockScopes?.();
      return baseManual.lockScopes(input);
    },
  };
  const manual: ManualAlexaVocRepository = Object.isFrozen(baseManual)
    ? { ...baseManual, ...overrides }
    : new Proxy(baseManual, {
        get(target, property, receiver) {
          if (property in overrides) {
            return overrides[property as keyof typeof overrides];
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
  const wrapper = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "manualAlexaVoc") return manual;
      if (property === "transaction") {
        return <T>(operation: (transactionRepository: AgentRepository) => Promise<T>) =>
          repository.transaction(() => operation(wrapper));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AtomicRepository;
  return wrapper;
}

function faultAfterRunCreationWrite(
  repository: AtomicRepository,
  phase: RunCreationFaultPhase,
): AtomicRepository {
  let faulted = false;
  const inject = () => {
    if (faulted) return;
    faulted = true;
    const kind = runCreationFaultKinds[phase];
    const error =
      phase === "run" || phase === "stage"
        ? new PostgresCoreStoreError("PostgreSQL core store operation failed")
        : phase === "job"
          ? new PostgresJobStoreError()
          : phase === "snapshot"
            ? new DataSnapshotDataError()
            : new Error();
    error.message = `secret database detail: ${kind} after ${phase}`;
    error.name = `${kind}-store-failure`;
    throw error;
  };
  const baseManual = repository.manualAlexaVoc;
  const completeRunCreation: ManualAlexaVocRepository["completeRunCreation"] =
    async (input) => {
      await baseManual.completeRunCreation(input);
      if (phase === "idempotency-completion") inject();
    };
  const manual: ManualAlexaVocRepository = Object.isFrozen(baseManual)
    ? { ...baseManual, completeRunCreation }
    : new Proxy(baseManual, {
        get(target, property, receiver) {
          if (property === "completeRunCreation") return completeRunCreation;
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
  const wrapper = new Proxy(repository, {
    get(target, property, receiver) {
      if (property === "manualAlexaVoc") return manual;
      if (property === "transaction") {
        return <T>(operation: (transactionRepository: AgentRepository) => Promise<T>) =>
          repository.transaction(() => operation(wrapper));
      }
      const value = Reflect.get(target, property, receiver);
      const propertyPhase =
        property === "createAnalysisRunOnce"
          ? "run"
          : property === "createRunStage"
            ? "stage"
            : property === "enqueueJob"
              ? "job"
              : property === "createDataSnapshotForRun"
                ? "snapshot"
                : null;
      if (propertyPhase === phase && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(target, args);
          inject();
          return result;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as AtomicRepository;
  return wrapper;
}

function readSqliteAtomicWriteCounts(path: string): AtomicWriteCounts {
  const database = new DatabaseSync(path);
  try {
    const row = database
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM analysis_runs) AS runs,
           (SELECT COUNT(*) FROM run_stages) AS stages,
           (SELECT COUNT(*) FROM job_attempts) AS jobs,
           (SELECT COUNT(*) FROM data_snapshots WHERE snapshot_kind = 'voc') AS snapshots,
           (SELECT COUNT(*) FROM run_creation_idempotency) AS idempotency,
           (SELECT COUNT(*) FROM manual_alexa_voc_heads) AS manualHeads`,
      )
      .get() as unknown as AtomicWriteCounts;
    return { ...row };
  } finally {
    database.close();
  }
}

async function readPostgresAtomicWriteCounts(input: Readonly<{
  organizationId: string;
  projectId: string;
  idempotencyKey: string;
}>): Promise<AtomicWriteCounts> {
  const result = await postgres.pool.query<{
    runs: number;
    stages: number;
    jobs: number;
    snapshots: number;
    idempotency: number;
    manual_heads: number;
  }>(
    `SELECT
       (SELECT COUNT(*)::int FROM analysis_runs WHERE project_id = $1) AS runs,
       (SELECT COUNT(*)::int FROM run_stages stage
          JOIN analysis_runs run ON run.id = stage.run_id
         WHERE run.project_id = $1) AS stages,
       (SELECT COUNT(*)::int FROM job_attempts job
          JOIN run_stages stage ON stage.id = job.stage_id
          JOIN analysis_runs run ON run.id = stage.run_id
         WHERE run.project_id = $1) AS jobs,
       (SELECT COUNT(*)::int FROM data_snapshots snapshot
          JOIN analysis_runs run ON run.id = snapshot.run_id
         WHERE run.project_id = $1 AND snapshot.snapshot_kind = 'voc') AS snapshots,
       (SELECT COUNT(*)::int FROM run_creation_idempotency
         WHERE organization_id = $2 AND idempotency_key = $3) AS idempotency,
       (SELECT COUNT(*)::int FROM manual_alexa_voc_heads
         WHERE organization_id = $2) AS manual_heads`,
    [input.projectId, input.organizationId, input.idempotencyKey],
  );
  const row = result.rows[0]!;
  return {
    runs: row.runs,
    stages: row.stages,
    jobs: row.jobs,
    snapshots: row.snapshots,
    idempotency: row.idempotency,
    manualHeads: row.manual_heads,
  };
}

async function captureRejection(operation: Promise<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  assert.fail("Expected operation to reject");
}

function createService(
  repository: AtomicRepository,
  target: Readonly<{ organizationId: string; actorId: string }>,
  sourceReader = repositoryReader(repository),
) {
  return new AnalysisRunService({
    repository,
    executionContext: {
      actorId: target.actorId,
      organizationId: target.organizationId,
    },
    sourceReader,
    createId: randomUUID,
  });
}

function provenanceRevision(snapshot: Readonly<{ sources: readonly unknown[] }>) {
  const source = snapshot.sources[0] as {
    recordProvenance?: readonly { revision: string }[];
  };
  return source.recordProvenance?.[0]?.revision ?? null;
}

test("SQLite creates run, cutoff, stages, jobs, snapshot, and replay in one authority transaction", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-run-atomicity-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(CREATED_AT),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedProject(repository);
  await putManualVoc(repository, { ...target, marker: "sqlite-first" });
  let clockReads = 0;
  let sourceReads = 0;
  const instrumented = instrumentRepository(repository, {
    onClock: () => { clockReads += 1; },
    onListAtCutoff: () => { sourceReads += 1; },
  });
  const lifecycle = createService(instrumented, target);
  const request = {
    principal: principal(target.actorId, target.organizationId),
    projectId: target.projectId,
    mode: "existing-data" as const,
    idempotencyKey: "sqlite-atomic-replay",
  };

  const beforeCreation = Date.now();
  const first = await lifecycle.createRunWithVocSnapshot(request);
  const afterCreation = Date.now();
  const replay = await lifecycle.createRunWithVocSnapshot(request);

  assert.deepEqual(replay, first);
  assert.ok(Date.parse(first.run.dataCutoffAt) >= beforeCreation);
  assert.ok(Date.parse(first.run.dataCutoffAt) <= afterCreation);
  assert.equal(first.snapshot.dataCutoffAt, first.run.dataCutoffAt);
  assert.equal(first.snapshot.createdAt, first.run.dataCutoffAt);
  assert.equal(provenanceRevision(first.snapshot), "1");
  assert.equal(clockReads, 1);
  assert.equal(sourceReads, 1);
  assert.equal((await repository.listAnalysisRuns(target.projectId)).length, 1);
  assert.equal((await repository.listDataSnapshotsByRun({
    actorOrganizationId: target.organizationId,
    runId: first.run.id,
  })).length, 1);
  const stages = await repository.listRunStages(first.run.id);
  assert.equal(stages.length, 3);
  assert.equal((await Promise.all(stages.map((stage) =>
    repository.listJobAttempts(stage.id),
  ))).flat().length, 2);
});

test("same organization key conflicts across immutable project scopes while another organization is isolated", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-run-scope-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(CREATED_AT),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const first = await seedProject(repository);
  const second = await seedProject(repository, {
    organizationId: first.organizationId,
    actorId: first.actorId,
    createActor: false,
  });
  const foreign = await seedProject(repository);
  await putManualVoc(repository, { ...first, marker: "scope-first" });
  await putManualVoc(repository, { ...foreign, marker: "scope-foreign" });
  const key = "organization-wide-key";

  await createService(repository, first).createRunWithVocSnapshot({
    principal: principal(first.actorId, first.organizationId),
    projectId: first.projectId,
    mode: "existing-data",
    idempotencyKey: key,
  });
  await assert.rejects(
    createService(repository, second).createRunWithVocSnapshot({
      principal: principal(second.actorId, second.organizationId),
      projectId: second.projectId,
      mode: "existing-data",
      idempotencyKey: key,
    }),
    IdempotencyKeyReusedError,
  );
  const foreignCreated = await createService(repository, foreign)
    .createRunWithVocSnapshot({
      principal: principal(foreign.actorId, foreign.organizationId),
      projectId: foreign.projectId,
      mode: "existing-data",
      idempotencyKey: key,
    });
  assert.equal(foreignCreated.run.projectId, foreign.projectId);
});

test("legacy core-store run with one immutable snapshot is adapted and replayed before clock/source reads", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-run-legacy-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(CREATED_AT),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedProject(repository);
  await putManualVoc(repository, { ...target, marker: "legacy" });
  const runId = randomUUID();
  const oldRun = await repository.createAnalysisRun({
    id: runId,
    projectId: target.projectId,
    mode: "existing-data",
    status: "queued",
    createdBy: target.actorId,
    dataCutoffAt: SQLITE_CLOCK,
    idempotencyScope: [
      "organization", target.organizationId,
      "actor", target.actorId,
      "project", target.projectId,
    ].join(":"),
    idempotencyKey: "legacy-replay",
    createdAt: SQLITE_CLOCK,
    updatedAt: SQLITE_CLOCK,
  });
  const source = await repositoryReader(repository).read({
    organizationId: target.organizationId,
    marketplace: "US",
    asins: target.asins,
    dataCutoffAt: SQLITE_CLOCK,
  });
  assert.ok(source.candidate);
  const stored = await repository.createDataSnapshotForRun({
    actorId: target.actorId,
    actorOrganizationId: target.organizationId,
    runId,
    expectedProjectId: target.projectId,
    expectedMarketplace: "US",
    expectedAsins: target.asins,
    expectedRunCutoffAt: SQLITE_CLOCK,
    candidateId: randomUUID(),
    createdAt: SQLITE_CLOCK,
    candidate: source.candidate!,
  });
  let clockReads = 0;
  let sourceReads = 0;
  const instrumented = instrumentRepository(repository, {
    onClock: () => { clockReads += 1; },
    onListAtCutoff: () => { sourceReads += 1; },
  });

  const replay = await createService(instrumented, target)
    .createRunWithVocSnapshot({
      principal: principal(target.actorId, target.organizationId),
      projectId: target.projectId,
      mode: "existing-data",
      idempotencyKey: "legacy-replay",
    });

  assert.equal(replay.run.id, oldRun.id);
  assert.equal(replay.snapshot.id, stored.snapshot.id);
  assert.equal(clockReads, 0);
  assert.equal(sourceReads, 0);
});

test("repository failures fail closed and a mismatched session principal is rejected before source work", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "manual-voc-run-fail-closed-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
    nowProvider: () => new Date(CREATED_AT),
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const target = await seedProject(repository);
  let sourceReads = 0;
  const lifecycle = createService(repository, target, {
    async read() {
      sourceReads += 1;
      throw new ManualAlexaVocRepositoryError("connection");
    },
  });
  const request = {
    principal: principal(target.actorId, target.organizationId),
    projectId: target.projectId,
    mode: "existing-data" as const,
    idempotencyKey: "fail-closed",
  };

  await assert.rejects(
    lifecycle.createRunWithVocSnapshot(request),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError &&
      error.statusCode === 503 &&
      error.apiErrorCode === "INFRASTRUCTURE_ERROR",
  );
  assert.equal(sourceReads, 1);
  assert.equal((await repository.listAnalysisRuns(target.projectId)).length, 0);

  await assert.rejects(
    lifecycle.createRunWithVocSnapshot({
      ...request,
      principal: principal(randomUUID(), randomUUID()),
      idempotencyKey: "wrong-session",
    }),
    (error: unknown) =>
      error instanceof AnalysisLifecycleError && error.statusCode === 403,
  );
  assert.equal(sourceReads, 1);
  assert.equal((await repository.listAnalysisRuns(target.projectId)).length, 0);
});

test("SQLite rolls back every post-write run-creation phase and safely retries the same key", async () => {
  const phases: readonly RunCreationFaultPhase[] = [
    "run",
    "stage",
    "job",
    "snapshot",
    "idempotency-completion",
  ];
  for (const phase of phases) {
    const directory = mkdtempSync(join(tmpdir(), `manual-voc-sqlite-${phase}-`));
    const path = join(directory, "agent.sqlite");
    const repository = openSqliteAgentRepository({
      path,
      busyTimeoutMs: 5_000,
      nowProvider: () => new Date(CREATED_AT),
    });
    try {
      const target = await seedProject(repository);
      const head = await putManualVoc(repository, {
        ...target,
        marker: `sqlite-${phase}`,
      });
      const idempotencyKey = `sqlite-rollback-${phase}`;
      const request = {
        principal: principal(target.actorId, target.organizationId),
        projectId: target.projectId,
        mode: "existing-data" as const,
        idempotencyKey,
      };
      const error = await captureRejection(
        createService(
          faultAfterRunCreationWrite(repository, phase),
          target,
        ).createRunWithVocSnapshot(request),
      );

      assert.deepEqual(
        readSqliteAtomicWriteCounts(path),
        {
          runs: 0,
          stages: 0,
          jobs: 0,
          snapshots: 0,
          idempotency: 0,
          manualHeads: 1,
        },
        `SQLite ${phase} failure must roll back every run-owned row`,
      );
      assert.deepEqual(
        await repository.manualAlexaVoc.getCurrent({
          organizationId: target.organizationId,
          marketplace: "US",
          asin: ASINS[0],
        }),
        head.record,
        `SQLite ${phase} failure must not alter the selected Manual VOC head`,
      );
      assert.ok(
        error instanceof AnalysisLifecycleError &&
          error.statusCode === 503 &&
          error.apiErrorCode === "INFRASTRUCTURE_ERROR" &&
          !error.message.includes("secret database detail"),
        `SQLite ${phase} failure must be normalized to a safe typed 503`,
      );

      const retry = await createService(repository, target)
        .createRunWithVocSnapshot(request);
      assert.equal(retry.run.projectId, target.projectId);
      assert.deepEqual(readSqliteAtomicWriteCounts(path), {
        runs: 1,
        stages: 3,
        jobs: 2,
        snapshots: 1,
        idempotency: 1,
        manualHeads: 1,
      });
    } finally {
      repository.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("PostgreSQL rolls back every post-write run-creation phase and safely retries the same key", async () => {
  const phases: readonly RunCreationFaultPhase[] = [
    "run",
    "stage",
    "job",
    "snapshot",
    "idempotency-completion",
  ];
  for (const phase of phases) {
    const repository = new PostgresAgentRepository(postgres.createPool());
    const target = await seedProject(repository);
    const head = await putManualVoc(repository, {
      ...target,
      marker: `postgres-${phase}`,
    });
    const idempotencyKey = `postgres-rollback-${phase}`;
    const request = {
      principal: principal(target.actorId, target.organizationId),
      projectId: target.projectId,
      mode: "existing-data" as const,
      idempotencyKey,
    };
    const error = await captureRejection(
      createService(
        faultAfterRunCreationWrite(repository, phase),
        target,
      ).createRunWithVocSnapshot(request),
    );

    assert.deepEqual(
      await readPostgresAtomicWriteCounts({
        organizationId: target.organizationId,
        projectId: target.projectId,
        idempotencyKey,
      }),
      {
        runs: 0,
        stages: 0,
        jobs: 0,
        snapshots: 0,
        idempotency: 0,
        manualHeads: 1,
      },
      `PostgreSQL ${phase} failure must roll back every run-owned row`,
    );
    assert.deepEqual(
      await repository.manualAlexaVoc.getCurrent({
        organizationId: target.organizationId,
        marketplace: "US",
        asin: ASINS[0],
      }),
      head.record,
      `PostgreSQL ${phase} failure must not alter the selected Manual VOC head`,
    );
    assert.ok(
      error instanceof AnalysisLifecycleError &&
        error.statusCode === 503 &&
        error.apiErrorCode === "INFRASTRUCTURE_ERROR" &&
        !error.message.includes("secret database detail"),
      `PostgreSQL ${phase} failure must be normalized to a safe typed 503`,
    );

    const retry = await createService(repository, target)
      .createRunWithVocSnapshot(request);
    assert.equal(retry.run.projectId, target.projectId);
    assert.deepEqual(
      await readPostgresAtomicWriteCounts({
        organizationId: target.organizationId,
        projectId: target.projectId,
        idempotencyKey,
      }),
      {
        runs: 1,
        stages: 3,
        jobs: 2,
        snapshots: 1,
        idempotency: 1,
        manualHeads: 1,
      },
    );
  }
});

test("PostgreSQL concurrent same-key callers replay one winner and conflicting scope is rejected", async () => {
  const firstRepository = new PostgresAgentRepository(postgres.createPool());
  const secondRepository = new PostgresAgentRepository(postgres.createPool());
  const target = await seedProject(firstRepository);
  const conflictingProject = await seedProject(firstRepository, {
    organizationId: target.organizationId,
    actorId: target.actorId,
    createActor: false,
  });
  await putManualVoc(firstRepository, { ...target, marker: "pg-replay" });
  let clockReads = 0;
  let sourceReads = 0;
  const firstView = instrumentRepository(firstRepository, {
    onClock: () => { clockReads += 1; },
    onListAtCutoff: () => { sourceReads += 1; },
  });
  const secondView = instrumentRepository(secondRepository, {
    onClock: () => { clockReads += 1; },
    onListAtCutoff: () => { sourceReads += 1; },
  });
  const request = {
    principal: principal(target.actorId, target.organizationId),
    projectId: target.projectId,
    mode: "existing-data" as const,
    idempotencyKey: "postgres-concurrent-replay",
  };

  const [first, replay] = await Promise.all([
    createService(firstView, target).createRunWithVocSnapshot(request),
    createService(secondView, target).createRunWithVocSnapshot(request),
  ]);

  assert.deepEqual(replay, first);
  assert.equal(clockReads, 1);
  assert.equal(sourceReads, 1);
  assert.equal((await firstRepository.listAnalysisRuns(target.projectId)).length, 1);
  assert.equal((await firstRepository.listDataSnapshotsByRun({
    actorOrganizationId: target.organizationId,
    runId: first.run.id,
  })).length, 1);
  await assert.rejects(
    createService(firstRepository, conflictingProject).createRunWithVocSnapshot({
      principal: principal(target.actorId, target.organizationId),
      projectId: conflictingProject.projectId,
      mode: "existing-data",
      idempotencyKey: request.idempotencyKey,
    }),
    IdempotencyKeyReusedError,
  );
});

test("PostgreSQL import committed before run scope lock is selected by the atomic snapshot", async () => {
  const importRepository = new PostgresAgentRepository(postgres.createPool());
  const runRepository = new PostgresAgentRepository(postgres.createPool());
  const target = await seedProject(importRepository);
  const importReady = deferred();
  const releaseImport = deferred();
  const runLockAttempted = deferred();
  const runView = instrumentRepository(runRepository, {
    onLockScopes: () => runLockAttempted.resolve(),
  });

  const importing = importRepository.transaction(async (transactionRepository) => {
    const scoped = transactionRepository as AtomicRepository;
    await scoped.manualAlexaVoc.lockScopes({
      organizationId: target.organizationId,
      marketplace: "US",
      asins: [ASINS[0]],
    });
    const expectedRevision = await scoped.manualAlexaVoc.peekNextRevision({
      organizationId: target.organizationId,
      marketplace: "US",
      asin: ASINS[0],
    });
    const record = normalizedRecord(ASINS[0], "import-first");
    await scoped.manualAlexaVoc.put({
      organizationId: target.organizationId,
      marketplace: "US",
      asin: ASINS[0],
      createdBy: target.actorId,
      expectedRevision,
      normalizedRecord: record,
      normalizedSchemaVersion: "alexa-voc-record/v2",
      parserVersion: "deterministic-alexa-parser/v3",
      contentHash: canonicalJsonSha256(record),
      raw: {
        algVersion: "AES-256-GCM/v1",
        keyId: `task-8-${randomUUID()}`,
        wrappedDek: randomBytes(60),
        nonce: randomBytes(12),
        ciphertext: randomBytes(48),
        tag: randomBytes(16),
        aadSha256: canonicalJsonSha256({ asin: ASINS[0] }),
        plaintextBytes: 48,
        plaintextSha256: canonicalJsonSha256("import-first"),
      },
    });
    importReady.resolve();
    await releaseImport.promise;
  });
  await importReady.promise;
  const running = createService(runView, target).createRunWithVocSnapshot({
    principal: principal(target.actorId, target.organizationId),
    projectId: target.projectId,
    mode: "existing-data",
    idempotencyKey: "postgres-import-first",
  });
  let created;
  try {
    await Promise.race([
      runLockAttempted.promise,
      running.then(() => {
        throw new Error("run creation completed before attempting the scope lock");
      }),
    ]);
    releaseImport.resolve();
    await importing;
    created = await running;
  } finally {
    releaseImport.resolve();
    await importing.catch(() => undefined);
  }

  assert.equal(provenanceRevision(created.snapshot), "1");
  assert.ok(created.run.dataCutoffAt >= created.snapshot.sources[0]!.capturedAt);
});

test("PostgreSQL run-fixed cutoff excludes a blocked import until the next run and never mutates the first snapshot", async () => {
  const runRepository = new PostgresAgentRepository(postgres.createPool());
  const importRepository = new PostgresAgentRepository(postgres.createPool());
  const target = await seedProject(runRepository);
  await putManualVoc(runRepository, { ...target, marker: "before-run" });
  const sourceEntered = deferred();
  const releaseSource = deferred();
  const importLockAttempted = deferred();
  const baseReader = repositoryReader(runRepository);
  const heldReader = {
    async read(input: RepositoryVocReadInput) {
      const result = await baseReader.read(input);
      sourceEntered.resolve();
      await releaseSource.promise;
      return result;
    },
  };
  const importView = instrumentRepository(importRepository, {
    onLockScopes: () => importLockAttempted.resolve(),
  });

  const firstRunPromise = createService(runRepository, target, heldReader)
    .createRunWithVocSnapshot({
      principal: principal(target.actorId, target.organizationId),
      projectId: target.projectId,
      mode: "existing-data",
      idempotencyKey: "postgres-run-first",
    });
  let importing: Promise<unknown> | undefined;
  let firstRun;
  try {
    await Promise.race([
      sourceEntered.promise,
      firstRunPromise.then(() => {
        throw new Error("run creation completed before entering the held source read");
      }),
    ]);
    importing = putManualVoc(importView, { ...target, marker: "after-cutoff" });
    await Promise.race([
      importLockAttempted.promise,
      importing.then(() => {
        throw new Error("import completed before attempting the scope lock");
      }),
    ]);
    releaseSource.resolve();
    firstRun = await firstRunPromise;
    await importing;
  } finally {
    releaseSource.resolve();
    await firstRunPromise.catch(() => undefined);
    await importing?.catch(() => undefined);
  }
  const firstSnapshotBeforeReplay = await runRepository.findDataSnapshotById({
    actorOrganizationId: target.organizationId,
    snapshotId: firstRun.snapshot.id,
  });
  const nextRun = await createService(runRepository, target)
    .createRunWithVocSnapshot({
      principal: principal(target.actorId, target.organizationId),
      projectId: target.projectId,
      mode: "existing-data",
      idempotencyKey: "postgres-after-import",
    });
  const firstSnapshotAfterNextRun = await runRepository.findDataSnapshotById({
    actorOrganizationId: target.organizationId,
    snapshotId: firstRun.snapshot.id,
  });

  assert.equal(provenanceRevision(firstRun.snapshot), "1");
  assert.equal(provenanceRevision(nextRun.snapshot), "2");
  assert.deepEqual(firstSnapshotAfterNextRun, firstSnapshotBeforeReplay);
});
