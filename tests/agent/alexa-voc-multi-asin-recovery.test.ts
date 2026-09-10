import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, test } from "node:test";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { PostgresAgentRepository } from "../../server/db/postgres-repository";
import { DataSnapshotConflictError } from "../../server/db/data-snapshot-repository";
import { runPostgresMigrations } from "../../server/db/postgres/migrations";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import {
  JobLeaseLostError,
  type JobAttemptRecord,
} from "../../server/db/repository";
import { createAlexaVocNormalizationRuntime } from "../../server/runtime/alexa-voc-normalization-runtime";
import { createAlexaVocNormalizationInputCipher } from "../../server/security/alexa-voc-normalization-input-cipher";
import { createAlexaVocNormalizationFingerprint } from "../../server/domain/voc/alexa-voc-normalization-contracts";
import type { VocPositioningRuntimeConfig } from "../../server/config";
import { ModelProviderError } from "../../server/runtime/model-provider";
import { WorkerTaskError } from "../../server/runtime/retry-policy";
import {
  normalizationRecoveryDisposition,
  normalizationRecoveryQueries,
} from "../../server/domain/voc/alexa-voc-recovery";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const A = "B0NORM0001";
const B = "B0NORM0002";
const C = "B0NORM0003";
const config: VocPositioningRuntimeConfig = {
  apiKey: "never-used",
  transport: "responses-strict",
  baseUrl: null,
  providerName: "local-fixture",
  model: {
    name: "fake-model",
    estimatedInputTokens: 2000,
    maxOutputTokens: 2000,
    timeoutMs: 5000,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 },
  },
  budgetLimits: {
    call: { maxTokens: 100000, maxCostMicros: 100000 },
    run: { maxTokens: 100000, maxCostMicros: 100000 },
    organizationUtcDay: { maxTokens: 100000, maxCostMicros: 100000 },
  },
  worker: {
    ownerId: "normalization-fixture",
    leaseDurationMs: 30000,
    heartbeatIntervalMs: 10000,
    pollIntervalMs: 5,
    stopTimeoutMs: 1000,
    retryPolicy: {
      maxAttempts: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
      jitterRatio: 0,
    },
  },
};
const facts = {
  attention: [
    {
      title: "质量",
      detail: "买家关注耐用性",
      dimension: "Quality",
      mentions: null,
      evidenceQuote: null,
    },
  ],
  positives: [
    {
      label: "耐用",
      detail: "长期使用稳定",
      mentions: null,
      evidenceQuote: null,
    },
  ],
  negatives: [
    {
      label: "重量",
      detail: "搬运较费力",
      mentions: null,
      evidenceQuote: null,
    },
  ],
  unmet: [{ detail: "希望更轻" }],
  audiences: [{ category: "家庭", detail: "重视耐用" }],
  scenarios: [{ name: "家庭使用", detail: "日常使用" }],
  motives: [
    {
      label: "可靠性",
      importance: 5,
      detail: "耐用",
      mentions: null,
      evidenceQuote: null,
    },
  ],
  overallConclusion: "买家重视耐用性",
};
let postgres: PostgresTestContainer;
before(async () => {
  postgres = await startPostgresTestContainer();
});
after(async () => {
  await postgres?.close();
});

