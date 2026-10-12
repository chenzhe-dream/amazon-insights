import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBoundedTail,
  parseProviderDiagnosticOutput,
} from "../../scripts/lib/provider-diagnostics.mjs";
import { StageOutputGapSchema } from "../../shared/agent-contracts";
import { detachedProviderEnvironment } from "../../scripts/lib/provider-network.mjs";
import { mutateSyncJobMirror } from "../../scripts/lib/sync-job-store.mjs";

import {
  SyncJobLeaseLostError,
  type SyncJobLease,
  type SyncJobModuleRecord,
  type SyncJobRecord,
  type SyncJobRepository,
  type SyncJobStageRecord,
  type StageOutputDraft,
  type SyncCatalogCapture,
} from "../db/sync-job-repository";
import { WorkerTaskError } from "../runtime/retry-policy";
import {
  copySifTrafficShapeDiagnostic,
  SifTrafficSnapshotTaskError,
  SifTrafficSnapshotExecutionError,
} from "./sif-traffic-snapshot-task";

type RunnerResult = {
  readonly status?: string;
  readonly message?: string;
};

export type SyncJobRunnerContext = {
  readonly workerId: string;
  readonly leaseGeneration: number;
  readonly mirrorPath: string;
  readonly abortSignal?: AbortSignal;
  writeMirror(patch: Record<string, unknown>): Promise<void>;
};

export type SyncJobRunner = (
  lease: SyncJobLease,
  context: SyncJobRunnerContext,
) => Promise<RunnerResult | void>;

export type SyncJobWorkerHandlerOptions = {
  readonly syncJobs: SyncJobRepository;
  /** @deprecated Worker mirror data no longer publishes connector health. */
  readonly connectorStatuses?: unknown;
  readonly mirrorDirectory?: string;
  readonly runner?: SyncJobRunner;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatLeaseMs?: number;
  readonly progressPollMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => string;
  readonly rootDirectory?: string;
  readonly connectorCredentialEnvironment?: (
    organizationId: string,
  ) => Promise<Readonly<Record<string, string | undefined>>>;
  readonly dynamicTrafficSnapshotAdapter?: {
    createForAuthorizedRun(input: {
      actorId: string;
      organizationId: string;
      projectId: string;
      runId: string;
      marketplace: "US";
      asins: readonly string[];
    }): Promise<unknown>;
  };
};

export type DetachedRunnerOptions = {
  readonly runnerPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly diagnosticBytes?: number;
  readonly resolveConnectorEnvironment?: (
    organizationId: string,
  ) => Promise<Readonly<Record<string, string | undefined>>>;
};

const defaultHeartbeatIntervalMs = 10_000;
const defaultLeaseMs = 60_000;
const defaultProgressPollMs = 500;
const defaultMaxAttempts = 3;
const terminalSuccessStatuses = new Set(["completed", "completed-with-gaps"]);
const moduleStatuses = new Set([
  "ready",
  "upstream-empty",
  "timeout",
  "connector-failed",
  "pending",
  "manual",
]);
const abortedRunner = Symbol("aborted-sync-runner");
const lostLeaseRunner = Symbol("lost-sync-lease");

export class SyncJobWorkerHandler {
  readonly #syncJobs: SyncJobRepository;
  readonly #mirrorDirectory: string;
  readonly #runner: SyncJobRunner;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatLeaseMs: number;
  readonly #progressPollMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => string;
  readonly #dynamicTrafficSnapshotAdapter?: SyncJobWorkerHandlerOptions["dynamicTrafficSnapshotAdapter"];

