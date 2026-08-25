import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import { readWebReloadPublication } from "../../scripts/lib/web-reload-request.mjs";

const MAX_MIRROR_BYTES = 2 * 1024 * 1024;
const JOB_ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

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
    code: "WEB_PUBLICATION_FAILED";
  };

type PublicationReference = {
  jobId: string;
  requestId: string;
  artifactId: string;
  requestedAt: string;
};

function failedPublication(reference: PublicationReference): SyncPublication {
  return {
    status: "failed",
    requestId: reference.requestId,
    artifactId: reference.artifactId,
    requestedAt: reference.requestedAt,
    failedAt: new Date().toISOString(),
    code: "WEB_PUBLICATION_FAILED",
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
  if (Object.keys(candidate).sort().join(",") !== "artifactId,generation,requestId,requestedAt") return null;
  if (!Number.isSafeInteger(candidate.generation) || candidate.generation < 1) return null;
  if (typeof candidate.requestId !== "string" || !SHA256_PATTERN.test(candidate.requestId)) return null;
  if (typeof candidate.artifactId !== "string" || !SHA256_PATTERN.test(candidate.artifactId)) return null;
  if (typeof candidate.requestedAt !== "string" || Number.isNaN(Date.parse(candidate.requestedAt))) return null;
  return {
    jobId,
    requestId: candidate.requestId,
    artifactId: candidate.artifactId,
    requestedAt: candidate.requestedAt,
  };
}

export class SyncPublicationStatusService {
  private readonly mirrorDirectory: string;
  private readonly spoolDirectory: string;

  constructor(options: SyncPublicationStatusServiceOptions = {}) {
    this.mirrorDirectory = options.mirrorDirectory ?? path.join(process.cwd(), "data", "sync-jobs");
    this.spoolDirectory = options.spoolDirectory ?? path.join(process.cwd(), "data", "web-reload-requests");
  }

  async read(jobId: string): Promise<SyncPublication> {
    if (!JOB_ID_PATTERN.test(jobId)) return { status: "not-required" };
    const mirror = await readBoundedJson(path.join(this.mirrorDirectory, `${jobId}.json`));
    const reference = parseExactPublicationReference(mirror?.publication, jobId);
    if (!reference) return { status: "not-required" };
    try {
      return await readWebReloadPublication(reference, { spoolDir: this.spoolDirectory }) as SyncPublication;
    } catch {
      return failedPublication(reference);
    }
  }
}
