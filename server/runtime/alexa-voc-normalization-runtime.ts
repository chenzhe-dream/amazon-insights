import { randomUUID } from "node:crypto";
import { DEFAULT_VOC_QUEUE_TIMEOUT_MS } from "../domain/voc/queue-deadline";
import { resolve } from "node:path";

import type { VocPositioningRuntimeConfig } from "../config";
import type { RuntimeAgentRepository } from "../db/repository";
import { DataSnapshotConflictError } from "../db/data-snapshot-repository";
import { AlexaVocPublicationConflictError } from "../services/alexa-voc-publication-error";
import {
  VOC_SOURCE_REFERENCES,
  buildVocSnapshotCandidate,
} from "../data/voc-data-snapshot";
import type { AlexaVocNormalizationInputCipher } from "../security/alexa-voc-normalization-input-cipher";
import { createAlexaVocNormalizationInputCipher } from "../security/alexa-voc-normalization-input-cipher";
import {
  AlexaVocNormalizationExecutionService,
  type AlexaVocNormalizationCommitInput,
} from "../services/alexa-voc-normalization-execution-service";
import { createAlexaVocNormalizationJobHandler } from "../services/alexa-voc-normalization-worker-handler";
import { SkillRegistry } from "../skills/registry";
import { AuditedSkillRunner } from "./agent-run-service";
import {
  ModelBudgetCoordinator,
  StaticModelBudgetLimitProvider,
} from "./model-budget-coordinator";
import type { ModelProvider } from "./model-provider";
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai-provider";
import { WorkerTaskError } from "./retry-policy";
import { SkillRunner, type ModelValidationLogger } from "./skill-runner";
import {
  JobAttemptWorkerLoop,
  type WorkerClock,
  type WorkerLogger,
} from "./worker-loop";

export type VocPositioningMode = "local-rules" | "model";

export interface AlexaVocNormalizationRuntimeOptions {
  positioningMode?: VocPositioningMode;
  queueTimeoutMs?: number;
  repository: RuntimeAgentRepository;
  config: VocPositioningRuntimeConfig;
  provider?: ModelProvider;
  providerFactory?: (options: OpenAIProviderOptions) => ModelProvider;
  providerName?: string;
  normalizationInputCipher?: AlexaVocNormalizationInputCipher;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
  validationLogger?: ModelValidationLogger;
}

export interface AlexaVocNormalizationRuntime {
  start(): void;
  stop(): Promise<void>;
}

