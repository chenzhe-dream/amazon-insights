import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { generatedAppDataPath } from "../../scripts/lib/generated-app-data-path.mjs";
import { pathToFileURL } from "node:url";

import { loadLocalEnv } from "../../scripts/lib/local-env.mjs";
import { compareAndSwapSyncJobMirror } from "../../scripts/lib/sync-job-store.mjs";

import { loadAgentStorageConfig } from "../config";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import {
  PersistedReadinessEvidenceError,
  SyncPersistedReadinessReconciliationService,
  type GeneratedListingEvidenceSource,
  type PersistedReadinessRepository,
  type SyncJobMirrorStore,
} from "../services/sync-persisted-readiness-reconciliation-service";

interface CliDependencies {
  readonly service?: SyncPersistedReadinessReconciliationService;
  readonly write?: (value: string) => void;
}

export async function runPersistedReadinessReconciliationCli(
  args: readonly string[],
  dependencies: CliDependencies = {},
): Promise<void> {
  const parsed = parseArguments(args);
  if (parsed.apply && !parsed.token) throw new TypeError("--token is required with --apply");

  const owned = dependencies.service ? null : await openDefaultService();
  const service = dependencies.service ?? owned!.service;
  const write = dependencies.write ?? ((value: string) => process.stdout.write(`${value}\n`));
  try {
    const request = {
      jobId: required(parsed.values, "job-id"),
      organizationId: required(parsed.values, "organization-id"),
      projectId: required(parsed.values, "project-id"),
      runId: required(parsed.values, "run-id"),
      fingerprint: required(parsed.values, "fingerprint"),
      marketplace: required(parsed.values, "marketplace") as "US",
      asins: required(parsed.values, "asins").split(",").map((value) => value.trim()),
      modules: [required(parsed.values, "module")] as ["listing"],
    };
    if (request.marketplace !== "US" || request.modules[0] !== "listing") {
      throw new TypeError("Only --marketplace US --module listing is supported");
    }
    const result = parsed.apply
      ? await service.apply({ ...request, token: parsed.token! })
      : await service.preview(request);
    write(JSON.stringify(result, null, 2));
  } finally {
    await owned?.close();
  }
}

export function createFileSyncJobMirrorStore(directory: string): SyncJobMirrorStore {
  const fileFor = (jobId: string) => path.join(directory, `${jobId}.json`);
  return {
    async read(jobId) {
      try {
        const raw = await readFile(fileFor(jobId));
        return { job: JSON.parse(raw.toString("utf8")), digest: sha256(raw) };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async compareAndSwap(input) {
      const target = fileFor(input.jobId);
      return compareAndSwapSyncJobMirror(target, input) as Promise<"applied" | "already-applied" | "conflict">;
    },
  };
}

async function openDefaultService() {
  loadLocalEnv();
  const repository = await openRuntimeAgentRepository(loadAgentStorageConfig());
  const maintenanceRepository = repository.syncJobs as unknown as PersistedReadinessRepository;
  if (typeof maintenanceRepository.applyPersistedReadinessRepair !== "function"
    || typeof maintenanceRepository.finalizePersistedReadinessRepair !== "function") {
    await repository.close();
    throw new Error("Persisted readiness repair requires PostgreSQL storage");
  }
  const root = process.cwd();
  const evidenceSource = await createGeneratedListingEvidenceSource(root);
  return {
    service: new SyncPersistedReadinessReconciliationService({
      repository: maintenanceRepository,
      mirrorStore: createFileSyncJobMirrorStore(path.join(root, "data", "sync-jobs")),
      evidenceSource,
    }),
    close: () => repository.close(),
  };
}

export async function createGeneratedListingEvidenceSource(
  root: string,
  dependencies: {
    readonly readReadiness?: (
      stage: "listing",
      asins: readonly string[],
    ) => Promise<{ readonly missingAsins: readonly string[]; readonly items: readonly unknown[] }>
      | { readonly missingAsins: readonly string[]; readonly items: readonly unknown[] };
  } = {},
): Promise<GeneratedListingEvidenceSource> {
  const statusModule = await import("../../scripts/lib/asin-data-status.mjs");
  const generatedPath = generatedAppDataPath(root, "sorftime-listing-content-data.ts");
  const readReadiness = dependencies.readReadiness ?? statusModule.readAsinStageReadiness;
  return {
    async read(asins) {
      const before = await readFile(generatedPath);
      const readiness = await readReadiness("listing", asins);
      const after = await readFile(generatedPath);
      const beforeDigest = sha256(before);
      if (sha256(after) !== beforeDigest) {
        throw new PersistedReadinessEvidenceError("Generated Listing evidence changed during readiness evaluation");
      }
      const missing = new Set(readiness.missingAsins as string[]);
      return { digest: beforeDigest, readyAsins: asins.filter((asin) => !missing.has(asin)) };
    },
  };
}

function parseArguments(args: readonly string[]) {
  const values = new Map<string, string>();
  let apply = false;
  let token: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (!flag?.startsWith("--")) throw new TypeError(`Unexpected argument: ${flag}`);
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new TypeError(`${flag} requires a value`);
    index += 1;
    if (flag === "--token") token = value;
    else values.set(flag.slice(2), value);
  }
  return { values, apply, token };
}

function required(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (!value) throw new TypeError(`--${name} is required`);
  return value;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runPersistedReadinessReconciliationCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
