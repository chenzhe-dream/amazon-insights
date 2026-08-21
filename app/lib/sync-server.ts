import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

export type AsinModuleStatus = {
  asin: string;
  inCatalog: boolean;
  keywords: "ready" | "missing";
  reviews: "ready" | "missing";
  sales: "ready" | "missing";
  childSales: "ready" | "missing";
  priceStrategy: "ready" | "missing";
  fba: "ready" | "missing";
  listing: "ready" | "missing";
  imageRemarks: "ready" | "missing";
  category: "ready" | "missing";
  traffic: "ready" | "missing";
  voc: "ready" | "missing";
};

export type SyncStage = {
  id: string;
  label: string;
  kind: "auto" | "manual";
  status: string;
  estimatedSeconds: number;
  detail?: string;
  manualNote?: string;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type SyncJob = {
  jobId: string;
  asins: string[];
  marketplace: string;
  status: string;
  message: string;
  currentStageId: string;
  stages: SyncStage[];
  asinProgress: Record<string, Record<string, {
    status: "ready" | "upstream-empty" | "timeout" | "connector-failed" | "pending" | "manual";
    reason: string | null;
    updatedAt: string;
  }>>;
  alexaVoc?: {
    pendingAsins: string[];
    estimatedSeconds: number;
    deadlineAt: string;
  };
  needsReload?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  scope?: {
    organizationId: string;
    projectId: string;
    runId: string | null;
    marketplace: string;
    asins: string[];
  };
  fingerprint?: string;
  dynamicSnapshot?: "pending" | "ready";
};

export type SyncJobScope = {
  organizationId: string;
  projectId?: string | null;
  runId?: string | null;
  actorId?: string | null;
};

export type StartAsinSyncInput = SyncJobScope & {
  asins: string[];
  marketplace?: string;
};

export type DynamicTrafficSnapshotAdapter = {
  createForAuthorizedRun(input: {
    actorId: string;
    organizationId: string;
    projectId: string;
    runId: string;
    marketplace: "US";
    asins: readonly string[];
  }): Promise<unknown>;
};

async function importStatusModule() {
  return import("../../scripts/lib/asin-data-status.mjs") as Promise<{
    getAsinDataStatus: (asins: string[]) => AsinModuleStatus[];
    asinsNeedingMcpSync: (asins: string[]) => AsinModuleStatus[];
    asinsNeedingListingSync: (asins: string[]) => AsinModuleStatus[];
    asinsNeedingImageRemarksSync: (asins: string[]) => AsinModuleStatus[];
    asinsNeedingTrafficSync: (asins: string[]) => AsinModuleStatus[];
    asinsNeedingCatalogSync: (asins: string[]) => string[];
    estimateAutoSyncSeconds: (count: number, opts?: { catalogCount?: number; trafficCount?: number; listingCount?: number; imageRemarksCount?: number }) => number;
    estimateAlexaVocSeconds: (count: number) => number;
  }>;
}

async function importJobStore() {
  return import("../../scripts/lib/sync-job-store.mjs") as Promise<{
    createSyncJob: (input: { asins: string[]; marketplace?: string }) => SyncJob;
    createOrReuseSyncJob: (input: Record<string, unknown>) => { job: SyncJob; reused: boolean };
    createSyncJobStartCoordinator: (input: {
      store: { createOrReuseSyncJob: (input: Record<string, unknown>) => { job: SyncJob; reused: boolean };
      };
      launch: (job: SyncJob) => Promise<void>;
    }) => { start: (input: Record<string, unknown>) => Promise<{ job: SyncJob; reused: boolean }> };
    readSyncJob: (jobId: string) => SyncJob | null;
    patchSyncJob: (jobId: string, patch: Partial<SyncJob> & Record<string, unknown>) => SyncJob | null;
    failSyncJob: (jobId: string, message: string) => SyncJob | null;
  }>;
}

export async function fetchAsinDataStatus(asins: string[]) {
  const mod = await importStatusModule();
  return mod.getAsinDataStatus(asins);
}

async function launchSyncRunner(job: SyncJob, jobStore: Awaited<ReturnType<typeof importJobStore>>) {
  const runner = path.join(root, "scripts", "run-asin-sync-job.mjs");
  if (!fs.existsSync(runner)) {
    jobStore.patchSyncJob(job.jobId, {
      status: "failed",
      message: `找不到同步脚本：${runner}`,
    });
    throw new Error(`sync runner missing: ${runner}`);
  }

  fs.mkdirSync(path.join(root, "data", "sync-jobs"), { recursive: true });
  const logFile = path.join(root, "data", "sync-jobs", `${job.jobId}.log`);
  const logFd = fs.openSync(logFile, "a");
  let child;
  try {
    child = spawn(process.execPath, [runner, job.jobId], {
      cwd: root,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: {
        ...process.env,
        ALEXA_AUTO: process.env.ALEXA_AUTO ?? "1",
      },
    });
  } finally {
    fs.closeSync(logFd);
  }
  child.on("error", error => {
    const message = `后台任务启动失败：${error.message}`;
    fs.appendFileSync(logFile, `[error] ${message}\n`, "utf8");
    jobStore.failSyncJob(job.jobId, message);
  });
  child.unref();
}

export type StartAsinSyncJobOptions = {
  dynamicTrafficSnapshotAdapter?: DynamicTrafficSnapshotAdapter;
};

type AsinSyncJobStarterDependencies = {
  loadStatusModule: typeof importStatusModule;
  loadJobStore: typeof importJobStore;
  launchSyncRunner: typeof launchSyncRunner;
};

export function createAsinSyncJobStarter(
  dependencies: AsinSyncJobStarterDependencies = {
    loadStatusModule: importStatusModule,
    loadJobStore: importJobStore,
    launchSyncRunner: launchSyncRunner,
  },
) {
  return async function startAsinSyncJob(
    input: StartAsinSyncInput,
    options: StartAsinSyncJobOptions = {},
  ): Promise<{
  job: SyncJob;
  reused: boolean;
  mcpAsinsPending: string[];
  estimatedAutoSeconds: number;
  estimatedAlexaSeconds: number;
  }> {
  const { asins, marketplace = "US", organizationId, projectId = null, runId = null } = input;
  const statusMod = await dependencies.loadStatusModule();
  const jobStore = await dependencies.loadJobStore();
  const catalogPending = statusMod.asinsNeedingCatalogSync(asins);
  const needing = statusMod.asinsNeedingMcpSync(asins);
  const trafficPending = statusMod.asinsNeedingTrafficSync(asins);
  const listingPending = statusMod.asinsNeedingListingSync(asins);
  const imageRemarksPending = statusMod.asinsNeedingImageRemarksSync(asins);
  const vocPending = statusMod.getAsinDataStatus(asins).filter(item => item.voc === "missing");
  const coordinator = jobStore.createSyncJobStartCoordinator({
    store: jobStore,
    launch: (job) => dependencies.launchSyncRunner(job, jobStore),
  });
  const { job, reused } = await coordinator.start({
    asins,
    marketplace,
    organizationId,
    projectId,
    runId,
    mcpAsinCount: needing.length,
    vocPendingCount: vocPending.length,
    catalogAsinCount: catalogPending.length,
  });
  if (!reused && projectId && runId && input.actorId && options.dynamicTrafficSnapshotAdapter) {
    void createDynamicTrafficSnapshot({
      adapter: options.dynamicTrafficSnapshotAdapter,
      jobStore,
      jobId: job.jobId,
      organizationId,
      actorId: input.actorId,
      projectId,
      runId,
      marketplace,
      asins: job.asins,
    });
  }

  return {
    job,
    reused,
    mcpAsinsPending: needing.map(item => item.asin),
    estimatedAutoSeconds: statusMod.estimateAutoSyncSeconds(needing.length, {
      catalogCount: catalogPending.length,
      trafficCount: trafficPending.length,
      listingCount: listingPending.length,
      imageRemarksCount: imageRemarksPending.length,
    }),
    estimatedAlexaSeconds: statusMod.estimateAlexaVocSeconds(vocPending.length),
  };
  };
}

export const startAsinSyncJob = createAsinSyncJobStarter();

export async function readJob(jobId: string) {
  const jobStore = await importJobStore();
  return jobStore.readSyncJob(jobId);
}

export function isValidAsin(value: string) {
  return /^[A-Z0-9]{10}$/.test(value);
}

export function normalizeAsins(values: unknown): string[] | null {
  if (!Array.isArray(values)) return null;
  const asins = values.map(item => String(item).trim().toUpperCase()).filter(Boolean);
  if (asins.length < 1 || asins.length > 10) return null;
  if (asins.some(asin => !isValidAsin(asin))) return null;
  return [...new Set(asins)].sort();
}

async function createDynamicTrafficSnapshot(input: {
  adapter: DynamicTrafficSnapshotAdapter;
  jobStore: Awaited<ReturnType<typeof importJobStore>>;
  jobId: string;
  organizationId: string;
  actorId: string;
  projectId: string;
  runId: string;
  marketplace: string;
  asins: readonly string[];
}) {
  if (input.marketplace !== "US") return;
  try {
    await input.adapter.createForAuthorizedRun({
      actorId: input.actorId,
      organizationId: input.organizationId,
      projectId: input.projectId,
      runId: input.runId,
      marketplace: "US",
      asins: input.asins,
    });
    input.jobStore.patchSyncJob(input.jobId, { dynamicSnapshot: "ready" });
  } catch {
    input.jobStore.patchSyncJob(input.jobId, { dynamicSnapshot: "pending" });
  }
}
