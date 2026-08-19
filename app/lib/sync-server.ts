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
  asinProgress: Record<string, Record<string, string>>;
  alexaVoc?: {
    pendingAsins: string[];
    estimatedSeconds: number;
    deadlineAt: string;
  };
  needsReload?: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
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
    readSyncJob: (jobId: string) => SyncJob | null;
    patchSyncJob: (jobId: string, patch: Partial<SyncJob> & Record<string, unknown>) => SyncJob | null;
  }>;
}

export async function fetchAsinDataStatus(asins: string[]) {
  const mod = await importStatusModule();
  return mod.getAsinDataStatus(asins);
}

export async function startAsinSyncJob(asins: string[], marketplace = "US") {
  const statusMod = await importStatusModule();
  const jobStore = await importJobStore();
  const catalogPending = statusMod.asinsNeedingCatalogSync(asins);
  const needing = statusMod.asinsNeedingMcpSync(asins);
  const trafficPending = statusMod.asinsNeedingTrafficSync(asins);
  const listingPending = statusMod.asinsNeedingListingSync(asins);
  const imageRemarksPending = statusMod.asinsNeedingImageRemarksSync(asins);
  const vocPending = statusMod.getAsinDataStatus(asins).filter(item => item.voc === "missing");
  const job = jobStore.createSyncJob({
    asins,
    marketplace,
    mcpAsinCount: needing.length,
    vocPendingCount: vocPending.length,
    catalogAsinCount: catalogPending.length,
  });

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
  const child = spawn(process.execPath, [runner, job.jobId], {
    cwd: root,
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ALEXA_AUTO: process.env.ALEXA_AUTO ?? "1",
    },
  });
  child.on("error", error => {
    jobStore.patchSyncJob(job.jobId, {
      status: "failed",
      message: `后台任务启动失败：${error.message}`,
    });
  });
  child.unref();

  return {
    job,
    mcpAsinsPending: needing.map(item => item.asin),
    estimatedAutoSeconds: statusMod.estimateAutoSyncSeconds(needing.length, {
      catalogCount: catalogPending.length,
      trafficCount: trafficPending.length,
      listingCount: listingPending.length,
      imageRemarksCount: imageRemarksPending.length,
    }),
    estimatedAlexaSeconds: statusMod.estimateAlexaVocSeconds(vocPending.length),
  };
}

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
  if (new Set(asins).size !== asins.length) return null;
  return asins;
}
