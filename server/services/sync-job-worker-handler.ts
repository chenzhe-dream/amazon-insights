import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  SyncJobLeaseLostError,
  type SyncJobLease,
  type SyncJobModuleRecord,
  type SyncJobRecord,
  type SyncJobRepository,
  type SyncJobStageRecord,
} from "../db/sync-job-repository";

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
  readonly mirrorDirectory?: string;
  readonly runner?: SyncJobRunner;
  readonly heartbeatIntervalMs?: number;
  readonly heartbeatLeaseMs?: number;
  readonly progressPollMs?: number;
  readonly maxAttempts?: number;
  readonly now?: () => string;
  readonly rootDirectory?: string;
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

export class SyncJobWorkerHandler {
  readonly #syncJobs: SyncJobRepository;
  readonly #mirrorDirectory: string;
  readonly #runner: SyncJobRunner;
  readonly #heartbeatIntervalMs: number;
  readonly #heartbeatLeaseMs: number;
  readonly #progressPollMs: number;
  readonly #maxAttempts: number;
  readonly #now: () => string;

  constructor(options: SyncJobWorkerHandlerOptions) {
    const root = options.rootDirectory ?? process.cwd();
    this.#syncJobs = options.syncJobs;
    this.#mirrorDirectory =
      options.mirrorDirectory ?? path.join(root, "data", "sync-jobs");
    this.#runner = options.runner ?? createDetachedRunner(root);
    this.#heartbeatIntervalMs =
      options.heartbeatIntervalMs ?? defaultHeartbeatIntervalMs;
    this.#heartbeatLeaseMs = options.heartbeatLeaseMs ?? defaultLeaseMs;
    this.#progressPollMs = options.progressPollMs ?? defaultProgressPollMs;
    this.#maxAttempts = options.maxAttempts ?? defaultMaxAttempts;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async handle(lease: SyncJobLease, abortSignal?: AbortSignal): Promise<void> {
    const workerId = lease.job.leasedBy;
    if (!workerId) return;
    if (lease.leaseGeneration > this.#maxAttempts) {
      await ignoreLeaseLoss(() =>
        this.#syncJobs.fail({
          jobId: lease.job.jobId,
          leaseGeneration: lease.leaseGeneration,
          workerId,
          failedAt: this.#now(),
          message: "同步任务重试次数已耗尽",
          error: { code: "SYNC_JOB_ATTEMPTS_EXHAUSTED" },
        }),
      );
      return;
    }

    const mirrorPath = await this.#writeInitialMirror(lease.job);
    let stopped = false;
    const heartbeat = setInterval(() => {
      void ignoreLeaseLoss(() =>
        this.#syncJobs.heartbeat({
          jobId: lease.job.jobId,
          leaseGeneration: lease.leaseGeneration,
          workerId,
          heartbeatAt: this.#now(),
          leaseMs: this.#heartbeatLeaseMs,
        }),
      );
    }, this.#heartbeatIntervalMs);
    heartbeat.unref?.();
    const progressPoll = setInterval(() => {
      void ignoreLeaseLoss(() => this.#mirrorProgress(lease, workerId));
    }, this.#progressPollMs);
    progressPoll.unref?.();

    try {
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
      );
      stopped = true;
      clearInterval(progressPoll);
      clearInterval(heartbeat);
      if (result === abortedRunner) return;
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
    await this.#syncJobs.recordProgress({
      jobId: lease.job.jobId,
      leaseGeneration: lease.leaseGeneration,
      workerId,
      recordedAt: this.#now(),
      currentStageId: typeof mirror.currentStageId === "string"
        ? mirror.currentStageId
        : undefined,
      stage: stagePatch(mirror),
      modules: modulePatches(mirror),
      message: typeof mirror.message === "string"
        ? sanitizeMessage(mirror.message)
        : undefined,
    });
    return mirror;
  }
}

function createDetachedRunner(root: string): SyncJobRunner {
  return async (lease, context) => {
    const runnerPath = path.join(root, "scripts", "run-asin-sync-job.mjs");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [runnerPath, lease.job.jobId], {
        cwd: root,
        detached: false,
        stdio: "ignore",
        ...(context.abortSignal ? { signal: context.abortSignal } : {}),
        env: {
          ...process.env,
          ALEXA_AUTO: process.env.ALEXA_AUTO ?? "1",
        },
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) {
          resolve();
          return;
        }
        reject(new Error(`sync runner exited ${signal ?? code}`));
      });
    });
  };
}

const abortedRunner = Symbol("aborted-sync-runner");

async function runUntilAbort(
  runner: Promise<RunnerResult | void>,
  abortSignal: AbortSignal | undefined,
): Promise<RunnerResult | void | typeof abortedRunner> {
  if (!abortSignal) return await runner;
  if (abortSignal.aborted) return abortedRunner;
  return await Promise.race([
    runner,
    new Promise<typeof abortedRunner>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(abortedRunner), {
        once: true,
      });
    }),
  ]);
}

function toDiagnosticMirror(job: SyncJobRecord): Record<string, unknown> {
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
  };
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