  constructor(options: SyncJobWorkerHandlerOptions) {
    const root = options.rootDirectory ?? process.cwd();
    this.#syncJobs = options.syncJobs;
    this.#mirrorDirectory =
      options.mirrorDirectory ?? path.join(root, "data", "sync-jobs");
    this.#runner = options.runner ?? createDetachedRunner(root, {
      resolveConnectorEnvironment: options.connectorCredentialEnvironment,
    });
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
    this.#heartbeatLeaseMs = options.heartbeatLeaseMs ?? defaultLeaseMs;
    this.#progressPollMs = options.progressPollMs ?? defaultProgressPollMs;
    this.#maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#dynamicTrafficSnapshotAdapter = options.dynamicTrafficSnapshotAdapter;
  }

  async handle(lease: SyncJobLease, abortSignal?: AbortSignal): Promise<void> {
    const workerId = lease.job.leasedBy;
    if (!workerId) return;
    const mirrorPath = await this.#writeInitialMirror(lease.job);
    let stopped = false;
    let reportBackgroundFailure!: (error: unknown) => void;
    const backgroundFailure = new Promise<typeof lostLeaseRunner>((resolve, reject) => {
      reportBackgroundFailure = (error) => {
        if (error instanceof SyncJobLeaseLostError) {
          resolve(lostLeaseRunner);
          return;
        }
        reject(error);
      };
    });
    const heartbeat = setInterval(() => {
      void this.#syncJobs
        .heartbeat({
          jobId: lease.job.jobId,
          leaseGeneration: lease.leaseGeneration,
          workerId,
          heartbeatAt: this.#now(),
          leaseMs: this.#heartbeatLeaseMs,
        })
        .catch(reportBackgroundFailure);
    }, this.#heartbeatIntervalMs);
    heartbeat.unref?.();
    let progressQueue: Promise<unknown> = Promise.resolve();
    const pollProgress = () => {
      const result = progressQueue.then(() => this.#mirrorProgress(lease, workerId));
      progressQueue = result.catch(reportBackgroundFailure);
      return result;
    };
    const progressPoll = setInterval(() => {
      void pollProgress().catch(() => undefined);
    }, this.#progressPollMs);
    progressPoll.unref?.();
    let runnerAbortController: AbortController | null = null;
    let runnerPromise: Promise<RunnerResult | void> | null = null;

    try {
      const explicitResumeStages = lease.job.error?.code === "SYNC_JOB_EXPLICIT_RESUME"
        ? safeResumeStages(lease.job.error.resumeStages)
        : [];
      const shouldRunCanonicalTraffic = explicitResumeStages.length === 0 ||
        explicitResumeStages.includes("traffic");
      if (
        shouldRunCanonicalTraffic &&
        await this.#runCanonicalTrafficSnapshot(lease, abortSignal)
      ) return;
      if (abortSignal?.aborted) return;
      runnerAbortController = new AbortController();
      const context: SyncJobRunnerContext = {
        workerId,
        leaseGeneration: lease.leaseGeneration,
        mirrorPath,
        abortSignal: runnerAbortController.signal,
        writeMirror: async (patch) => {
          await mergeMirror(mirrorPath, patch);
        },
      };
      runnerPromise = this.#runner(lease, context);
      const result = await runUntilAbort(
        runnerPromise,
        abortSignal,
        backgroundFailure,
      );
      stopped = true;
      clearInterval(progressPoll);
      clearInterval(heartbeat);
      if (result === abortedRunner || result === lostLeaseRunner) {
        await abortAndSettleRunner(runnerAbortController, runnerPromise);
        await progressQueue;
        return;
      }
      await progressQueue;
      const mirrored = await pollProgress();
      const status = String(
        result?.status ?? mirrored?.status ?? "completed",
      );
      const message = sanitizeMessage(
        result?.message ?? mirrored?.message ?? "同步任务已完成",
      );
      if (terminalSuccessStatuses.has(status)) {
        const catalogCapture = catalogCaptureFromMirror(mirrored);
        await ignoreLeaseLoss(() =>
          this.#syncJobs.complete({
            jobId: lease.job.jobId,
            leaseGeneration: lease.leaseGeneration,
            workerId,
            completedAt: this.#now(),
            message,
            ...(catalogCapture ? { catalogCapture } : {}),
          }),
        );
      } else if (status === "failed") {
        await ignoreLeaseLoss(() =>
          this.#syncJobs.fail({
            jobId: lease.job.jobId,
            leaseGeneration: lease.leaseGeneration,
            workerId,
            failedAt: this.#now(),
            message,
            error: { code: "SYNC_JOB_FAILED" },
          }),
        );
      }
    } catch (error) {
      if (!stopped) {
        clearInterval(progressPoll);
        clearInterval(heartbeat);
      }
      await abortAndSettleRunner(runnerAbortController, runnerPromise);
      await progressQueue;
      await ignoreLeaseLoss(() =>
        this.#syncJobs.fail({
          jobId: lease.job.jobId,
          leaseGeneration: lease.leaseGeneration,
          workerId,
          failedAt: this.#now(),
          message: sanitizeMessage(error instanceof Error ? error.message : String(error)),
          error: { code: "SYNC_JOB_RUNNER_ERROR" },
        }),
      );
    } finally {
      clearInterval(progressPoll);
      clearInterval(heartbeat);
    }
  }

  async #runCanonicalTrafficSnapshot(
    lease: SyncJobLease,
    abortSignal?: AbortSignal,
  ): Promise<boolean> {
    const { job } = lease;
    const adapter = this.#dynamicTrafficSnapshotAdapter;
    const { projectId, runId, actorId } = job;
    if (!adapter || !projectId || !runId || !actorId) return false;
    const owns = this.#syncJobs.ownsCanonicalTrafficRun;
    const begin = this.#syncJobs.beginCanonicalTrafficRun;
    const settle = this.#syncJobs.settleCanonicalTrafficRun;
    if (!owns) throw new Error("Canonical sync run ownership is unavailable");
    const ownsLifecycle = await owns.call(this.#syncJobs, {
      jobId: job.jobId,
      runId,
      actorId,
    });
    const createSnapshot = () => adapter.createForAuthorizedRun({
      actorId,
      organizationId: job.organizationId,
      projectId,
      runId,
      marketplace: job.marketplace,
      asins: job.asins,
    });
    if (!ownsLifecycle) {
      if (!abortSignal?.aborted) await createSnapshot().catch(() => undefined);
      return false;
    }
    if (!begin || !settle) throw new Error("Canonical sync run lifecycle is unavailable");
    const started = await begin.call(this.#syncJobs, {
      jobId: job.jobId,
      runId,
      actorId,
      leaseGeneration: lease.leaseGeneration,
      workerId: job.leasedBy!,
      maxAttempts: this.#maxAttempts,
      startedAt: this.#now(),
    });
    if (started === "exhausted") return true;
    if (started !== "started") {
      throw new Error("Canonical sync run lifecycle rejected the active job");
    }
    let outcome: "succeeded" | "partial" | "failed" | "cancelled" = "succeeded";
    let error: Record<string, unknown> | null = null;
    try {
      if (abortSignal?.aborted) {
        outcome = "cancelled";
        error = { code: "SYNC_TRAFFIC_CANCELLED" };
      } else {
        await createSnapshot();
      }
    } catch (snapshotError) {
      const category = snapshotError instanceof WorkerTaskError
        ? snapshotError.category
        : "infrastructure";
      outcome = category === "cancelled"
        ? "cancelled"
        : ["rate-limit", "upstream-temporary", "upstream-permanent", "data-quality"]
            .includes(category)
        ? "partial"
        : "failed";
      const shapeDiagnostic = snapshotError instanceof SifTrafficSnapshotTaskError
        ? copySifTrafficShapeDiagnostic(snapshotError.shapeDiagnostic)
        : undefined;
      error = snapshotError instanceof SifTrafficSnapshotTaskError
        ? {
            code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
            category,
            asin: snapshotError.asin,
            operation: snapshotError.operation,
            reasonCode: snapshotError.reasonCode,
            ...(shapeDiagnostic
              ? { shapeDiagnostic }
              : {}),
          }
        : snapshotError instanceof SifTrafficSnapshotExecutionError
        ? { code: "SYNC_TRAFFIC_SNAPSHOT_FAILED", category, phase: snapshotError.phase,
            reasonCode: snapshotError.reasonCode, ...(snapshotError.asin ? {asin: snapshotError.asin} : {}),
            ...(snapshotError.operation ? {operation: snapshotError.operation} : {}) }
        : { code: "SYNC_TRAFFIC_SNAPSHOT_FAILED", category };
    }
    const settled = await settle.call(this.#syncJobs, {
      jobId: job.jobId,
      runId,
      outcome,
      settledAt: this.#now(),
      error,
    });
    if (!settled) throw new Error("Canonical sync run lifecycle could not be settled");
    return false;
  }

  async #writeInitialMirror(job: SyncJobRecord): Promise<string> {
    await mkdir(this.#mirrorDirectory, { recursive: true });
    const mirrorPath = path.join(this.#mirrorDirectory, `${job.jobId}.json`);
    const outputs = await this.#readPersistedOutputs(job);
    const persistedStageContentHashes = Object.fromEntries(outputs
      .map((output) => [output.stage, output.contentHash])
      .sort(([left], [right]) => left.localeCompare(right)));
    await mutateSyncJobMirror(mirrorPath, (current: Record<string, unknown> | null) => {
      const diagnostic = toDiagnosticMirror(job);
      const resetFields = new Set([
        "outputs", "persistedStageContentHashes", "publication", "needsReload", "jobVersion", "catalogCapture",
      ]);
      const preserved = Object.fromEntries(
        Object.entries(current ?? {}).filter(([key]) => !resetFields.has(key)),
      );
      return {
        ...preserved,
        ...diagnostic,
        outputs,
        persistedStageContentHashes,
      };
    });
    return mirrorPath;
  }

  async #readPersistedOutputs(job: SyncJobRecord): Promise<readonly StageOutputDraft[]> {
    if (!job.projectId || !job.runId || typeof this.#syncJobs.readStageOutput !== "function") return [];
    const projectId = job.projectId;
    const runId = job.runId;
    const projections = await Promise.all([...projectableStageIds].map((stage) =>
      this.#syncJobs.readStageOutput({
        organizationId: job.organizationId,
        projectId,
        runId,
        jobId: job.jobId,
        stage: stage as StageOutputDraft["stage"],
      })
    ));
    return projections.flatMap((projection) => projection ? [{
      organizationId: job.organizationId,
      projectId,
      runId,
      stage: projection.stage,
      stageStatus: projection.stageStatus,
      contentHash: projection.contentHash,
      updatedAt: projection.updatedAt,
      ...(projection.data ? { data: projection.data } : {}),
      ...(projection.gap ? { gap: projection.gap } : {}),
    }] : []);
  }

  async #mirrorProgress(
    lease: SyncJobLease,
    workerId: string,
  ): Promise<Record<string, unknown> | null> {
    const mirror = await readMirror(
      path.join(this.#mirrorDirectory, `${lease.job.jobId}.json`),
    );
    if (!mirror) return null;
    const outputs = stageOutputPatches(mirror, lease.job);
    const outputStages = new Set(outputs.map((output) => output.stage));
    const stage = rejectUnbackedTerminalStage(stagePatch(mirror), outputStages);
    const stages = stagePatches(mirror).flatMap((patch) => {
      const safe = rejectUnbackedTerminalStage(patch, outputStages);
      return safe ? [safe] : [];
    });
    const updatedJob = await this.#syncJobs.recordProgress({
      jobId: lease.job.jobId,
      leaseGeneration: lease.leaseGeneration,
      workerId,
      recordedAt: this.#now(),
      currentStageId: typeof mirror.currentStageId === "string"
        ? mirror.currentStageId
        : undefined,
      stage,
      stages,
      modules: modulePatches(mirror),
      outputs,
      message: typeof mirror.message === "string"
        ? sanitizeMessage(mirror.message)
        : undefined,
    });
    let persistedView = null;
    try {
      persistedView = await mergeCurrentPublicationView(
        path.join(this.#mirrorDirectory, `${lease.job.jobId}.json`),
        lease.job,
        updatedJob,
        outputs,
      );
    } catch {}
    return persistedView === null ? mirror : { ...mirror, ...persistedView };
  }
}

