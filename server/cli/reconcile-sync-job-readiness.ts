import { createHash, randomUUID } from "node:crypto";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadLocalEnv } from "../../scripts/lib/local-env.mjs";

import { loadAgentStorageConfig } from "../config";
import { openRuntimeAgentRepository } from "../db/open-runtime-repository";
import {
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
      let raw: Buffer;
      try {
        raw = await readFile(target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "conflict";
        throw error;
      }
      const currentDigest = sha256(raw);
      if (currentDigest === input.nextDigest) return "already-applied";
      if (currentDigest !== input.expectedDigest) return "conflict";
      const next = Buffer.from(JSON.stringify(input.nextJob));
      if (sha256(next) !== input.nextDigest) throw new Error("Mirror replacement digest mismatch");
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, next, { flag: "wx", mode: 0o600 });
        const latest = await readFile(target);
        if (sha256(latest) !== input.expectedDigest) return "conflict";
        await rename(temporary, target);
        return "applied";
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
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

async function createGeneratedListingEvidenceSource(root: string): Promise<GeneratedListingEvidenceSource> {
  const statusModule = await import("../../scripts/lib/asin-data-status.mjs");
  const generatedPath = path.join(root, "app", "sorftime-listing-content-data.ts");
  return {
    async read(asins) {
      const raw = await readFile(generatedPath);
      const readiness = statusModule.readAsinStageReadiness("listing", asins);
      const missing = new Set(readiness.missingAsins as string[]);
      return { digest: sha256(raw), readyAsins: asins.filter((asin) => !missing.has(asin)) };
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