for (const adapter of ["sqlite", "postgres"] as const) {
  for (const scenario of [
    "positioning-running",
    "positioning-staggered",
    "publication-sibling",
    "publication-sibling-exhausted",
    "publication",
    "at-limit",
    "absent-at-limit",
    "expired",
    "already-committed",
    "exhausted",
    "permanent",
    "pending-at-limit",
    "budget",
    "publication-then-budget",
    "fresh-final-attempt",
    "transient-final-attempt",
    "permanent-sibling-final-attempt",
    "new-input-during-publication",
    "new-input-pending-publication",
    "cancelled-audit",
    "publication-then-cancelled-audit",
  ] as const) {
    test(`${adapter}: ${scenario.includes("cancelled") ? "audit-seeded" : "natural"} two-ASIN ${scenario} recovery`, async (t) => {
      const expired = scenario === "expired" || scenario === "pending-at-limit";
      const permanentSibling = scenario === "permanent-sibling-final-attempt";
      const transientRetry =
        scenario === "transient-final-attempt" || permanentSibling;
      let explicitRetry = false;
      const directory = mkdtempSync(join(tmpdir(), "voc-recovery-"));
      const path = join(directory, "test.sqlite");
      const schema = `test_${randomUUID().replaceAll("-", "")}`;
      if (adapter === "postgres")
        await postgres.pool.query(`CREATE SCHEMA ${schema}`);
      const pool =
        adapter === "postgres"
          ? postgres.createPool({ searchPath: schema })
          : null;
      if (pool) await runPostgresMigrations(pool);
      const concreteRepository = pool
        ? new PostgresAgentRepository(pool)
        : openSqliteAgentRepository({ path, busyTimeoutMs: 5000 });
      // SQLite implements every port used here; its unrelated syncJobs facade
      // is not part of this normalization fixture.
      const repository = concreteRepository as RuntimeAgentRepository;
      t.after(async () => {
        await concreteRepository.close();
        rmSync(directory, { recursive: true, force: true });
      });
      const organizationId = randomUUID(),
        actorId = randomUUID(),
        projectId = randomUUID(),
        runId = randomUUID();
      const now = new Date().toISOString();
      // A fixed future cutoff permits the freshly committed test revisions.
      const cutoff = new Date(Date.now() + 86400000).toISOString();
      await repository.createUser({
        id: actorId,
        organizationId,
        email: `${actorId}@example.test`,
        displayName: "Recovery",
        role: "admin",
        status: "active",
        createdAt: now,
        updatedAt: now,
      });
      await repository.createProject({
        id: projectId,
        organizationId,
        name: "Recovery",
        marketplace: "US",
        // Caller order is authoritative, not the repository's lexical order.
        asins: scenario.startsWith("positioning-") ? [C, B, A] : [A, B, C],
        createdBy: actorId,
        createdAt: now,
        updatedAt: now,
      });
      await repository.createAnalysisRun({
        id: runId,
        projectId,
        mode: "existing-data",
        status: "queued",
        createdBy: actorId,
        dataCutoffAt: cutoff,
        idempotencyScope: runId,
        idempotencyKey: "create",
        createdAt: now,
        updatedAt: now,
      });
      const cipher = createAlexaVocNormalizationInputCipher({
        MANUAL_VOC_RAW_REPORT_KEYRING: JSON.stringify({
          activeKeyId: "fixture",
          keys: { fixture: randomBytes(32).toString("base64url") },
        }),
      });
      const queueInput = async (
        asin: string,
        destination = { projectId, runId },
      ) => {
        const snapshotId =
          destination.runId !== runId
            ? randomUUID()
            : asin === A
              ? "10000000-0000-4000-8000-000000000001"
              : asin === B
                ? "20000000-0000-4000-8000-000000000002"
                : "30000000-0000-4000-8000-000000000003";
        const envelope = cipher.encrypt({
          identity: {
            organizationId,
            projectId: destination.projectId,
            runId: destination.runId,
            snapshotId,
            marketplace: "US",
            asin,
            schema: "alexa-voc-normalization-input/v1",
          },
          plaintext: `ASIN ${asin} 买家重视耐用性，希望更轻。`,
        });
        const executionIdentity = {
          providerName: config.providerName,
          model: config.model,
        };
        const executionFingerprint = createAlexaVocNormalizationFingerprint({
          marketplace: "US",
          asin,
          rawReportSha256: envelope.plaintextSha256,
          executionIdentity,
        });
        return repository.transaction((scoped) =>
          (
            scoped as RuntimeAgentRepository
          ).manualAlexaVoc.queueNormalizationInput({
            actorUserId: actorId,
            actorOrganizationId: organizationId,
            projectId: destination.projectId,
            runId: destination.runId,
            marketplace: "US",
            asin,
            snapshotId,
            stageId: randomUUID(),
            jobId: randomUUID(),
            rawReportSha256: envelope.plaintextSha256,
            plaintextBytes: envelope.plaintextBytes,
            executionFingerprint,
            executionIdentity,
            envelope,
            queuedAt: asin === C ? new Date().toISOString() : now,
          }),
        );
      };
      const queued = [await queueInput(A), await queueInput(B)];
      const initialThird = scenario === "positioning-running" || scenario.startsWith("publication-sibling");
      const hasThird = initialThird || scenario.startsWith("new-input-");
      if (initialThird) queued.push(await queueInput(C));
      assert.equal(queued[0]!.jobId, queued[1]!.jobId);
      if (scenario.includes("limit") || scenario.includes("final-attempt")) {
        if (pool)
          await pool.query(
            "UPDATE job_attempts SET max_attempts=$2 WHERE id=$1",
            [queued[0]!.jobId, scenario.includes("final-attempt") ? 2 : 1],
          );
        else {
          const db = new DatabaseSync(path);
          db.prepare("UPDATE job_attempts SET max_attempts=? WHERE id=?").run(
            scenario.includes("final-attempt") ? 2 : 1,
            queued[0]!.jobId,
          );
          db.close();
        }
      }
      const naturalPositioning = scenario === "positioning-running" || scenario === "positioning-staggered";
      let injectFailure = !naturalPositioning;
      let publicationFailures = 0;
      let failError: unknown;
      let initialFailureWasPersisted = false;
      let permitClaims = true;
      let claims = 0;
      let firstClaim: JobAttemptRecord | undefined;
      let committedFailure = false;
      let auditFailureInjected = false;
      let notifyFailure!: () => void;
      const failed = new Promise<void>((resolve) => {
        notifyFailure = resolve;
      });
      const wrap = (target: RuntimeAgentRepository): RuntimeAgentRepository =>
        new Proxy({} as RuntimeAgentRepository, {
          get(_facade, property) {
            const base = target;
            if (property === "transaction")
              return async (
                operation: (scoped: RuntimeAgentRepository) => Promise<unknown>,
              ) => {
                const result = await base.transaction((scoped) =>
                  operation(wrap(scoped as RuntimeAgentRepository)),
                );
                if (base === repository && committedFailure) {
                  committedFailure = false;
                  throw new Error(
                    "B publication committed but acknowledgement lost",
                  );
                }
                return result;
              };
            if (property === "claimNextJob")
              return async (...args: Parameters<typeof base.claimNextJob>) => {
                if (!permitClaims) return null;
                const job = await base.claimNextJob(...args);
                if (job) {
                  claims++;
                  firstClaim ??= job;
                }
                return job;
              };
            if (property === "failJob")
              return async (...args: Parameters<typeof base.failJob>) => {
                permitClaims = false;
                try {
                  if (expired && claims === 1) return undefined;
                  const job = await base.failJob(...args);
                  initialFailureWasPersisted =
                    job.status === "failed" || job.status === "cancelled";
                  if (scenario.includes("exhausted") && job.retryable)
                    permitClaims = true;
                  if (scenario === "new-input-pending-publication" && claims === 2) {
                    assert.deepEqual(calls, { [A]: 1, [B]: 1, [C]: 0 });
                    permitClaims = true;
                  }
                  return job;
                } catch (error) {
                  failError = error;
                  t.diagnostic(`failJob: ${String(error)}`);
                  throw error;
                } finally {
                  notifyFailure();
                }
              };
            if (
              property === "finalizeAgentRun" &&
              scenario === "pending-at-limit"
            )
              return async (
                ...args: Parameters<typeof base.finalizeAgentRun>
              ) => {
                const audit = (
                  await base.listAgentRuns({ organizationId, runId })
                ).find((entry) => entry.id === args[0].agentRunId);
                if (
                  !auditFailureInjected &&
                  audit?.snapshotIds[0] === queued[1]!.snapshot.id
                ) {
                  auditFailureInjected = true;
                  throw new Error("B audit finalization database outage");
                }
                return base.finalizeAgentRun(...args);
              };
            // Exact durable-cancellation fixture: finalize through the repository's
            // fenced audit API before the runner observes/replays the terminal.
            // This is not a simulated user cancel signal or a forced failed job.
            if (property === "beginAgentRun" && scenario.includes("cancelled"))
              return async (...args: Parameters<typeof base.beginAgentRun>) => {
                const result = await base.beginAgentRun(...args);
                const input = args[0];
                if (
                  input.snapshotIds[0] !== queued[1]!.snapshot.id ||
                  result.claimStatus !== "acquired"
                )
                  return result;
                const finalized = await base
                  .finalizeAgentRun({
                    agentRunId: result.record.id,
                    organizationId,
                    leaseOwnerId: input.leaseOwnerId!,
                    leaseGeneration: input.leaseGeneration!,
                    claimToken: input.claimToken!,
                    completedAt: new Date().toISOString(),
                    outcome: {
                      terminalStatus: "cancelled",
                      validationStatus: "failed",
                      responseId: null,
                      output: null,
                      error: {
                        code: "CANCELLED",
                        message: "Fixture cancellation",
                        requestId: result.record.id,
                      },
                      inputTokens: null,
                      outputTokens: null,
                      estimatedCostMicros: null,
                      durationMs: 0,
                      attemptCount: 0,
                      usageCompleteness: "unavailable",
                      attempts: [],
                      terminalMetadata: { kind: "cancelled" },
                    },
                  })
                  .catch((error) => {
                    t.diagnostic(`Cancellation fixture: ${String(error)}`);
                    throw error;
                  });
                return {
                  ...result,
                  claimStatus: "terminal" as const,
                  record: finalized.record,
                };
              };
            if (
              property === "manualAlexaVoc" &&
              [
                "permanent",
                "budget",
                "cancelled-audit",
                "transient-final-attempt",
                "permanent-sibling-final-attempt",
              ].includes(scenario)
            )
              return new Proxy({} as typeof base.manualAlexaVoc, {
                get(_manualFacade, key) {
                  const manual = base.manualAlexaVoc;
                  if (key === "putNormalizationTerminal")
                    return async (
                      ...args: Parameters<
                        typeof manual.putNormalizationTerminal
                      >
                    ) => {
                      if (
                        injectFailure &&
                        args[0].snapshotId === queued[1]!.snapshot.id &&
                        args[0].status === "failure"
                      ) {
                        injectFailure = false;
                        throw new WorkerTaskError(
                          "upstream-temporary",
                          "B failure terminal database outage",
                        );
                      }
                      return manual.putNormalizationTerminal(...args);
                    };
                  const method = Reflect.get(manual, key);
                  return typeof method === "function"
                    ? method.bind(manual)
                    : method;
                },
              });
            if (property === "createDataSnapshotForRun")
              return async (
                ...args: Parameters<typeof base.createDataSnapshotForRun>
              ) => {
                const terminals =
                  await base.manualAlexaVoc.listNormalizationTerminals({
                    actorOrganizationId: organizationId,
                    projectId,
                    runId,
                  });
                const failureSnapshot =
                  scenario === "absent-at-limit" ||
                  scenario === "publication-then-budget" ||
                  scenario === "publication-then-cancelled-audit" ||
                  scenario === "fresh-final-attempt"
                    ? queued[0]!.snapshot.id
                    : queued[1]!.snapshot.id;
                if (
                  ![
                    "permanent",
                    "pending-at-limit",
                    "budget",
                    "cancelled-audit",
                    "transient-final-attempt",
                    "permanent-sibling-final-attempt",
                  ].includes(scenario) &&
                  injectFailure &&
                  terminals.some(
                    (terminal) =>
                      terminal.snapshotId === failureSnapshot &&
                      terminal.status === "success",
                  )
                ) {
                  publicationFailures++;
                  injectFailure = scenario.includes("exhausted") ||
                    (scenario === "new-input-pending-publication" && publicationFailures < 2);
                  if (scenario === "already-committed") {
                    const result = await base.createDataSnapshotForRun(...args);
                    committedFailure = true;
                    return result;
                  }
                  if (scenario.startsWith("publication-sibling")) throw new DataSnapshotConflictError();
                  throw new Error(
                    "B cumulative publication failed after durable revision",
                  );
                }
                return base.createDataSnapshotForRun(...args);
              };
            const value = Reflect.get(base, property);
            return typeof value === "function" ? value.bind(base) : value;
          },
        });
      const calls: Record<string, number> = { [A]: 0, [B]: 0,
        ...(initialThird ? { [C]: 0 } : {}),
      };
      const createRuntime = () =>
        createAlexaVocNormalizationRuntime({
          repository: wrap(repository),
          config: {
            ...config,
            ...(scenario.includes("budget")
              ? {
                  budgetLimits: {
                    ...config.budgetLimits,
                    run: { maxTokens: 4100, maxCostMicros: 100000 },
                  },
                }
              : {}),
            worker: {
              ...config.worker,
              ...(expired
                ? { leaseDurationMs: 3000, heartbeatIntervalMs: 1000 }
                : {}),
            },
          },
          normalizationInputCipher: cipher,
          provider: {
            async generateStructured<T>(request: { input: unknown }) {
              const asin = (request.input as { asin: string }).asin;
              calls[asin]++;
              if (scenario === "new-input-pending-publication" && asin === B) {
                const next = await queueInput(C);
                assert.equal(next.jobCreated, true);
                assert.notEqual(next.jobId, queued[0]!.jobId);
                queued.push(next);
                calls[C] = 0;
              }
              if (naturalPositioning && asin === B) {
                const positioning = await repository.claimNextJob({
                  ownerId: "positioning-fixture", stage: "voc-positioning",
                  claimedAt: new Date().toISOString(), leaseDurationMs: 30000,
                });
                assert.equal(positioning?.status, "running");
                if (scenario === "positioning-staggered") {
                  queued.push(await queueInput(C));
                  calls[C] = 0;
                }
              }
              if (transientRetry && asin === B && calls[asin]! <= 3)
                throw new ModelProviderError(
                  "transient",
                  "B temporary provider outage",
                );
              if (scenario === "permanent" && asin === B)
                throw new ModelProviderError(
                  "permanent",
                  "B is permanently unavailable",
                );
              if (permanentSibling && asin === A && !explicitRetry)
                throw new ModelProviderError(
                  "permanent",
                  "A is permanently unavailable",
                );
              return {
                value: {
                  schemaVersion: "1.0.0",
                  kind: "alexa-voc-normalization-result",
                  record: facts,
                } as T,
                responseId: `response-${asin}`,
                inputTokens: 100,
                outputTokens: 100,
              };
            },
          },
        });
      const runtime = await createRuntime();
      t.after(() => runtime.stop());
      runtime.start();
      if (naturalPositioning) {
        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
          const jobs = await repository.listJobAttempts(queued[0]!.stageId);
          if (jobs.some((job) => job.status === "failed") || jobs.every((job) => job.status === "succeeded")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await runtime.stop();
        assert.deepEqual(calls, { [A]: 1, [B]: 1, [C]: 1 });
        const jobs = await repository.listJobAttempts(queued[0]!.stageId);
        assert.equal(jobs.at(-1)?.status, "succeeded", JSON.stringify(jobs.map((job) => job.error)));
        const terminals = await repository.manualAlexaVoc.listNormalizationTerminals({
          actorOrganizationId: organizationId, projectId, runId,
        });
        assert.equal(terminals.filter((terminal) => terminal.status === "success").length, 3);
        const snapshots = await repository.listDataSnapshotsByRun({ actorOrganizationId: organizationId, runId });
        assert.equal(snapshots.length, 3);
        const complete = snapshots.find((snapshot) => snapshot.payload.records.alexaVoc.length === 3)!;
        assert.deepEqual(complete.payload.records.alexaVoc.map((record) => record.asin), [C, B, A]);
        assert.deepEqual((await repository.manualAlexaVoc.listAtCutoff({
          organizationId, marketplace: "US", asins: [C, B, A], dataCutoffAt: cutoff,
        })).map((revision) => revision.revision), ["1", "1", "1"]);
        return;
      }
      await Promise.race([
        failed,
        new Promise((_, reject) => {
          const timer = setTimeout(
            () => reject(new Error("Natural failJob was never reached")),
            10000,
          );
          timer.unref();
        }),
      ]).catch(async (error) => {
        t.diagnostic(
          JSON.stringify({
            calls,
            jobs: (await repository.listJobAttempts(queued[0]!.stageId)).map(
              (job) => ({ status: job.status, attempt: job.attemptNumber }),
            ),
          }),
        );
        throw error;
      });
      assert.ifError(failError);
      if (scenario === "new-input-pending-publication") {
        const jobs = await repository.listJobAttempts(queued[0]!.stageId);
        assert.equal(jobs[0]!.reportPublicationMaxAttempts, null);
        assert.equal(jobs[0]!.status, "failed");
        assert.equal(jobs[1]!.status, "queued");
        assert.deepEqual(calls, { [A]: 1, [B]: 1, [C]: 0 });
      }
      if (scenario.startsWith("publication-sibling")) {
        // The publication transaction rolled back B's terminal, not its durable
        // revision. C must finish under this lease before a retry is allowed.
        assert.deepEqual(calls, { [A]: 1, [B]: 1, [C]: 1 });
      }
      assert.equal(initialFailureWasPersisted, !expired);
      const audits = await repository.listAgentRuns({ organizationId, runId });
      const auditCycles = pool
        ? (
            await pool.query(
              "SELECT DISTINCT logical_execution_cycle_id FROM agent_runs WHERE run_id=$1",
              [runId],
            )
          ).rows
        : (() => {
            const db = new DatabaseSync(path);
            try {
              return db
                .prepare(
                  "SELECT DISTINCT logical_execution_cycle_id FROM agent_runs WHERE run_id=?",
                )
                .all(runId);
            } finally {
              db.close();
            }
          })();
      assert.equal(auditCycles.length, 1);
      assert.equal(
        new Set(audits.map((audit) => audit.executionFingerprint)).size,
        scenario === "absent-at-limit" ||
          scenario === "publication-then-budget" ||
          scenario === "publication-then-cancelled-audit" ||
          scenario === "fresh-final-attempt"
          ? 1
          : initialThird ? 3 : 2,
      );
      if (scenario === "publication") {
        const job = (await repository.listJobAttempts(queued[0]!.stageId)).at(
          -1,
        )!;
        const records: Record<string, unknown>[][] = [];
        for (const query of normalizationRecoveryQueries(job)) {
          if (pool) {
            let index = 0;
            records.push(
              (
                await pool.query(
                  query.sql.replace(/\?/g, () => `$${++index}`),
                  query.values,
                )
              ).rows,
            );
          } else {
            const db = new DatabaseSync(path);
            try {
              records.push(db.prepare(query.sql).all(...query.values));
            } finally {
              db.close();
            }
          }
        }
        assert.equal(
          normalizationRecoveryDisposition(job, records).kind,
          "recover",
        );
        const corruptions = [
          (rows: typeof records) => {
            rows[0]!.push({ ...rows[0]![0]! });
          },
          (rows: typeof records) => {
            rows[0]![0]!.execution_fingerprint = "f".repeat(64);
          },
          (rows: typeof records) => {
            rows[0]![0]!.run_id = randomUUID();
          },
          (rows: typeof records) => {
            rows[0]![0]!.snapshot_ids_json = "[]";
          },
          (rows: typeof records) => {
            rows[0]![0]!.linked_snapshot_count = 0;
          },
          (rows: typeof records) => {
            rows[0]![0]!.terminal_metadata_json = { kind: "cancelled" };
          },
          (rows: typeof records) => {
            rows[2]![0]!.execution_fingerprint = "f".repeat(64);
          },
          (rows: typeof records) => {
            rows[2]![0]!.agent_run_id = audits.find(
              (audit) => audit.snapshotIds[0] === queued[1]!.snapshot.id,
            )!.id;
          },
          (rows: typeof records) => {
            rows[2]![0]!.terminal_job_stage_id = randomUUID();
          },
          (rows: typeof records) => {
            // A B-shaped terminal retaining A's actual joined audit provenance.
            rows[2]![0]!.snapshot_id = queued[1]!.snapshot.id;
            rows[2]![0]!.asin = B;
            rows[2]![0]!.execution_fingerprint =
              queued[1]!.snapshot.executionFingerprint;
          },
        ];
        for (const corrupt of corruptions) {
          const rows = structuredClone(records);
          corrupt(rows);
          assert.throws(() => normalizationRecoveryDisposition(job, rows));
        }
      }
      if (scenario === "new-input-during-publication") {
        const next = await queueInput(C);
        assert.equal(next.jobCreated, true);
        assert.notEqual(next.jobId, queued[0]!.jobId);
        calls[C] = 0;
      }
      if (expired) await new Promise((resolve) => setTimeout(resolve, 3100));
      permitClaims = true;
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const job = (await repository.listJobAttempts(queued[0]!.stageId)).at(
          -1,
        )!;
        if (
          job.status === "succeeded" ||
          job.status === "cancelled" ||
          (job.status === "failed" && !job.retryable)
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await runtime.stop();
      await assert.rejects(
        repository.failJob({
          jobId: firstClaim!.id,
          ownerId: firstClaim!.leasedBy!,
          leaseGeneration: firstClaim!.leaseGeneration,
          failedAt: new Date().toISOString(),
          retryable: false,
          retryAt: null,
          error: {
            classification: "infrastructure",
            message: "late stale owner",
          },
        }),
        JobLeaseLostError,
      );
      assert.ok(
        scenario === "budget" || scenario === "cancelled-audit"
          ? claims === 1
          : claims >= 2,
      );
      const terminals =
        await repository.manualAlexaVoc.listNormalizationTerminals({
          actorOrganizationId: organizationId,
          projectId,
          runId,
        });
      if (scenario.includes("exhausted")) {
        const job = (await repository.listJobAttempts(queued[0]!.stageId)).at(
          -1,
        )!;
        assert.equal(job.status, "failed");
        assert.equal(job.retryable, false);
        assert.equal(job.reportPublicationAttemptCount, 3);
      } else
        assert.deepEqual(
          Object.fromEntries(
            terminals.map((terminal) => [terminal.asin, terminal.status]),
          ),
          {
            [A]: permanentSibling ? "failure" : "success",
            [B]: [
              "absent-at-limit",
              "permanent",
              "pending-at-limit",
              "budget",
              "publication-then-budget",
              "cancelled-audit",
              "publication-then-cancelled-audit",
            ].includes(scenario)
              ? "failure"
              : "success",
            ...(hasThird
              ? { [C]: "success" }
              : {}),
          },
        );
      const lastJob = (await repository.listJobAttempts(queued[0]!.stageId)).at(
        -1,
      )!;
      if (scenario === "new-input-pending-publication") {
        assert.equal(lastJob.attemptNumber, 3);
        assert.equal(lastJob.logicalExecutionCycleId, firstClaim!.logicalExecutionCycleId);
        assert.equal(lastJob.retryCycleStartAttempt, firstClaim!.retryCycleStartAttempt);
        assert.equal(lastJob.maxAttempts - lastJob.attemptNumber,
          firstClaim!.maxAttempts - firstClaim!.attemptNumber - 1);
      }
      if (transientRetry) {
        assert.equal(lastJob.attemptNumber, 2);
        assert.equal(lastJob.maxAttempts, 2);
        assert.notEqual(
          lastJob.logicalExecutionCycleId,
          firstClaim!.logicalExecutionCycleId,
        );
      }
      if (scenario === "new-input-during-publication") {
        assert.ok(
          (await repository.listJobAttempts(queued[0]!.stageId)).every(
            (job) => job.status === "succeeded",
          ),
        );
      }
      assert.equal(
        lastJob.status,
        scenario.includes("cancelled")
          ? "cancelled"
          : scenario.includes("exhausted") || scenario.includes("budget")
            ? "failed"
            : "succeeded",
      );
      if (scenario.includes("budget"))
        assert.equal(
          (await repository.listRunStages(runId)).find(
            (stage) => stage.id === queued[0]!.stageId,
          )?.status,
          "budget-exceeded",
        );
      const revisions = await repository.manualAlexaVoc.listAtCutoff({
        organizationId,
        marketplace: "US",
        asins: hasThird ? [A, B, C] : [A, B],
        dataCutoffAt: cutoff,
      });
      assert.deepEqual(
        Object.fromEntries(
          revisions.map((revision) => [revision.asin, revision.revision]),
        ),
        permanentSibling
          ? { [B]: "1" }
          : [
                "absent-at-limit",
                "permanent",
                "pending-at-limit",
                "budget",
                "publication-then-budget",
                "cancelled-audit",
                "publication-then-cancelled-audit",
              ].includes(scenario)
            ? { [A]: "1" }
            : {
                [A]: "1",
                [B]: "1",
                ...(hasThird
                  ? { [C]: "1" }
                  : {}),
              },
      );
      assert.deepEqual(calls, {
        [A]: 1,
        [B]:
          scenario === "absent-at-limit" ||
          scenario.includes("budget") ||
          scenario.includes("cancelled")
            ? 0
            : transientRetry
              ? 4
              : 1,
        ...(hasThird ? { [C]: 1 } : {}),
      });
      const statuses =
        await repository.manualAlexaVoc.listNormalizationStatuses({
          actorOrganizationId: organizationId,
          projectId,
          runId,
          marketplace: "US",
          asins:
            hasThird ? [A, B, C] : [A, B],
        });
      assert.equal(
        statuses.some((status) => status.status === "pending"),
        false,
      );
      const expectedPublications = [
        "permanent-sibling-final-attempt",
        "exhausted",
        "absent-at-limit",
        "permanent",
        "pending-at-limit",
        "budget",
        "publication-then-budget",
        "cancelled-audit",
        "publication-then-cancelled-audit",
      ].includes(scenario)
        ? 1
        : scenario.startsWith("new-input-")
          ? 3
          : 2;
      if (pool)
        assert.equal(
          Number(
            (
              await pool.query(
                "SELECT count(*) FROM data_snapshots WHERE run_id=$1 AND artifact_kind='voc'",
                [runId],
              )
            ).rows[0].count,
          ),
          expectedPublications,
        );
      else {
        const db = new DatabaseSync(path);
        try {
          assert.equal(
            Number(
              (
                db
                  .prepare(
                    "SELECT count(*) AS n FROM data_snapshots WHERE run_id=? AND artifact_kind='voc'",
                  )
                  .get(runId) as { n: number }
              ).n,
            ),
            expectedPublications,
          );
        } finally {
          db.close();
        }
      }
      if (scenario === "publication") {
        // A repository-written success in a different project/run legitimately
        // points back to the source audit; recovery must preserve that replay.
        const replayProjectId = randomUUID(),
          replayRunId = randomUUID();
        await repository.createProject({
          id: replayProjectId,
          organizationId,
          name: "Replay",
          marketplace: "US",
          asins: [A, B, C],
          createdBy: actorId,
          createdAt: now,
          updatedAt: now,
        });
        await repository.createAnalysisRun({
          id: replayRunId,
          projectId: replayProjectId,
          mode: "existing-data",
          status: "queued",
          createdBy: actorId,
          dataCutoffAt: cutoff,
          idempotencyScope: replayRunId,
          idempotencyKey: "create",
          createdAt: now,
          updatedAt: now,
        });
        const replay = await queueInput(A, {
          projectId: replayProjectId,
          runId: replayRunId,
        });
        const sourceAudit = audits.find(
          (audit) => audit.snapshotIds[0] === queued[0]!.snapshot.id,
        )!;
        await repository.manualAlexaVoc.putNormalizationTerminal({
          snapshotId: replay.snapshot.id,
          runId: replayRunId,
          jobAttemptId: replay.jobId,
          agentRunId: sourceAudit.id,
          asin: A,
          executionFingerprint: replay.snapshot.executionFingerprint,
          status: "success",
          category: null,
          completedAt: now,
        });
        const replayJob = (
          await repository.listJobAttempts(replay.stageId)
        )[0]!;
        const rows: Record<string, unknown>[][] = [];
        for (const query of normalizationRecoveryQueries(replayJob)) {
          if (pool) {
            let index = 0;
            rows.push(
              (
                await pool.query(
                  query.sql.replace(/\?/g, () => `$${++index}`),
                  query.values,
                )
              ).rows,
            );
          } else {
            const db = new DatabaseSync(path);
            try {
              rows.push(db.prepare(query.sql).all(...query.values));
            } finally {
              db.close();
            }
          }
        }
        assert.deepEqual(normalizationRecoveryDisposition(replayJob, rows), {
          kind: "recover",
          mode: "completion-only",
        });
        assert.notEqual(rows[2]![0]!.source_audit_run_id, replayRunId);
        const mismatchedSource = structuredClone(rows);
        mismatchedSource[2]![0]!.source_organization_id = randomUUID();
        assert.throws(() =>
          normalizationRecoveryDisposition(replayJob, mismatchedSource),
        );
        const wrongSourceAsin = structuredClone(rows);
        wrongSourceAsin[2]![0]!.source_asins_json = JSON.stringify([B]);
        assert.throws(() =>
          normalizationRecoveryDisposition(replayJob, wrongSourceAsin),
        );
      }
      if (permanentSibling) {
        assert.equal(
          terminals.filter((terminal) => terminal.asin === A).length,
          1,
        );
        assert.equal(
          terminals.find((terminal) => terminal.asin === A)!.jobAttemptId,
          firstClaim!.id,
        );
        assert.deepEqual(
          Object.fromEntries(
            statuses.map((status) => [status.asin, status.status]),
          ),
          { [A]: "failure", [B]: "success" },
        );
        assert.equal(
          (await repository.listRunStages(runId)).find(
            (stage) => stage.id === queued[0]!.stageId,
          )?.status,
          "succeeded",
        );
        assert.equal(
          lastJob.retryCycleStartAttempt,
          firstClaim!.retryCycleStartAttempt,
        );
        const retried = await queueInput(A);
        assert.equal(retried.jobCreated, true);
        assert.equal(retried.snapshot.id, queued[0]!.snapshot.id);
        const newJob = (await repository.listJobAttempts(retried.stageId)).find(
          (job) => job.id === retried.jobId,
        )!;
        assert.equal(newJob.retryCycleStartAttempt, newJob.attemptNumber);
        assert.ok(newJob.retryCycleStartAttempt > lastJob.attemptNumber);
        explicitRetry = true;
        permitClaims = true;
        const explicitRuntime = await createRuntime();
        t.after(() => explicitRuntime.stop());
        explicitRuntime.start();
        const retryDeadline = Date.now() + 10000;
        while (Date.now() < retryDeadline) {
          if (
            (await repository.listJobAttempts(retried.stageId)).find(
              (job) => job.id === retried.jobId,
            )?.status === "succeeded"
          )
            break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await explicitRuntime.stop();
        assert.equal(
          (await repository.listJobAttempts(retried.stageId)).find(
            (job) => job.id === retried.jobId,
          )?.status,
          "succeeded",
        );
        assert.deepEqual(calls, { [A]: 2, [B]: 4 });
        const afterRetry =
          await repository.manualAlexaVoc.listNormalizationTerminals({
            actorOrganizationId: organizationId,
            projectId,
            runId,
          });
        assert.deepEqual(
          afterRetry
            .filter((terminal) => terminal.asin === A)
            .map((terminal) => terminal.status)
            .sort(),
          ["failure", "success"],
        );
        assert.equal(
          afterRetry.filter((terminal) => terminal.asin === B).length,
          1,
        );
        const finalRevisions = await repository.manualAlexaVoc.listAtCutoff({
          organizationId,
          marketplace: "US",
          asins: [A, B],
          dataCutoffAt: cutoff,
        });
        assert.deepEqual(
          Object.fromEntries(
            finalRevisions.map((revision) => [
              revision.asin,
              revision.revision,
            ]),
          ),
          { [A]: "1", [B]: "1" },
        );
      }
    });
  }
}
