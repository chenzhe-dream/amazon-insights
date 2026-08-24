import { createHash } from "node:crypto";

import type { SyncJobRecord } from "../db/sync-job-repository";

const canonicalConnectorByStage: Readonly<Record<string, string>> = Object.freeze({
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

export interface ExactSyncJobScope {
  readonly jobId: string;
  readonly organizationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly marketplace: "US";
  readonly asins: readonly string[];
}

interface RepairRequest extends ExactSyncJobScope {
  readonly modules: readonly ["listing"];
}

interface RepairApplyRequest extends RepairRequest {
  readonly token: string;
}

interface MirrorModuleState {
  status?: string;
  [key: string]: unknown;
}

interface MirrorStage {
  id?: string;
  completedAt?: unknown;
  detail?: unknown;
  [key: string]: unknown;
}

interface MirrorDiagnostic {
  connector: string;
  stage: string;
  asin: string;
  failureKind: string;
  causeCode: string;
  [key: string]: unknown;
}

interface MirrorScope {
  organizationId?: unknown;
  projectId?: unknown;
  runId?: unknown;
  marketplace?: unknown;
  asins?: unknown;
  [key: string]: unknown;
}

export interface SyncJobMirror {
  jobId?: unknown;
  fingerprint?: unknown;
  marketplace?: unknown;
  asins?: unknown;
  status?: unknown;
  scope?: MirrorScope;
  asinProgress: Record<string, Record<string, MirrorModuleState>>;
  stages: MirrorStage[];
  diagnostics?: MirrorDiagnostic[];
  [key: string]: unknown;
}

interface RepairMarker {
  token?: unknown;
  state?: unknown;
  evidenceDigest?: unknown;
  mirrorBeforeDigest?: unknown;
  mirrorAfterDigest?: unknown;
  module?: unknown;
  [key: string]: unknown;
}

export interface GeneratedListingEvidenceSource {
  read(asins: readonly string[]): Promise<{
    readonly digest: string;
    readonly readyAsins: readonly string[];
  }>;
}

export interface SyncJobMirrorStore {
  read(jobId: string): Promise<{ readonly job: SyncJobMirror; readonly digest: string } | null>;
  compareAndSwap(input: {
    readonly jobId: string;
    readonly expectedDigest: string;
    readonly nextJob: SyncJobMirror;
    readonly nextDigest: string;
  }): Promise<"applied" | "already-applied" | "conflict">;
}

export interface PersistedReadinessRepository {
  findById(jobId: string): Promise<SyncJobRecord | null>;
  applyPersistedReadinessRepair(input: PersistedReadinessRepairInput): Promise<RepairRepositoryResult | null>;
  finalizePersistedReadinessRepair(input: {
    readonly scope: ExactSyncJobScope;
    readonly token: string;
    readonly finalizedAt: string;
  }): Promise<RepairRepositoryResult | null>;
}

export interface PersistedReadinessRepairInput {
  readonly scope: ExactSyncJobScope;
  readonly token: string;
  readonly expectedUpdatedAt: string;
  readonly evidenceDigest: string;
  readonly mirrorBeforeDigest: string;
  readonly mirrorAfterDigest: string;
  readonly appliedAt: string;
  readonly module: "listing";
}

export type RepairRepositoryResult =
  | { readonly disposition: "conflict" }
  | { readonly disposition: "mirror-pending" | "applied"; readonly job: SyncJobRecord };

export class PersistedReadinessConflictError extends Error {
  constructor(message = "Persisted readiness reconciliation state changed") {
    super(message);
    this.name = "PersistedReadinessConflictError";
  }
}

export class PersistedReadinessEvidenceError extends Error {
  constructor(message = "Every requested ASIN must have generated Listing readiness evidence") {
    super(message);
    this.name = "PersistedReadinessEvidenceError";
  }
}

interface RepairTokenPayload {
  readonly v: 1;
  readonly scope: ExactSyncJobScope;
  readonly updatedAt: string;
  readonly mirrorDigest: string;
  readonly evidenceDigest: string;
  readonly appliedAt: string;
}

export class SyncPersistedReadinessReconciliationService {
  private readonly repository: PersistedReadinessRepository;
  private readonly mirrorStore: SyncJobMirrorStore;
  private readonly evidenceSource: GeneratedListingEvidenceSource;
  private readonly now: () => string;

  constructor(input: {
    readonly repository: PersistedReadinessRepository;
    readonly mirrorStore: SyncJobMirrorStore;
    readonly evidenceSource: GeneratedListingEvidenceSource;
    readonly now?: () => string;
  }) {
    this.repository = input.repository;
    this.mirrorStore = input.mirrorStore;
    this.evidenceSource = input.evidenceSource;
    this.now = input.now ?? (() => new Date().toISOString());
  }

  async preview(request: RepairRequest) {
    assertListingOnly(request);
    const current = await this.readExactState(request);
    if (!current) return null;
    assertInitialRepairable(current.databaseJob, current.mirror.job, request.asins);
    const evidence = await this.readCompleteEvidence(request.asins);
    const appliedAt = this.now();
    const nextMirror = repairMirror(current.mirror.job, request.asins, appliedAt);
    const payload: RepairTokenPayload = {
      v: 1,
      scope: exactScope(request),
      updatedAt: current.databaseJob.updatedAt,
      mirrorDigest: current.mirror.digest,
      evidenceDigest: evidence.digest,
      appliedAt,
    };
    return {
      jobId: request.jobId,
      token: encodeToken(payload),
      candidates: request.asins.map((asin) => ({
        asin,
        module: "listing" as const,
        connectorId: "sorftime" as const,
        nextStatus: "ready" as const,
        reason: "GENERATED_DATA_READY" as const,
      })),
      droppedDiagnostics: diagnostics(current.mirror.job).length - diagnostics(nextMirror).length,
      retainedDiagnostics: diagnostics(nextMirror).length,
      resultingStageStatus: "done" as const,
      resultingJobStatus: nextMirror.status,
    };
  }

  async apply(request: RepairApplyRequest) {
    assertListingOnly(request);
    const token = decodeToken(request.token);
    if (!sameScope(token.scope, request)) throw new PersistedReadinessConflictError("Repair token scope does not match");

    const databaseJob = await this.repository.findById(request.jobId);
    const mirror = await this.mirrorStore.read(request.jobId);
    if (!databaseJob || !mirror || !matchesExactScope(databaseJob, request) || !matchesMirrorScope(mirror.job, request)) {
      return null;
    }
    const evidence = await this.readCompleteEvidence(request.asins);
    if (evidence.digest !== token.evidenceDigest) throw new PersistedReadinessConflictError("Generated evidence changed");

    const marker = repairMarker(databaseJob);
    const retrying = marker?.token === request.token;
    if (!retrying && databaseJob.updatedAt !== token.updatedAt) {
      throw new PersistedReadinessConflictError("Database row changed");
    }
    if (!retrying && mirror.digest !== token.mirrorDigest) {
      throw new PersistedReadinessConflictError("Mirror changed");
    }
    if (!retrying) assertInitialRepairable(databaseJob, mirror.job, request.asins);
    else assertRetryMarker(marker, token);

    const nextMirror = repairMirror(mirror.job, request.asins, token.appliedAt);
    const mirrorAfterDigest = digest(nextMirror);
    if (retrying && marker?.mirrorAfterDigest !== mirrorAfterDigest && mirror.digest !== marker?.mirrorAfterDigest) {
      throw new PersistedReadinessConflictError("Pending mirror content changed");
    }

    const databaseResult = await this.repository.applyPersistedReadinessRepair({
      scope: token.scope,
      token: request.token,
      expectedUpdatedAt: token.updatedAt,
      evidenceDigest: token.evidenceDigest,
      mirrorBeforeDigest: token.mirrorDigest,
      mirrorAfterDigest,
      appliedAt: token.appliedAt,
      module: "listing",
    });
    if (!databaseResult) return null;
    if (databaseResult.disposition === "conflict") throw new PersistedReadinessConflictError();

    if (mirror.digest !== mirrorAfterDigest) {
      const swapped = await this.mirrorStore.compareAndSwap({
        jobId: request.jobId,
        expectedDigest: token.mirrorDigest,
        nextJob: nextMirror,
        nextDigest: mirrorAfterDigest,
      });
      if (swapped === "conflict") return { jobId: request.jobId, disposition: "mirror-pending" as const };
    }

    const finalized = await this.repository.finalizePersistedReadinessRepair({
      scope: token.scope,
      token: request.token,
      finalizedAt: this.now(),
    });
    if (!finalized || finalized.disposition === "conflict") throw new PersistedReadinessConflictError("Could not finalize repair");
    return { jobId: request.jobId, disposition: "applied" as const };
  }

  private async readCompleteEvidence(asins: readonly string[]) {
    const evidence = await this.evidenceSource.read(asins);
    const ready = new Set(evidence.readyAsins);
    if (!isSha256(evidence.digest) || asins.some((asin) => !ready.has(asin))) {
      throw new PersistedReadinessEvidenceError();
    }
    return evidence;
  }

  private async readExactState(request: RepairRequest) {
    const [databaseJob, mirror] = await Promise.all([
      this.repository.findById(request.jobId),
      this.mirrorStore.read(request.jobId),
    ]);
    if (!databaseJob || !mirror) return null;
    if (!matchesExactScope(databaseJob, request) || !matchesMirrorScope(mirror.job, request)) return null;
    return { databaseJob, mirror };
  }
}

function assertListingOnly(request: RepairRequest): void {
  if (request.modules.length !== 1 || request.modules[0] !== "listing") {
    throw new TypeError("Only the listing module is supported");
  }
}

function assertInitialRepairable(databaseJob: SyncJobRecord, mirror: SyncJobMirror, asins: readonly string[]): void {
  if (!["completed", "failed"].includes(databaseJob.status) || databaseJob.leasedBy !== null || databaseJob.leaseExpiresAt !== null) {
    throw new PersistedReadinessConflictError("Database job must be terminal and unleased");
  }
  if (!["completed", "completed-with-gaps", "failed"].includes(String(mirror.status))) {
    throw new PersistedReadinessConflictError("Mirror job must be terminal");
  }
  for (const asin of asins) {
    if (databaseJob.asinProgress[asin]?.listing?.status !== "connector-failed" || mirror.asinProgress?.[asin]?.listing?.status !== "connector-failed") {
      throw new PersistedReadinessConflictError("Listing is not an exact connector-failed candidate");
    }
  }
}

function assertRetryMarker(marker: RepairMarker | undefined, token: RepairTokenPayload): void {
  if (!marker || marker.evidenceDigest !== token.evidenceDigest
    || marker.mirrorBeforeDigest !== token.mirrorDigest
    || marker.module !== "listing"
    || !["mirror-pending", "applied"].includes(String(marker.state))) {
    throw new PersistedReadinessConflictError("Repair marker does not match token");
  }
}

function repairMarker(job: SyncJobRecord): RepairMarker | undefined {
  const marker = job.error?.persistedReadinessRepair;
  return marker && typeof marker === "object" && !Array.isArray(marker) ? marker as RepairMarker : undefined;
}

function exactScope(request: ExactSyncJobScope): ExactSyncJobScope {
  return {
    jobId: request.jobId,
    organizationId: request.organizationId,
    projectId: request.projectId,
    runId: request.runId,
    fingerprint: request.fingerprint,
    marketplace: request.marketplace,
    asins: [...request.asins],
  };
}

function matchesExactScope(job: SyncJobRecord, scope: ExactSyncJobScope): boolean {
  return job.jobId === scope.jobId
    && job.organizationId === scope.organizationId
    && job.projectId === scope.projectId
    && job.runId === scope.runId
    && job.fingerprint === scope.fingerprint
    && job.marketplace === scope.marketplace
    && equalStrings(job.asins, scope.asins)
    && job.scope.organizationId === scope.organizationId
    && job.scope.projectId === scope.projectId
    && job.scope.runId === scope.runId
    && job.scope.marketplace === scope.marketplace
    && equalStrings(job.scope.asins, scope.asins);
}

function matchesMirrorScope(job: SyncJobMirror, scope: ExactSyncJobScope): boolean {
  return job.jobId === scope.jobId
    && job.fingerprint === scope.fingerprint
    && job.marketplace === scope.marketplace
    && equalStrings(job.asins, scope.asins)
    && job.scope?.organizationId === scope.organizationId
    && job.scope?.projectId === scope.projectId
    && job.scope?.runId === scope.runId
    && job.scope?.marketplace === scope.marketplace
    && equalStrings(job.scope?.asins, scope.asins);
}

function sameScope(left: ExactSyncJobScope, right: ExactSyncJobScope): boolean {
  return left.jobId === right.jobId && left.organizationId === right.organizationId
    && left.projectId === right.projectId && left.runId === right.runId
    && left.fingerprint === right.fingerprint && left.marketplace === right.marketplace
    && equalStrings(left.asins, right.asins);
}

function equalStrings(left: unknown, right: unknown): boolean {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function repairMirror(current: SyncJobMirror, asins: readonly string[], appliedAt: string): SyncJobMirror {
  const next = structuredClone(current);
  for (const asin of asins) {
    next.asinProgress[asin].listing = { status: "ready", reason: null, updatedAt: appliedAt };
  }
  next.stages = next.stages.map((stage) => {
    if (stage.id !== "listing") return stage;
    const remaining = { ...stage };
    delete remaining.detail;
    return { ...remaining, status: "done", completedAt: stage.completedAt ?? appliedAt };
  });
  const jobAsins = new Set(asins);
  next.diagnostics = diagnostics(next).filter((entry) => jobAsins.has(entry.asin)
    && canonicalConnectorByStage[entry.stage] === entry.connector);
  next.providerDegraded = providerDegradationSnapshot(next.diagnostics);
  next.status = hasRealGap(next.asinProgress, asins) ? "completed-with-gaps" : "completed";
  next.updatedAt = appliedAt;
  return next;
}

function diagnostics(job: SyncJobMirror): MirrorDiagnostic[] {
  return Array.isArray(job.diagnostics) ? job.diagnostics : [];
}

function providerDegradationSnapshot(entries: readonly MirrorDiagnostic[]) {
  const byConnector = new Map<string, { connector: string; failureKind: string; causeCode: string }>();
  for (const entry of entries) {
    if (entry.failureKind === "schema" || entry.failureKind === "provider-degraded") continue;
    if (!byConnector.has(entry.connector)) {
      byConnector.set(entry.connector, {
        connector: entry.connector,
        failureKind: entry.failureKind,
        causeCode: entry.causeCode,
      });
    }
  }
  return [...byConnector.values()].sort((left, right) => left.connector.localeCompare(right.connector));
}

function hasRealGap(progress: Record<string, Record<string, MirrorModuleState>>, asins: readonly string[]): boolean {
  const ignored = new Set(["alexa_voc"]);
  return asins.some((asin) => Object.entries(progress[asin] ?? {}).some(([module, value]) =>
    !ignored.has(module) && !["ready", "manual"].includes(String(value.status))));
}

function encodeToken(payload: RepairTokenPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${digest(body)}`;
}

function decodeToken(token: string): RepairTokenPayload {
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra || digest(body) !== signature) throw new PersistedReadinessConflictError("Invalid repair token");
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as RepairTokenPayload;
    if (parsed.v !== 1 || !isSha256(parsed.mirrorDigest) || !isSha256(parsed.evidenceDigest)) throw new Error();
    return parsed;
  } catch {
    throw new PersistedReadinessConflictError("Invalid repair token");
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
