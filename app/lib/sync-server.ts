import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export type AsinModuleStatus = {
  asin: string;
  inCatalog: boolean;
  keywords: "ready" | "missing";
  reviews: "ready" | "missing";
  sales: "ready" | "missing";
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
    estimateAutoSyncSeconds: (count: number) => number;
    estimateAlexaVocSeconds: (count: number) => number;
  }>;
}

async function importJobStore() {
  return import("../../scripts/lib/sync-job-store.mjs") as Promise<{
    createSyncJob: (input: { asins: string[]; marketplace?: string }) => SyncJob;
    readSyncJob: (jobId: string) => SyncJob | null;
  }>;
}

export async function fetchAsinDataStatus(asins: string[]) {
  const mod = await importStatusModule();
  return mod.getAsinDataStatus(asins);
}

export async function startAsinSyncJob(asins: string[], marketplace = "US") {
  const statusMod = await importStatusModule();
  const jobStore = await importJobStore();
  const needing = statusMod.asinsNeedingMcpSync(asins);
  const job = jobStore.createSyncJob({ asins, marketplace });

  const runner = path.join(root, "scripts", "run-asin-sync-job.mjs");
  const child = spawn(process.execPath, [runner, job.jobId], {
    cwd: root,
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  return {
    job,
    mcpAsinsPending: needing.map(item => item.asin),
    estimatedAutoSeconds: statusMod.estimateAutoSyncSeconds(needing.length),
    estimatedAlexaSeconds: statusMod.estimateAlexaVocSeconds(
      statusMod.getAsinDataStatus(asins).filter(item => item.voc === "missing").length
    ),
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