export function createDetachedRunner(
  root: string,
  options: DetachedRunnerOptions = {},
): SyncJobRunner {
  return async (lease, context) => {
    const runnerPath = options.runnerPath ?? path.join(root, "scripts", "run-asin-sync-job.mjs");
    const networkBootstrap = pathToFileURL(
      path.join(root, "scripts", "lib", "provider-network-bootstrap.mjs"),
    ).href;
    const connectorEnvironment = await options.resolveConnectorEnvironment?.(
      lease.job.organizationId,
    ) ?? {};
    const allowedConnectorEnvironment = new Set([
      "SIF_MCP_SECRET",
      "SORFTIME_MCP_KEY",
      "SELLERSPRITE_SECRET_KEY",
    ]);
    for (const [key, value] of Object.entries(connectorEnvironment)) {
      if (!allowedConnectorEnvironment.has(key) || (value !== undefined && typeof value !== "string")) {
        throw new Error("Invalid resolved connector environment");
      }
    }
    await new Promise<void>((resolve, reject) => {
      const stdout = createBoundedTail(options.diagnosticBytes);
      const stderr = createBoundedTail(options.diagnosticBytes);
      const child = spawn(process.execPath, ["--import", networkBootstrap, runnerPath, lease.job.jobId], {
        cwd: root,
        detached: false,
        stdio: ["ignore", "pipe", "pipe"],
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        env: detachedProviderEnvironment(process.env, {
          ...options.environment,
          ...connectorEnvironment,
          ALEXA_AUTO: process.env.ALEXA_AUTO ?? "1",
          AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1",
          AGENT_EXECUTION_ORGANIZATION_ID: lease.job.organizationId,
          AGENT_SYNC_JOB_ID: lease.job.jobId,
          AGENT_RESOURCE_GOVERNOR_OWNER_ID: context.workerId,
          AGENT_XYDC_PROJECT_ID: lease.job.projectId ?? "",
          AGENT_XYDC_RUN_ID: lease.job.runId ?? "",
          AGENT_XYDC_LEASE_GENERATION: String(lease.leaseGeneration),
          AGENT_RESOURCE_ATTEMPT_KIND:
            lease.job.error?.code === "SYNC_JOB_EXPLICIT_RESUME" &&
            safeResumeStages(lease.job.error.resumeStages).length > 0
              ? "repair"
              : "initial",
        }),
      });
      child.stdout?.on("data", (chunk) => stdout.append(chunk));
      child.stderr?.on("data", (chunk) => stderr.append(chunk));
      let childError: unknown;
      child.once("error", (error) => {
        childError ??= error;
      });
      child.once("close", async (code, signal) => {
        const diagnostics = parseProviderDiagnosticOutput(`${stdout.text()}\n${stderr.text()}`);
        try {
          await context.writeMirror({ diagnostics });
        } catch {}
        if (childError !== undefined) {
          reject(childError);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        // Contract failures are fixed messages with bounded ASIN/index suffixes.
        // Do not copy arbitrary subprocess stderr (which may contain credentials).
        const imageContractFailure = stderr.text().split(/\r?\n/).findLast(line =>
          /^\[error\] (?:Image listing (?:stage (?:output is missing or ambiguous|scope mismatch|has no usable data|content hash mismatch|data is missing)|ASIN scope mismatch|gallery unavailable for [A-Z0-9]{10})|Image candidate (?:job identity mismatch|ASIN scope mismatch|listing content hash mismatch|content hash mismatch|(?:gallery\/index mismatch|remark URL\/index mismatch|outcome\/index mismatch|ready outcome has no remark|listing URL\/index mismatch) for [A-Z0-9]{10}(?::\d+)?)|Persisted image stage (?:content hash mismatch|scope mismatch|data is missing|maps are invalid|ASIN scope mismatch|omits a ready ASIN|is incomplete for a ready ASIN)|Successful image worker did not persist its job candidate)$/.test(line));
        const detail = imageContractFailure ? `: ${imageContractFailure.slice(8, 508)}` : "";
        reject(new Error(`sync runner exited ${signal ?? code}${detail}`));
      });
    });
  };
}

async function runUntilAbort(
  runner: Promise<RunnerResult | void>,
  abortSignal: AbortSignal | undefined,
  backgroundFailure: Promise<typeof lostLeaseRunner>,
): Promise<RunnerResult | void | typeof abortedRunner | typeof lostLeaseRunner> {
  const promises: Promise<RunnerResult | void | typeof abortedRunner | typeof lostLeaseRunner>[] = [
    runner,
    backgroundFailure,
  ];
  if (!abortSignal) return await Promise.race(promises);
  if (abortSignal.aborted) return abortedRunner;
  let onAbort!: () => void;
  const externalAbort = new Promise<typeof abortedRunner>((resolve) => {
    onAbort = () => resolve(abortedRunner);
    abortSignal.addEventListener("abort", onAbort, { once: true });
    if (abortSignal.aborted) resolve(abortedRunner);
  });
  try {
    return await Promise.race([...promises, externalAbort]);
  } finally {
    abortSignal.removeEventListener("abort", onAbort);
  }
}

async function abortAndSettleRunner(
  controller: AbortController | null,
  runner: Promise<RunnerResult | void> | null,
): Promise<void> {
  if (!controller || !runner) return;
  if (!controller.signal.aborted) controller.abort();
  try {
    await runner;
  } catch {
    // The caller retains the authoritative background or runner failure.
  }
}

function toDiagnosticMirror(job: SyncJobRecord): Record<string, unknown> {
  const resumeStages = safeResumeStages(job.error?.resumeStages);
  return {
    jobId: job.jobId,
    asins: [...job.asins],
    marketplace: job.marketplace,
    status: job.status,
    message: job.message,
    currentStageId: job.currentStageId,
    stages: job.stages,
    asinProgress: job.asinProgress,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    dynamicSnapshot: "pending",
    ...(job.projectId && job.runId && Number.isSafeInteger(job.jobVersion) && Number(job.jobVersion) > 0
      ? { jobVersion: job.jobVersion }
      : {}),
    scope: {
      organizationId: job.organizationId,
      projectId: job.projectId ?? "unscoped",
      runId: job.runId,
      marketplace: job.marketplace,
      asins: [...job.asins],
    },
    fingerprint: job.fingerprint,
    ...(resumeStages.length > 0 ? { resumeStages } : {}),
  };
}

const knownSyncStageIds = new Set([
  "catalog", "keywords", "reviews", "sales_trend", "child_sales",
  "price_strategy", "fba", "listing", "category", "traffic",
  "image_remarks", "build",
]);

function safeResumeStages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((stage): stage is string =>
    typeof stage === "string" && knownSyncStageIds.has(stage)
  ))];
}

