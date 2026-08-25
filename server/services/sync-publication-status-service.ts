import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { readWebReloadPublication } from "../../scripts/lib/web-reload-request.mjs";

const MAX_MIRROR_BYTES = 2 * 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const PROJECTABLE_SYNC_STAGES = new Set([
  "keywords", "reviews", "sales_trend", "fba", "listing", "category", "traffic",
]);

export type SyncPublication =
  | { status: "not-required" }
  | {
    status: "pending";
    requestId: string;
    artifactId: string;
    requestedAt: string;
  }
  | {
    status: "applied";
    requestId: string;
    artifactId: string;
    requestedAt: string;
    appliedAt: string;
  }
  | {
    status: "failed";
    requestId: string;
    artifactId: string;
    requestedAt: string;
    failedAt: string;
    code: "WEB_PUBLICATION_FAILED" | "WEB_PUBLICATION_CONTENT_MISMATCH";
  };

type PublicationReference = {
  jobId: string;
  requestId: string;
  artifactId: string;
  jobVersion: number;
  stageContentHashes: Readonly<Record<string, string>>;
  requestedAt: string;
};

export type PersistedPublicationView = {
  jobVersion: number;
  stageContentHashes: Readonly<Record<string, string>>;
};

function failedPublication(
  reference: PublicationReference,
  code: "WEB_PUBLICATION_FAILED" | "WEB_PUBLICATION_CONTENT_MISMATCH" = "WEB_PUBLICATION_FAILED",
): SyncPublication {
  return {
    status: "failed",
    requestId: reference.requestId,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
    failedAt: new Date().toISOString(),
    code,
  };
}

type SyncPublicationStatusServiceOptions = {
  mirrorDirectory?: string;
  spoolDirectory?: string;
};

async function readBoundedJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 2 || info.size > MAX_MIRROR_BYTES) return null;
    const value: unknown = JSON.parse(await readFile(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseExactPublicationReference(value: unknown, jobId: string): PublicationReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).sort().join(",") !== "artifactId,generation,jobVersion,requestId,requestedAt,stageContentHashes") return null;
  if (!Number.isSafeInteger(candidate.generation) || Number(candidate.generation) < 1) return null;
  if (typeof candidate.requestId !== "string" || !SHA256_PATTERN.test(candidate.requestId)) return null;
  if (typeof candidate.artifactId !== "string" || !SHA256_PATTERN.test(candidate.artifactId)) return null;
  if (!Number.isSafeInteger(candidate.jobVersion) || Number(candidate.jobVersion) < 1) return null;
  const stageContentHashes = parseStageContentHashes(candidate.stageContentHashes);
  if (!stageContentHashes) return null;
  if (typeof candidate.requestedAt !== "string" || Number.isNaN(Date.parse(candidate.requestedAt))) return null;
  return {
    jobId,
    requestId: candidate.requestId,
    artifactId: candidate.artifactId,
    jobVersion: Number(candidate.jobVersion),
    stageContentHashes,
    requestedAt: candidate.requestedAt,
  };
}

function parseStageContentHashes(value: unknown): Readonly<Record<string, string>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>);
  if (!entries.length || entries.some(([stage, hash]) =>
    !PROJECTABLE_SYNC_STAGES.has(stage) || typeof hash !== "string" || !SHA256_PATTERN.test(hash)
  )) return null;
  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))) as Record<string, string>);
}

function viewsMatch(reference: PublicationReference, current: PersistedPublicationView | null): boolean {
  if (
    !current ||
    !Number.isSafeInteger(current.jobVersion) ||
    current.jobVersion < 1 ||
    reference.jobVersion !== current.jobVersion
  ) return false;
  const currentHashes = parseStageContentHashes(current.stageContentHashes);
  if (!currentHashes) return false;
  const expected = Object.entries(reference.stageContentHashes);
  const actual = Object.entries(currentHashes);
  return expected.length === actual.length && expected.every(([stage, hash]) => currentHashes[stage] === hash);
}

export class SyncPublicationStatusService {
  private readonly mirrorDirectory: string;
  private readonly spoolDirectory: string;

  constructor(options: SyncPublicationStatusServiceOptions = {}) {
    this.mirrorDirectory = options.mirrorDirectory ?? path.join(process.cwd(), "data", "sync-jobs");
    this.spoolDirectory = options.spoolDirectory ?? path.join(process.cwd(), "data", "web-reload-requests");
  }

  async read(jobId: string, currentView?: PersistedPublicationView): Promise<SyncPublication> {
    if (!JOB_ID_PATTERN.test(jobId)) return { status: "not-required" };
    const mirror = await readBoundedJson(path.join(this.mirrorDirectory, `${jobId}.json`));
    const reference = parseExactPublicationReference(mirror?.publication, jobId);
    if (!reference) return { status: "not-required" };
    if (!viewsMatch(reference, currentView ?? null)) {
      return failedPublication(reference, "WEB_PUBLICATION_CONTENT_MISMATCH");
    }
    try {
      return await readWebReloadPublication(reference, { spoolDir: this.spoolDirectory }) as SyncPublication;
    } catch {
      return failedPublication(reference);
    }
  }
}
