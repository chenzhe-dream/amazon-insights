import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createBoundedTail,
  parseProviderDiagnosticOutput,
} from "../../scripts/lib/provider-diagnostics.mjs";
import { detachedProviderEnvironment } from "../../scripts/lib/provider-network.mjs";
import type {
  ConnectorStatusRecord,
  ConnectorStatusRepository,
} from "../db/repository";

import {
  SyncJobLeaseLostError,
  type SyncJobLease,
  type SyncJobModuleRecord,
  type SyncJobRecord,
  type SyncJobRepository,
  type SyncJobStageRecord,
} from "../db/sync-job-repository";
import { WorkerTaskError } from "../runtime/retry-policy";
import {
  copySifTrafficShapeDiagnostic,
  SifTrafficSnapshotTaskError,
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
  readonly connectorStatuses?: ConnectorStatusRepository;
  readonly mirrorDirectory?: string;
  readonly runner?: SyncJobRunner;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatLeaseMs?: number;
  readonly progressPollMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => string;
  readonly rootDirectory?: string;
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
  readonly #connectorStatuses?: ConnectorStatusRepository;
  readonly #mirrorDirectory: string;
  readonly #runner: SyncJobRunner;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatLeaseMs: number;
  readonly #progressPollMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => string;
  readonly #publishedDegradations = new Set<string>();
  readonly #dynamicTrafficSnapshotAdapter?: SyncJobWorkerHandlerOptions["dynamicTrafficSnapshotAdapter"];

  constructor(options: SyncJobWorkerHandlerOptions) {
    const root = options.rootDirectory ?? process.cwd();
    this.#syncJobs = options.syncJobs;
    this.#connectorStatuses = options.connectorStatuses;
    this.#mirrorDirectory =
      options.mirrorDirectory ?? path.join(root, "data", "sync-jobs");
    this.#runner = options.runner ?? createDetachedRunner(root);
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
    const progressPoll = setInterval(() => {
      void this.#mirrorProgress(lease, workerId)
        .catch(reportBackgroundFailure);
    }, this.#progressPollMs);
    progressPoll.unref?.();

    try {
      if (await this.#runCanonicalTrafficSnapshot(lease, abortSignal)) return;
      if (abortSignal?.aborted) return;
      const context: SyncJobRunnerContext = {
        workerId,
        leaseGeneration: lease.leaseGeneration,
        mirrorPath,
        ...(abortSignal ? { abortSignal } : {}),
        writeMirror: async (patch) => {
          await mergeMirror(mirrorPath, patch);
        },
      };
      const result = await runUntilAbort(
        this.#runner(lease, context),
        abortSignal,
        backgroundFailure,
      );
      stopped = true;
      clearInterval(progressPoll);
      clearInterval(heartbeat);
      if (result === abortedRunner || result === lostLeaseRunner) return;
      const mirrored = await this.#mirrorProgress(lease, workerId);
      const status = String(
        result?.status ?? mirrored?.status ?? "completed",
      );
      const message = sanitizeMessage(
        result?.message ?? mirrored?.message ?? "同步任务已完成",
      );
      if (terminalSuccessStatuses.has(status)) {
        await ignoreLeaseLoss(() =>
          this.#syncJobs.complete({
            jobId: lease.job.jobId,
            leaseGeneration: lease.leaseGeneration,
            workerId,
            completedAt: this.#now(),
            message,
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
      error = snapshotError instanceof SifTrafficSnapshotTaskError
        ? {
            code: "SYNC_TRAFFIC_SNAPSHOT_FAILED",
            category,
            asin: snapshotError.asin,
            operation: snapshotError.operation,
            reasonCode: snapshotError.reasonCode,
            ...(snapshotError.shapeDiagnostic
              ? {
                  shapeDiagnostic: copySifTrafficShapeDiagnostic(
                    snapshotError.shapeDiagnostic,
                  ),
                }
              : {}),
          }
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
    await writeFile(mirrorPath, JSON.stringify(toDiagnosticMirror(job), null, 2), "utf8");
    return mirrorPath;
  }

  async #mirrorProgress(
    lease: SyncJobLease,
    workerId: string,
  ): Promise<Record<string, unknown> | null> {
    const mirror = await readMirror(
      path.join(this.#mirrorDirectory, `${lease.job.jobId}.json`),
    );
    if (!mirror) return null;
    await this.#publishProviderDegradation(lease, mirror);
    await this.#syncJobs.recordProgress({
      jobId: lease.job.jobId,
      leaseGeneration: lease.leaseGeneration,
      workerId,
      recordedAt: this.#now(),
      currentStageId: typeof mirror.currentStageId === "string"
        ? mirror.currentStageId
        : undefined,
      stage: stagePatch(mirror),
      stages: stagePatches(mirror),
      modules: modulePatches(mirror),
      message: typeof mirror.message === "string"
        ? sanitizeMessage(mirror.message)
        : undefined,
    });
    return mirror;
  }

  async #publishProviderDegradation(
    lease: SyncJobLease,
    mirror: Record<string, unknown>,
  ): Promise<void> {
    if (!this.#connectorStatuses) return;
    for (const degradation of providerDegradations(mirror)) {
      const key = [lease.job.jobId, degradation.connector, degradation.failureKind, degradation.causeCode].join(":");
      if (this.#publishedDegradations.has(key)) continue;
      const checkedAt = this.#now();
      await this.#connectorStatuses.upsertConnectorStatus({
        id: randomUUID(),
        organizationId: lease.job.organizationId,
        connector: degradation.connector,
        configured: true,
        health: "unavailable",
        lastCheckedAt: checkedAt,
        lastError: {
          code: "probe-failed",
          message: `Provider degraded: ${degradation.failureKind} (${degradation.causeCode})`,
        },
        updatedAt: checkedAt,
      });
      this.#publishedDegradations.add(key);
    }
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
          ALEXA_AUTO: process.env.ALEXA_AUTO ?? "1",
          AGENT_CHILD_RESOURCE_GOVERNOR_REQUIRED: "1",
          AGENT_EXECUTION_ORGANIZATION_ID: lease.job.organizationId,
          AGENT_SYNC_JOB_ID: lease.job.jobId,
          AGENT_RESOURCE_GOVERNOR_OWNER_ID: context.workerId,
        }),
      });
      child.stdout?.on("data", (chunk) => stdout.append(chunk));
      child.stderr?.on("data", (chunk) => stderr.append(chunk));
      child.once("error", reject);
      child.once("exit", async (code, signal) => {
        const diagnostics = parseProviderDiagnosticOutput(`${stdout.text()}\n${stderr.text()}`);
        try {
          await context.writeMirror({ diagnostics });
        } catch (error) {
          reject(error);
          return;
        }
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`sync runner exited ${signal ?? code}`));
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
  return await Promise.race([
    ...promises,
    new Promise<typeof abortedRunner>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(abortedRunner), {
        once: true,
      });
    }),
  ]);
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
  const current = await readMirror(mirrorPath) ?? {};
  await writeFile(
    mirrorPath,
    JSON.stringify(redactDiagnosticMirror({ ...current, ...patch }), null, 2),
    "utf8",
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

const providerConnectors = new Set<ConnectorStatusRecord["connector"]>([
  "sif",
  "sorftime",
  "sellerSprite",
]);
const providerFailureKinds = new Set([
  "dns",
  "tls",
  "proxy",
  "connection",
  "timeout",
  "http",
  "rpc",
  "schema",
  "governor",
]);
const providerCauseCodes = new Set([
  "DNS_NOT_FOUND",
  "DNS_AGAIN",
  "TLS_CERTIFICATE",
  "PROXY_CONNECT",
  "CONNECTION_REFUSED",
  "CONNECTION_RESET",
  "CONNECT_TIMEOUT",
  "REQUEST_TIMEOUT",
  "HTTP_4XX",
  "HTTP_5XX",
  "MCP_RPC",
  "MCP_SCHEMA",
  "RESOURCE_GOVERNOR",
  "UNKNOWN_TRANSPORT",
]);

function providerDegradations(mirror: Record<string, unknown>): readonly {
  connector: ConnectorStatusRecord["connector"];
  failureKind: string;
  causeCode: string;
}[] {
  if (!Array.isArray(mirror.providerDegraded)) return [];
  return mirror.providerDegraded.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const record = value as Record<string, unknown>;
    const connector = record.connector;
    const failureKind = record.failureKind;
    const causeCode = record.causeCode;
    if (
      typeof connector !== "string" ||
      !providerConnectors.has(connector as ConnectorStatusRecord["connector"]) ||
      typeof failureKind !== "string" ||
      !providerFailureKinds.has(failureKind) ||
      typeof causeCode !== "string" ||
      !providerCauseCodes.has(causeCode)
    ) {
      return [];
    }
    return [{
      connector: connector as ConnectorStatusRecord["connector"],
      failureKind,
      causeCode,
    }];
  });
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