async function mergeMirror(
  mirrorPath: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await mutateSyncJobMirror(mirrorPath, (current: Record<string, unknown> | null) =>
    redactDiagnosticMirror({ ...(current ?? {}), ...patch })
  );
}

async function readMirror(mirrorPath: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(mirrorPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function catalogCaptureFromMirror(mirror: Record<string, unknown> | null): SyncCatalogCapture | undefined {
  const value = mirror?.catalogCapture;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const capture = value as Record<string, unknown>;
  const evidence = capture.evidence;
  if (!Array.isArray(capture.catalog) || !evidence || typeof evidence !== "object" || Array.isArray(evidence)) return undefined;
  return capture as SyncCatalogCapture;
}

function stagePatch(
  mirror: Record<string, unknown>,
): (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">) | undefined {
  const currentStageId = typeof mirror.currentStageId === "string"
    ? mirror.currentStageId
    : null;
  if (!currentStageId || !Array.isArray(mirror.stages)) return undefined;
  const stage = mirror.stages.find((candidate) =>
    candidate &&
    typeof candidate === "object" &&
    "id" in candidate &&
    candidate.id === currentStageId
  );
  if (!stage || typeof stage !== "object") return undefined;
  const record = stage as Record<string, unknown>;
  return {
    id: currentStageId,
    ...(typeof record.status === "string" ? { status: record.status } : {}),
    ...(typeof record.detail === "string"
      ? { detail: sanitizeMessage(record.detail) }
      : {}),
    ...(typeof record.startedAt === "string" || record.startedAt === null
      ? { startedAt: record.startedAt }
      : {}),
    ...(typeof record.completedAt === "string" || record.completedAt === null
      ? { completedAt: record.completedAt }
      : {}),
  };
}

function stagePatches(
  mirror: Record<string, unknown>,
): readonly (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">)[] {
  if (!Array.isArray(mirror.stages)) return [];
  return mirror.stages.flatMap((stage) => {
    if (!stage || typeof stage !== "object") return [];
    const record = stage as Record<string, unknown>;
    if (typeof record.id !== "string") return [];
    return [{
      id: record.id,
      ...(typeof record.status === "string" ? { status: record.status } : {}),
      ...(typeof record.detail === "string"
        ? { detail: sanitizeMessage(record.detail) }
        : {}),
      ...(typeof record.startedAt === "string" || record.startedAt === null
        ? { startedAt: record.startedAt }
        : {}),
      ...(typeof record.completedAt === "string" || record.completedAt === null
        ? { completedAt: record.completedAt }
        : {}),
    }];
  });
}

function modulePatches(mirror: Record<string, unknown>): readonly SyncJobModuleRecord[] {
  const progress = mirror.asinProgress;
  if (!progress || typeof progress !== "object" || Array.isArray(progress)) {
    return [];
  }
  const modules: SyncJobModuleRecord[] = [];
  for (const [asin, values] of Object.entries(progress)) {
    if (!values || typeof values !== "object" || Array.isArray(values)) continue;
    for (const [module, value] of Object.entries(values)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      if (!moduleStatuses.has(String(record.status))) continue;
      modules.push({
        asin,
        module,
        status: record.status as SyncJobModuleRecord["status"],
        reason: record.reason == null ? null : sanitizeMessage(record.reason),
        updatedAt: typeof record.updatedAt === "string"
          ? record.updatedAt
          : new Date().toISOString(),
      });
    }
  }
  return modules;
}

async function mergeCurrentPublicationView(
  mirrorPath: string,
  leasedJob: SyncJobRecord,
  updatedJob: SyncJobRecord | null,
  outputs: readonly StageOutputDraft[],
): Promise<{
  jobVersion: number;
  persistedStageContentHashes?: Readonly<Record<string, string>>;
} | null> {
  if (
    !leasedJob.projectId || !leasedJob.runId ||
    !updatedJob ||
    updatedJob.jobId !== leasedJob.jobId ||
    updatedJob.organizationId !== leasedJob.organizationId ||
    updatedJob.projectId !== leasedJob.projectId ||
    updatedJob.runId !== leasedJob.runId ||
    !Number.isSafeInteger(updatedJob.jobVersion) || Number(updatedJob.jobVersion) < 1
  ) return null;
  const acknowledgedVersion = Number(updatedJob.jobVersion);
  const stageContentHashes = Object.freeze(Object.fromEntries(outputs
    .map((output) => [output.stage, output.contentHash])
    .sort(([left], [right]) => left.localeCompare(right))));
  let persistedView: {
    jobVersion: number;
    persistedStageContentHashes?: Readonly<Record<string, string>>;
  } | null = null;
  await mutateSyncJobMirror(mirrorPath, (current: Record<string, unknown> | null) => {
    if (!current) return null;
    const currentVersion = Number.isSafeInteger(current.jobVersion) && Number(current.jobVersion) > 0
      ? Number(current.jobVersion)
      : 0;
    if (acknowledgedVersion < currentVersion) return null;
    persistedView = {
      jobVersion: acknowledgedVersion,
      ...(outputs.length ? { persistedStageContentHashes: stageContentHashes } : {}),
    };
    return redactDiagnosticMirror({ ...current, ...persistedView });
  });
  return persistedView;
}

export function stageOutputPatches(
  mirror: Record<string, unknown>,
  job: SyncJobRecord,
  options: { verifyContentHash?: boolean } = {},
): readonly StageOutputDraft[] {
  if (!job.projectId || !job.runId || !Array.isArray(mirror.outputs)) return [];
  const projectId = job.projectId;
  const runId = job.runId;
  return mirror.outputs.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const draft = value as Record<string, unknown>;
    if (
      draft.organizationId !== job.organizationId ||
      draft.projectId !== job.projectId ||
      draft.runId !== job.runId ||
      !projectableStageIds.has(String(draft.stage)) ||
      !terminalStageStatuses.has(String(draft.stageStatus)) ||
      typeof draft.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(draft.contentHash) ||
      typeof draft.updatedAt !== "string"
    ) return [];
    const data = recordOrUndefined(draft.data);
    const rawGap = recordOrUndefined(draft.gap);
    const parsedGap = StageOutputGapSchema.safeParse(rawGap);
    const gap = parsedGap.success ? parsedGap.data : undefined;
    if (draft.stageStatus === "done" && (data === undefined || gap !== undefined)) return [];
    if (draft.stageStatus === "partial" && (data === undefined || gap === undefined)) return [];
    if (draft.stageStatus === "failed" && (data !== undefined || gap === undefined)) return [];
    if (data !== undefined && !validStageData(String(draft.stage), data)) return [];
    if (
      gap !== undefined &&
      (draft.stageStatus === "done" ||
       gap.state !== draft.stageStatus ||
       !gapReasonCodes.has(String(gap.reasonCode)))
    ) return [];
    const output = {
      organizationId: job.organizationId,
      projectId,
      runId,
      stage: draft.stage as StageOutputDraft["stage"],
      stageStatus: draft.stageStatus as StageOutputDraft["stageStatus"],
      contentHash: draft.contentHash,
      updatedAt: draft.updatedAt,
      ...(data ? { data } : {}),
      ...(gap ? { gap: gap as StageOutputDraft["gap"] } : {}),
    } as StageOutputDraft;
    if (options.verifyContentHash && !stageOutputHashMatches(output)) return [];
    return [output];
  });
}

