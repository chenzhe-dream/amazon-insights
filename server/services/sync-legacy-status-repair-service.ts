import { Buffer } from "node:buffer";

import type { ConnectorId } from "../connectors/connector-contract";
import type { SyncJobRecord } from "../db/sync-job-repository";

export const SYNC_PROVIDER_DIAGNOSTICS_VERSION = "1";

export type SyncLegacyRepairCandidate = Readonly<{
  asin: string;
  module: string;
  connectorId: ConnectorId;
  nextStatus: "pending";
  reason: "LEGACY_UNVERIFIED";
}>;

export type SyncLegacyRepairResponse = Readonly<{
  jobId: string;
  version: string;
  candidates: readonly SyncLegacyRepairCandidate[];
}>;

export interface SyncLegacyRepairRepository {
  findById(jobId: string): Promise<SyncJobRecord | null>;
  applyLegacyStatusRepair(input: {
    jobId: string;
    organizationId: string;
    version: string;
    appliedAt: string;
  }): Promise<
    | null
    | Readonly<{ disposition: "conflict" }>
    | Readonly<{
        disposition: "applied";
        job: SyncJobRecord;
        candidates: readonly SyncLegacyRepairCandidate[];
      }>
  >;
}

const MODULE_CONNECTORS: Readonly<Record<string, ConnectorId>> = Object.freeze({
  catalog: "sellerSprite",
  keywords: "sif",
  traffic: "sif",
  reviews: "sorftime",
  sales_trend: "sorftime",
  child_sales: "sorftime",
  price_strategy: "sorftime",
  fba: "sorftime",
  listing: "sorftime",
  category: "sorftime",
});

export class SyncLegacyRepairConflictError extends Error {
  constructor() {
    super("Legacy repair preview is stale");
    this.name = "SyncLegacyRepairConflictError";
  }
}

export class SyncLegacyStatusRepairService {
  readonly #repository: SyncLegacyRepairRepository;
  readonly #now: () => string;

  constructor(options: {
    repository: SyncLegacyRepairRepository;
    now?: () => string;
  }) {
    this.#repository = options.repository;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async preview(input: {
    organizationId: string;
    jobId: string;
  }): Promise<SyncLegacyRepairResponse | null> {
    const job = await this.#repository.findById(input.jobId);
    if (!job || !repairableJob(job, input.organizationId)) return null;
    return Object.freeze({
      jobId: job.jobId,
      version: legacyRepairVersion(job.updatedAt),
      candidates: legacyRepairCandidates(job),
    });
  }

  async apply(input: {
    organizationId: string;
    jobId: string;
    version: string;
  }): Promise<SyncLegacyRepairResponse | null> {
    const result = await this.#repository.applyLegacyStatusRepair({
      ...input,
      appliedAt: this.#now(),
    });
    if (!result) return null;
    if (result.disposition === "conflict") throw new SyncLegacyRepairConflictError();
    return Object.freeze({
      jobId: result.job.jobId,
      version: legacyRepairVersion(result.job.updatedAt),
      candidates: result.candidates,
    });
  }
}

export function legacyRepairCandidates(
  job: SyncJobRecord,
): readonly SyncLegacyRepairCandidate[] {
  if (!isTerminal(job.status) || hasDiagnosticsVersion(job)) return [];
  const evidence = providerEvidence(job);
  const candidates: SyncLegacyRepairCandidate[] = [];
  for (const asin of [...job.asins].sort()) {
    for (const [module, progress] of Object.entries(job.asinProgress[asin] ?? {}).sort(([left], [right]) => left.localeCompare(right))) {
      const connectorId = MODULE_CONNECTORS[module];
      if (!connectorId || progress.status !== "upstream-empty") continue;
      if (hasValidEmptyReason(progress.reason)) continue;
      if (evidence.has(`${asin}\u0000${module}`)) continue;
      candidates.push({
        asin,
        module,
        connectorId,
        nextStatus: "pending",
        reason: "LEGACY_UNVERIFIED",
      });
    }
  }
  return candidates;
}

export function legacyRepairVersion(updatedAt: string): string {
  return Buffer.from(updatedAt, "utf8").toString("base64url");
}

export function repairableJob(job: SyncJobRecord, organizationId: string) {
  return job.organizationId === organizationId && isTerminal(job.status);
}

function isTerminal(status: SyncJobRecord["status"]) {
  return status === "completed" || status === "failed";
}

function hasDiagnosticsVersion(job: SyncJobRecord) {
  return typeof job.error?.diagnosticsVersion === "string";
}

function hasValidEmptyReason(reason: string | null) {
  return reason === "PROVIDER_SCHEMA_VALID_EMPTY" || reason === "连接器记录的局部结果";
}

function providerEvidence(job: SyncJobRecord) {
  const entries = Array.isArray(job.error?.providerEvidence)
    ? job.error.providerEvidence
    : [];
  const evidence = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const { asin, module, outcome } = entry as Record<string, unknown>;
    if (
      typeof asin === "string" &&
      typeof module === "string" &&
      (outcome === "success" || outcome === "schema-valid-empty")
    ) {
      evidence.add(`${asin}\u0000${module}`);
    }
  }
  return evidence;
}