export async function createAlexaVocNormalizationRuntime(
  options: AlexaVocNormalizationRuntimeOptions,
): Promise<AlexaVocNormalizationRuntime> {
  const clock = options.clock ?? (() => new Date());
  const registry = await SkillRegistry.open(
    options.skillsRoot ?? resolve("skills-src"),
  );
  const providerFactory = options.providerFactory ??
    ((providerOptions: OpenAIProviderOptions) => new OpenAIProvider(providerOptions));
  const provider = options.provider ?? providerFactory({
    apiKey: options.config.apiKey,
    transport: options.config.transport,
    baseUrl: options.config.baseUrl,
  });
  const providerName = options.providerName ?? options.config.providerName;
  const budgetCoordinator = new ModelBudgetCoordinator({
    repository: options.repository,
    limitProvider: new StaticModelBudgetLimitProvider(options.config.budgetLimits),
    clock,
  });
  const auditedRunner = new AuditedSkillRunner({
    repository: options.repository,
    clock,
    skillRunner: new SkillRunner({
      registry,
      provider,
      providerName,
      budgetCoordinator,
      now: () => clock().getTime(),
      ...(options.validationLogger
        ? { validationLogger: options.validationLogger }
        : {}),
    }),
  });
  const service = new AlexaVocNormalizationExecutionService({
    repository: {
      findNormalizationInputSnapshot: (input) =>
        options.repository.manualAlexaVoc.findNormalizationInputSnapshot(input),
      findCommittedNormalizationByFingerprint: (input) =>
        options.repository.manualAlexaVoc.findCommittedNormalizationByFingerprint(input),
      commitNormalizationAndWake: (input) =>
        commitNormalizationAndWake(options.repository, input, options.positioningMode ?? "local-rules"),
    },
    normalizationInputCipher:
      options.normalizationInputCipher ?? createAlexaVocNormalizationInputCipher(),
    auditedRunner,
  });
  // The worker is serial. Keep only its current lease decision, so appended
  // inputs in a fresh final attempt retain permission while a reclaimed lease
  // cannot inherit that permission from the prior owner/generation.
  let preparedLease: { key: string; reconciliationOnly: boolean } | undefined;
  const handler = createAlexaVocNormalizationJobHandler({
    service,
    prepare: async (job) => {
      const subject = await trustedNormalizationSubject(options.repository, job.runId);
      const leaseKey = `${job.id}:${job.leasedBy}:${job.leaseGeneration}`;
      const audits = await options.repository.listAgentRuns({
        organizationId: subject.organizationId,
        runId: job.runId,
      });
      const stageAttempts = await options.repository.listJobAttempts(job.stageId);
      // Automatic successors retain this boundary even across logical cycles;
      // an explicit enqueue starts a new chain and may retry a failed input.
      const completedChainJobIds = stageAttempts
        .filter((attempt) => attempt.retryCycleStartAttempt === job.retryCycleStartAttempt &&
          attempt.attemptNumber >= job.retryCycleStartAttempt &&
          attempt.attemptNumber <= job.attemptNumber)
        .map((attempt) => attempt.id);
      const attempts = stageAttempts
        .filter((attempt) => attempt.logicalExecutionCycleId === job.logicalExecutionCycleId);
      const cycleJobs = new Set(attempts.map((attempt) => attempt.id));
      const cycleAudits = audits.filter((audit) =>
        audit.stageId === job.stageId && cycleJobs.has(audit.jobAttemptId ?? "")
      );
      const hasDurableAudit = (snapshot: { id: string; executionFingerprint: string }) =>
        cycleAudits.some((audit) =>
          audit.snapshotIds.length === 1 && audit.snapshotIds[0] === snapshot.id &&
          audit.executionFingerprint === snapshot.executionFingerprint &&
          audit.validationStatus === "passed" && audit.status === "succeeded"
        );
      const hasTerminalAbort = cycleAudits.some((audit) =>
        audit.terminalMetadata?.kind === "budget-exceeded" ||
        audit.terminalMetadata?.kind === "cancelled"
      );
      const hasSuccessor = stageAttempts.some((attempt) =>
        attempt.attemptNumber > job.attemptNumber
      );
      if (preparedLease?.key !== leaseKey) {
        const predecessorGeneration = Math.max(0, ...stageAttempts
          .filter((attempt) => attempt.attemptNumber >= job.retryCycleStartAttempt &&
            attempt.attemptNumber < job.attemptNumber)
          .map((attempt) => attempt.leaseGeneration));
        preparedLease = {
          key: leaseKey,
          reconciliationOnly: job.reportPublicationMaxAttempts !== null ||
            (job.attemptNumber >= job.maxAttempts &&
              job.leaseGeneration > predecessorGeneration + 1),
        };
      }
      const reconciliationOnly = preparedLease.reconciliationOnly;
      const snapshots = await options.repository.manualAlexaVoc
        .listNormalizationInputSnapshots({
          actorOrganizationId: subject.organizationId,
          projectId: subject.projectId,
          runId: job.runId,
          jobAttemptId: job.id,
        });
      const terminals = await options.repository.manualAlexaVoc
        .listNormalizationTerminals({
          actorOrganizationId: subject.organizationId,
          projectId: subject.projectId,
          runId: job.runId,
        });
      const pendingSnapshots = (
        await Promise.all(
          snapshots
            .filter((snapshot) => !(job.reportPublicationMaxAttempts !== null &&
              hasSuccessor && !cycleAudits.some((audit) => audit.snapshotIds.includes(snapshot.id))))
            .filter((snapshot) => shouldProcessAlexaVocNormalizationSnapshot({
              snapshotId: snapshot.id,
              jobAttemptId: job.id,
              completedChainJobIds,
              terminals,
            }))
            .map(async (snapshot) => ({
              snapshot,
              replay: await options.repository.manualAlexaVoc
                .findCommittedNormalizationReplayByFingerprint({
                  actorOrganizationId: subject.organizationId,
                  marketplace: snapshot.marketplace,
                  asin: snapshot.asin,
                  executionFingerprint: snapshot.executionFingerprint,
                  dataCutoffAt: subject.dataCutoffAt,
                }),
            })),
        )
      );
      return {
        snapshots: pendingSnapshots.toSorted((left, right) => {
          const durable = (item: typeof left) => Boolean(item.replay) || hasDurableAudit(item.snapshot);
          return Number(durable(right)) - Number(durable(left));
        }).map(({ snapshot, replay }) => ({
          id: snapshot.id,
          asin: snapshot.asin,
          executionFingerprint: snapshot.executionFingerprint,
          reconciliationBlocked: (reconciliationOnly || hasTerminalAbort) &&
            !replay && !hasDurableAudit(snapshot),
          ...(replay
            ? { replay: {
                agentRunId: replay.agentRunId,
                revision: replay.revision.revision,
              } }
            : {}),
        })),
        model: options.config.model,
        providerName,
        context: {
          actorId: subject.actorId,
          organizationId: subject.organizationId,
          projectId: subject.projectId,
          dataCutoffAt: subject.dataCutoffAt,
        },
      };
    },
    onReplay: (input) => recordReplayedNormalizationTerminal(
      options.repository,
      input,
      clock().toISOString(),
      options.positioningMode ?? "local-rules",
    ),
    onTerminal: async (terminal) => {
      if (terminal.status === "success") return;
      await recordFailedNormalizationTerminal(
        options.repository,
        terminal,
        clock().toISOString(),
      );
    },
    finalize: ({ job }) => finalizeNormalizationJob(
      options.repository,
      job,
      clock().toISOString(),
    ),
  });
  const worker = new JobAttemptWorkerLoop({
    repository: options.repository,
    ownerId: options.config.worker.ownerId,
    stage: "alexa-voc-normalization",
    queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_VOC_QUEUE_TIMEOUT_MS,
    handler,
    leaseDurationMs: options.config.worker.leaseDurationMs,
    heartbeatIntervalMs: options.config.worker.heartbeatIntervalMs,
    pollIntervalMs: options.config.worker.pollIntervalMs,
    stopTimeoutMs: options.config.worker.stopTimeoutMs,
    retryPolicy: options.config.worker.retryPolicy,
    ...(options.workerClock ? { clock: options.workerClock } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return Object.freeze({
    start: () => worker.start(),
    stop: () => worker.stop(),
  });
}

export function shouldProcessAlexaVocNormalizationSnapshot(input: Readonly<{
  snapshotId: string;
  jobAttemptId: string;
  completedChainJobIds?: readonly string[];
  terminals: readonly Readonly<{
    snapshotId: string;
    jobAttemptId: string;
    status: "success" | "failure";
  }>[];
}>): boolean {
  const terminals = input.terminals.filter(
    (terminal) => terminal.snapshotId === input.snapshotId,
  );
  return !terminals.some((terminal) => terminal.status === "success") &&
    !terminals.some((terminal) => terminal.jobAttemptId === input.jobAttemptId ||
      input.completedChainJobIds?.includes(terminal.jobAttemptId));
}

async function trustedNormalizationSubject(
  repository: RuntimeAgentRepository,
  runId: string,
) {
  const run = await repository.findAnalysisRun(runId);
  if (!run) throw trustedSubjectError();
  const project = await repository.findProjectById(run.projectId);
  const actor = await repository.findUserById(run.createdBy);
  if (
    !project ||
    !actor ||
    actor.status !== "active" ||
    actor.organizationId !== project.organizationId ||
    project.marketplace !== "US"
  ) {
    throw trustedSubjectError();
  }
  return {
    actorId: actor.id,
    organizationId: actor.organizationId,
    projectId: project.id,
    asins: project.asins,
    dataCutoffAt: run.dataCutoffAt,
  };
}

export async function persistNormalizationBeforePublication<TPersisted, TResult>(input: Readonly<{
  persistRevision: () => Promise<TPersisted>;
  publishRevision: (persisted: TPersisted) => Promise<TResult>;
}>): Promise<TResult> {
  const persisted = await input.persistRevision();
  return input.publishRevision(persisted);
}

async function trustedNormalizationCommitSubject(
  repository: RuntimeAgentRepository,
  input: AlexaVocNormalizationCommitInput,
  committedAt: string,
) {
  const subject = await trustedNormalizationSubject(repository, input.runId);
  if (
    subject.actorId !== input.actorId ||
    subject.organizationId !== input.actorOrganizationId ||
    subject.projectId !== input.projectId ||
    !subject.asins.includes(input.asin)
  ) {
    throw trustedSubjectError();
  }
  const jobs = await repository.listJobAttempts(input.stageId);
  const job = jobs.find((candidate) => candidate.id === input.jobAttemptId);
  const agentRuns = await repository.listAgentRuns({
    organizationId: input.actorOrganizationId,
    runId: input.runId,
  });
  const agentRun = agentRuns.find((candidate) => candidate.id === input.agentRunId);
  if (
    !job ||
    job.status !== "running" ||
    job.stageId !== input.stageId ||
    job.leasedBy !== input.leaseOwnerId ||
    job.leaseGeneration !== input.leaseGeneration ||
    !job.leaseExpiresAt ||
    Date.parse(job.leaseExpiresAt) <= Date.parse(committedAt) ||
    !agentRun ||
    agentRun.stageId !== input.stageId ||
    !jobs.some((attempt) => attempt.id === agentRun.jobAttemptId && attempt.logicalExecutionCycleId === job.logicalExecutionCycleId) ||
    agentRun.executionFingerprint !== input.contentHash ||
    agentRun.validationStatus !== "passed" ||
    agentRun.status !== "succeeded" ||
    agentRun.snapshotIds.length !== 1 ||
    agentRun.snapshotIds[0] !== input.snapshotId
  ) {
    throw trustedSubjectError();
  }
  return subject;
}

function normalizationPublicationRetry(error: unknown) {
  if (error instanceof DataSnapshotConflictError) return new AlexaVocPublicationConflictError(error);
  if (error instanceof WorkerTaskError && error.category !== "infrastructure") return error;
  return new WorkerTaskError(
    "upstream-temporary",
    "Alexa VOC normalization publication failed after durable revision",
    { cause: error instanceof Error ? error : undefined },
  );
}

async function retryableNormalizationPublication<TResult>(operation: () => Promise<TResult>) {
  try {
    return await operation();
  } catch (error) {
    throw normalizationPublicationRetry(error);
  }
}

async function commitNormalizationAndWake(
  repository: RuntimeAgentRepository,
  input: AlexaVocNormalizationCommitInput,
  positioningMode: VocPositioningMode,
) {
  return persistNormalizationBeforePublication({
    persistRevision: () => repository.transaction(async (baseRepository) => {
      const scoped = baseRepository as RuntimeAgentRepository;
      const committedAt = await scoped.manualAlexaVoc.readDatabaseClock();
      await trustedNormalizationCommitSubject(scoped, input, committedAt);
      await scoped.manualAlexaVoc.lockScopes({
        organizationId: input.actorOrganizationId,
        marketplace: input.marketplace,
        asins: [input.asin],
      });
      const expectedRevision = await scoped.manualAlexaVoc.peekNextRevision({
        organizationId: input.actorOrganizationId,
        marketplace: input.marketplace,
        asin: input.asin,
      });
      const write = await scoped.manualAlexaVoc.putCommittedNormalization({
        organizationId: input.actorOrganizationId,
        marketplace: input.marketplace,
        asin: input.asin,
        createdBy: input.actorId,
        expectedRevision,
        normalizedRecord: input.normalizedRecord,
        normalizedSchemaVersion: input.normalizedSchemaVersion,
        parserVersion: input.parserVersion,
        contentHash: input.contentHash,
        rawReportSha256: input.rawReportSha256,
        rawReportPlaintextBytes: input.rawReportPlaintextBytes,
        capturedAt: input.capturedAt,
      });
      return write.record;
    }),
    publishRevision: (persisted) => retryableNormalizationPublication(
      () => repository.transaction(async (baseRepository) => {
        const scoped = baseRepository as RuntimeAgentRepository;
        const committedAt = await scoped.manualAlexaVoc.readDatabaseClock();
        const subject = await trustedNormalizationCommitSubject(scoped, input, committedAt);
        const committed = await scoped.manualAlexaVoc.findCommittedNormalizationByFingerprint({
          actorOrganizationId: input.actorOrganizationId,
          marketplace: input.marketplace,
          asin: input.asin,
          executionFingerprint: input.contentHash,
          dataCutoffAt: subject.dataCutoffAt,
        });
        if (
          !committed ||
          committed.asin !== input.asin ||
          committed.revision !== persisted.revision ||
          committed.contentHash !== input.contentHash
        ) {
          throw trustedSubjectError();
        }
        await scoped.manualAlexaVoc.putNormalizationTerminal({
          snapshotId: input.snapshotId,
          runId: input.runId,
          jobAttemptId: input.jobAttemptId,
          agentRunId: input.agentRunId,
          asin: input.asin,
          executionFingerprint: input.contentHash,
          status: "success",
          category: null,
          completedAt: committedAt,
        });
        const publication = await publishCumulativeVocSnapshotAndWake(scoped, {
          positioningMode,
          actorId: input.actorId,
          actorOrganizationId: input.actorOrganizationId,
          projectId: input.projectId,
          runId: input.runId,
          asins: subject.asins,
          dataCutoffAt: subject.dataCutoffAt,
          createdAt: committedAt,
        });
        return Object.freeze({
          revision: persisted,
          wakeCreated: publication.snapshotCreated || publication.wakeCreated,
        });
      }),
    ),
  });
}

export type AlexaVocCumulativePublicationInput = Readonly<{
  positioningMode?: VocPositioningMode;
  actorId: string;
  actorOrganizationId: string;
  projectId: string;
  runId: string;
  asins: readonly string[];
  dataCutoffAt: string;
  createdAt: string;
}>;

export async function publishCumulativeVocSnapshotAndWake(
  repository: RuntimeAgentRepository,
  input: AlexaVocCumulativePublicationInput,
): Promise<Readonly<{ snapshotCreated: boolean; wakeCreated: boolean }>> {
  const storedRevisions = await repository.manualAlexaVoc.listAtCutoff({
    organizationId: input.actorOrganizationId,
    marketplace: "US",
    asins: input.asins,
    dataCutoffAt: input.dataCutoffAt,
  });
  // Store ordering is lexical; snapshot records and provenance must follow the
  // trusted project's target order, including when only a subset is ready.
  const byAsin = new Map(storedRevisions.map((revision) => [revision.asin, revision]));
  if (byAsin.size !== storedRevisions.length ||
    new Set(input.asins).size !== input.asins.length ||
    storedRevisions.some((revision) => !input.asins.includes(revision.asin))) {
    throw trustedSubjectError();
  }
  const revisions = input.asins.flatMap((asin) => {
    const revision = byAsin.get(asin);
    return revision ? [revision] : [];
  });
  if (revisions.length === 0) {
    throw new WorkerTaskError("infrastructure", "Committed Alexa VOC revision was not readable");
  }
  const candidate = buildVocSnapshotCandidate({
    marketplace: "US",
    asins: input.asins,
    dataCutoffAt: input.dataCutoffAt,
    sourceBundles: [{
      sourceId: "alexa-voc",
      type: "manual-voc",
      reference: VOC_SOURCE_REFERENCES.manualAlexaVocRepository,
      marketplace: "US",
      capturedAt: revisions.reduce(
        (latest, revision) => latest > revision.capturedAt ? latest : revision.capturedAt,
        revisions[0]!.capturedAt,
      ),
      records: revisions.map((revision) => revision.normalizedRecord),
      recordProvenance: revisions.map((revision) => ({
        asin: revision.asin,
        revision: revision.revision,
        contentHash: revision.contentHash,
        source: "repository" as const,
        generation: null,
        capturedAt: revision.capturedAt,
        normalizedSchemaVersion: revision.normalizedSchemaVersion,
        parserVersion: revision.parserVersion,
      })),
    }],
  });
  const snapshot = await repository.createDataSnapshotForRun({
    actorId: input.actorId,
    actorOrganizationId: input.actorOrganizationId,
    runId: input.runId,
    expectedProjectId: input.projectId,
    expectedMarketplace: "US",
    expectedAsins: input.asins,
    expectedRunCutoffAt: input.dataCutoffAt,
    candidateId: randomUUID(),
    createdAt: input.createdAt,
    candidate,
  });
  // Normalization is also used by local rules. Saving its evidence must not
  // silently start a separate model analysis or invalidate historical reports.
  const wakeCreated = snapshot.created && input.positioningMode === "model"
    ? await wakeVocPositioning(repository, input.runId, input.createdAt)
    : false;
  return Object.freeze({ snapshotCreated: snapshot.created, wakeCreated });
}

async function recordReplayedNormalizationTerminal(
  repository: RuntimeAgentRepository,
  replay: Readonly<{
    job: Readonly<{
      id: string;
      runId: string;
      stageId: string;
      leasedBy: string | null;
      leaseGeneration: number;
    }>;
    snapshotId: string;
    asin: string;
    executionFingerprint: string;
    agentRunId: string;
    revision: string;
  }>,
  completedAt: string,
  positioningMode: VocPositioningMode,
): Promise<void> {
  if (!replay.job.leasedBy) throw trustedSubjectError();
  await retryableNormalizationPublication(() => repository.transaction(async (baseRepository) => {
    const scoped = baseRepository as RuntimeAgentRepository;
    const subject = await trustedNormalizationSubject(scoped, replay.job.runId);
    const jobs = await scoped.listJobAttempts(replay.job.stageId);
    const job = jobs.find((candidate) => candidate.id === replay.job.id);
    const snapshot = await scoped.manualAlexaVoc.findNormalizationInputSnapshot({
      actorOrganizationId: subject.organizationId,
      snapshotId: replay.snapshotId,
    });
    const committed = await scoped.manualAlexaVoc
      .findCommittedNormalizationReplayByFingerprint({
        actorOrganizationId: subject.organizationId,
        marketplace: "US",
        asin: replay.asin,
        executionFingerprint: replay.executionFingerprint,
        dataCutoffAt: subject.dataCutoffAt,
      });
    if (
      !job ||
      job.status !== "running" ||
      job.leasedBy !== replay.job.leasedBy ||
      job.leaseGeneration !== replay.job.leaseGeneration ||
      !job.leaseExpiresAt ||
      Date.parse(job.leaseExpiresAt) <= Date.parse(completedAt) ||
      !snapshot ||
      snapshot.runId !== replay.job.runId ||
      snapshot.asin !== replay.asin ||
      snapshot.executionFingerprint !== replay.executionFingerprint ||
      !committed ||
      committed.agentRunId !== replay.agentRunId ||
      committed.revision.revision !== replay.revision ||
      committed.revision.asin !== replay.asin ||
      committed.revision.contentHash !== replay.executionFingerprint
    ) throw trustedSubjectError();
    await scoped.manualAlexaVoc.putNormalizationTerminal({
      snapshotId: replay.snapshotId,
      runId: replay.job.runId,
      jobAttemptId: replay.job.id,
      agentRunId: replay.agentRunId,
      asin: replay.asin,
      executionFingerprint: replay.executionFingerprint,
      status: "success",
      category: null,
      completedAt,
    });
    await publishCumulativeVocSnapshotAndWake(scoped, {
      positioningMode,
      actorId: subject.actorId,
      actorOrganizationId: subject.organizationId,
      projectId: subject.projectId,
      runId: replay.job.runId,
      asins: subject.asins,
      dataCutoffAt: subject.dataCutoffAt,
      createdAt: completedAt,
    });
  }));
}

async function recordFailedNormalizationTerminal(
  repository: RuntimeAgentRepository,
  terminal: Readonly<{
    job: Readonly<{
      id: string;
      runId: string;
      stageId: string;
      leasedBy: string | null;
      leaseGeneration: number;
    }>;
    snapshotId: string;
    asin: string;
    executionFingerprint: string | null;
    category: "model-output" | "schema" | "persistence" | "authorization" | null;
  }>,
  completedAt: string,
): Promise<void> {
  await repository.transaction(async (baseRepository) => {
    const scoped = baseRepository as RuntimeAgentRepository;
    const subject = await trustedNormalizationSubject(scoped, terminal.job.runId);
    const jobs = await scoped.listJobAttempts(terminal.job.stageId);
    const job = jobs.find((candidate) => candidate.id === terminal.job.id);
    if (
      !job ||
      job.status !== "running" ||
      !terminal.job.leasedBy ||
      job.leasedBy !== terminal.job.leasedBy ||
      job.leaseGeneration !== terminal.job.leaseGeneration ||
      !job.leaseExpiresAt ||
      Date.parse(job.leaseExpiresAt) <= Date.parse(completedAt)
    ) throw trustedSubjectError();
    const snapshot = await scoped.manualAlexaVoc.findNormalizationInputSnapshot({
      actorOrganizationId: subject.organizationId,
      snapshotId: terminal.snapshotId,
    });
    if (!snapshot || snapshot.asin !== terminal.asin) throw trustedSubjectError();
    const fingerprint = terminal.executionFingerprint ?? snapshot.executionFingerprint;
    const agentRuns = await scoped.listAgentRuns({
      organizationId: subject.organizationId,
      runId: terminal.job.runId,
    });
    const agentRun = agentRuns.find((candidate) =>
      candidate.stageId === terminal.job.stageId &&
      candidate.jobAttemptId === terminal.job.id &&
      candidate.executionFingerprint === fingerprint &&
      candidate.snapshotIds.length === 1 &&
      candidate.snapshotIds[0] === terminal.snapshotId &&
      candidate.validationStatus === "failed"
    );
    await scoped.manualAlexaVoc.putNormalizationTerminal({
      snapshotId: terminal.snapshotId,
      runId: terminal.job.runId,
      jobAttemptId: terminal.job.id,
      agentRunId: agentRun?.id ?? null,
      asin: terminal.asin,
      executionFingerprint: fingerprint,
      status: "failure",
      category: terminal.category ?? "persistence",
      completedAt,
    });
  });
}

async function finalizeNormalizationJob(
  repository: RuntimeAgentRepository,
  job: Readonly<{
    id: string;
    runId: string;
    stageId: string;
    leasedBy: string | null;
    leaseGeneration: number;
  }>,
  completedAt: string,
): Promise<boolean> {
  if (!job.leasedBy) throw trustedSubjectError();
  const ownerId = job.leasedBy;
  return repository.transaction(async (baseRepository) => {
    const scoped = baseRepository as RuntimeAgentRepository;
    const subject = await trustedNormalizationSubject(scoped, job.runId);
    await scoped.manualAlexaVoc.lockNormalizationRunAndStage({ runId: job.runId });
    const snapshots = await scoped.manualAlexaVoc.listNormalizationInputSnapshots({
      actorOrganizationId: subject.organizationId,
      projectId: subject.projectId,
      runId: job.runId,
      jobAttemptId: job.id,
    });
    const terminals = await scoped.manualAlexaVoc.listNormalizationTerminals({
      actorOrganizationId: subject.organizationId,
      projectId: subject.projectId,
      runId: job.runId,
    });
    const terminalSnapshotIds = new Set(
      terminals.map((terminal) => terminal.snapshotId),
    );
    const jobs = await scoped.listJobAttempts(job.stageId);
    const current = jobs.find((attempt) => attempt.id === job.id);
    const cycleJobs = new Set(jobs.filter((attempt) => attempt.logicalExecutionCycleId === current?.logicalExecutionCycleId).map((attempt) => attempt.id));
    const audits = (await scoped.listAgentRuns({ organizationId: subject.organizationId, runId: job.runId }))
      .filter((audit) => audit.stageId === job.stageId && cycleJobs.has(audit.jobAttemptId ?? ""));
    const hasSuccessor = current && jobs.some((attempt) => attempt.attemptNumber > current.attemptNumber);
    if (snapshots.some((snapshot) => !terminalSnapshotIds.has(snapshot.id) && !(current?.reportPublicationMaxAttempts !== null && hasSuccessor && !audits.some((audit) => audit.snapshotIds.includes(snapshot.id))))) return false;
    const cancelled = audits.some((audit) => audit.terminalMetadata?.kind === "cancelled");
    const budget = audits.find((audit) => audit.terminalMetadata?.kind === "budget-exceeded")?.terminalMetadata;
    if (cancelled || budget?.kind === "budget-exceeded") {
      await scoped.failJob({
        jobId: job.id, ownerId, leaseGeneration: job.leaseGeneration,
        failedAt: completedAt, retryable: false, retryAt: null,
        attemptStatus: cancelled ? "cancelled" : "failed",
        stageStatus: cancelled ? "cancelled" : "budget-exceeded",
        error: cancelled
          ? { classification: "cancelled", code: "CANCELLED", message: "Skill execution was cancelled" }
          : { ...budget, classification: "configuration", code: "CONFIGURATION_ERROR", message: "Configured model budget was exceeded" },
      });
      return true;
    }
    await scoped.completeJob({
      jobId: job.id,
      ownerId,
      leaseGeneration: job.leaseGeneration,
      completedAt,
    });
    return true;
  });
}

export async function wakeVocPositioning(
  repository: RuntimeAgentRepository,
  runId: string,
  now: string,
): Promise<boolean> {
  const stages = await repository.listRunStages(runId);
  let stage = stages.find((candidate) => candidate.stage === "voc-positioning");
  if (!stage) {
    stage = await repository.createRunStage({
      id: randomUUID(),
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
    await repository.enqueueJob({
      id: randomUUID(),
      stageId: stage.id,
      attemptNumber: 1,
      maxAttempts: 3,
      availableAt: now,
      createdAt: now,
    });
    return true;
  }
  if (stage.status === "waiting-input") {
    return (await repository.resumeWaitingInputRunStage({
      runId,
      stageId: stage.id,
      resumedAt: now,
    })) !== null;
  }
  if (stage.status === "running" || stage.status === "queued") {
    const jobs = await repository.listJobAttempts(stage.id);
    // A never-started successor will read the latest snapshot. A released old
    // execution retains startedAt and must not inherit the new input's cycle.
    if (jobs.some((job) => job.status === "queued" && job.startedAt === null)) return false;
    const latestAttempt = jobs.reduce(
      (latest, job) => Math.max(latest, job.attemptNumber),
      0,
    );
    const latestMaxAttempts = jobs.reduce(
      (latest, job) => Math.max(latest, job.maxAttempts),
      3,
    );
    const attemptNumber = latestAttempt + 1;
    await repository.enqueueJob({
      id: randomUUID(),
      stageId: stage.id,
      attemptNumber,
      maxAttempts: Math.max(latestMaxAttempts, attemptNumber + 2),
      supersedeVocPredecessors: true,
      availableAt: now,
      createdAt: now,
    });
    return true;
  }
  if (stage.status === "succeeded") {
    const staleStageIds = stages
      .filter((candidate) =>
        candidate.stage === "product-definition" && candidate.status === "succeeded"
      )
      .map((candidate) => candidate.id);
    return (await repository.retryFailedRunStage({
      runId,
      stageId: stage.id,
      staleStageIds,
      jobId: randomUUID(),
      retriedAt: now,
      maxAutomaticAttempts: 3,
    })) !== null;
  }
  return false;
}

function trustedSubjectError() {
  return new WorkerTaskError(
    "configuration",
    "Alexa VOC normalization trusted subject is unavailable",
  );
}