function rejectUnbackedTerminalStage(
  patch: (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">) | undefined,
  outputStages: ReadonlySet<string>,
): (Partial<SyncJobStageRecord> & Pick<SyncJobStageRecord, "id">) | undefined {
  if (
    patch &&
    projectableStageIds.has(patch.id) &&
    terminalStageStatuses.has(String(patch.status)) &&
    !outputStages.has(patch.id)
  ) return undefined;
  return patch;
}

const projectableStageIds = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
  "child_sales", "price_strategy", "image_remarks",
]);
const terminalStageStatuses = new Set(["done", "partial", "failed"]);
const gapReasonCodes = new Set(["CONNECT_TIMEOUT", "UPSTREAM_EMPTY", "CONNECTOR_FAILED", "SIF_KEYWORD_SCHEMA_INVALID", "MCP_SCHEMA"]);

function recordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

const stageDataKeys: Readonly<Record<string, readonly string[]>> = {
  keywords: ["analysisByAsin", "enrichmentByKeyword"],
  reviews: ["analysisByAsin", "ratingByAsin"],
  sales_trend: ["trendByAsin"],
  fba: ["feeByAsin"],
  listing: ["contentByAsin"],
  category: ["trendByNode"],
  traffic: ["listingByAsin", "monthlyByAsin"],
  child_sales: ["rowsByAsin"],
  price_strategy: ["strategyByAsin"],
  image_remarks: ["remarksByAsin", "outcomesByAsin"],
};

function validStageData(stage: string, data: Record<string, unknown>): boolean {
  const expected = stageDataKeys[stage];
  if (!expected) return false;
  const actual = Object.keys(data).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === [...expected].sort()[index])
    && expected.every((key) => recordOrUndefined(data[key]) !== undefined);
}

function stageOutputHashMatches(output: StageOutputDraft): boolean {
  if (!Number.isFinite(Date.parse(output.updatedAt))) return false;
  const hashInput = {
    stage: output.stage,
    ...(output.data ? { data: output.data } : {}),
    ...(output.gap ? { gap: output.gap } : {}),
  };
  return output.contentHash === createHash("sha256")
    .update(JSON.stringify(canonicalize(hashInput)))
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, canonicalize(record[key])]));
}

function redactDiagnosticMirror(value: Record<string, unknown>): Record<string, unknown> {
  const blocked = new Set([
    "leasedBy",
    "leaseGeneration",
    "leaseExpiresAt",
    "workerId",
    "command",
    "logPath",
    "stdout",
    "stderr",
    "env",
  ]);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !blocked.has(key)),
  );
}

function sanitizeMessage(value: unknown): string {
  return String(value ?? "")
    .replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(/\b(?:authorization|cookie|token|secret|password|credential|api[-_ ]?key)\b\s*[:=]\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000) || "同步任务状态已更新";
}

async function ignoreLeaseLoss(operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    if (error instanceof SyncJobLeaseLostError) return;
    throw error;
  }
}
