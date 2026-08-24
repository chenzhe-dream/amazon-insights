import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

/* eslint-disable @typescript-eslint/no-explicit-any -- realistic persisted JSON fixtures are intentionally open-shaped */

import type { SyncJobRecord } from "../../server/db/sync-job-repository";
import { PostgresSyncJobStore } from "../../server/db/postgres/sync-job-store";
import {
  createFileSyncJobMirrorStore,
  runPersistedReadinessReconciliationCli,
} from "../../server/cli/reconcile-sync-job-readiness";
import {
  PersistedReadinessConflictError,
  PersistedReadinessEvidenceError,
  SyncPersistedReadinessReconciliationService,
  type ExactSyncJobScope,
  type GeneratedListingEvidenceSource,
  type PersistedReadinessRepository,
  type SyncJobMirror,
  type SyncJobMirrorStore,
} from "../../server/services/sync-persisted-readiness-reconciliation-service";

const ORGANIZATION_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_ID = "6fd7f9e2-26ec-4d67-a39f-23ca2a44bc72";
const RUN_ID = "6240686a-d80b-4a23-a80d-5e0f459579b2";
const JOB_ID = "f5805123-b097-432a-a97b-fbb3716fff1f";
const FINGERPRINT = "76ba8173a757f09c8fdc8f636159813ecc256414757b780efb406c25ec734a08";
const ASINS = ["B01FHOWYA2", "B0855B5Z6F", "B08QZWDLP4"];
const UPDATED = "2026-08-24T17:25:50.377Z";
const APPLIED = "2026-08-25T10:00:00.000Z";
const EVIDENCE_DIGEST = "e".repeat(64);

const exactScope: ExactSyncJobScope = {
  jobId: JOB_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  runId: RUN_ID,
  fingerprint: FINGERPRINT,
  marketplace: "US",
  asins: ASINS,
};
const request = { ...exactScope, modules: ["listing"] as const };

test("preview and apply repair only generated-ready Listing state and remove out-of-scope diagnostics", async () => {
  const harness = reconciliationHarness();
  const preview = await harness.service.preview(request);

  assert.ok(preview);
  assert.deepEqual(preview.candidates, ASINS.map((asin) => ({
    asin,
    module: "listing",
    connectorId: "sorftime",
    nextStatus: "ready",
    reason: "GENERATED_DATA_READY",
  })));
  assert.equal(preview.droppedDiagnostics, 3);
  assert.equal(preview.retainedDiagnostics, 1);
  assert.equal(preview.resultingStageStatus, "done");
  assert.equal(preview.resultingJobStatus, "completed-with-gaps");
  assert.equal(harness.repository.applyCalls, 0);
  assert.equal(harness.mirror.writeCalls, 0);

  const result = await harness.service.apply({ ...request, token: preview.token });
  assert.equal(result?.disposition, "applied");
  assert.equal(harness.repository.applyCalls, 1);
  assert.equal(harness.repository.finalizeCalls, 1);
  assert.equal(harness.mirror.writeCalls, 1);

  const repaired = harness.mirror.job;
  assert.equal(repaired.status, "completed-with-gaps");
  assert.equal(repaired.fingerprint, FINGERPRINT);
  assert.deepEqual(repaired.scope, currentMirror().scope);
  assert.deepEqual(repaired.publication, currentMirror().publication);
  assert.equal(repaired.completedAt, currentMirror().completedAt);
  for (const asin of ASINS) {
    assert.deepEqual(repaired.asinProgress[asin].listing, {
      status: "ready",
      reason: null,
      updatedAt: APPLIED,
    });
    for (const untouched of ["catalog", "fba", "category"] as const) {
      assert.deepEqual(
        repaired.asinProgress[asin][untouched],
        currentMirror().asinProgress[asin][untouched],
        `${asin}:${untouched}`,
      );
    }
  }
  const listing = repaired.stages.find((stage: { id: string }) => stage.id === "listing");
  assert.equal(listing.status, "done");
  assert.equal(Object.hasOwn(listing, "detail"), false);
  assert.deepEqual(repaired.diagnostics, [{
    connector: "sorftime",
    stage: "fba",
    asin: ASINS[0],
    failureKind: "connection",
    causeCode: "CONNECTION_RESET",
  }]);
  assert.deepEqual(repaired.providerDegraded, [{
    connector: "sorftime",
    failureKind: "connection",
    causeCode: "CONNECTION_RESET",
  }]);

  const databaseJob = harness.repository.job!;
  assert.equal(databaseJob.status, "completed");
  assert.equal(databaseJob.stages.find((stage) => stage.id === "listing")?.status, "done");
  assert.deepEqual(databaseJob.error?.resumeStages, ["catalog", "fba", "category"]);
  for (const asin of ASINS) {
    assert.equal(databaseJob.asinProgress[asin]?.listing?.status, "ready");
    assert.equal(databaseJob.asinProgress[asin]?.catalog?.status, "connector-failed");
    assert.equal(databaseJob.asinProgress[asin]?.fba?.status, "connector-failed");
    assert.equal(databaseJob.asinProgress[asin]?.category?.status, "upstream-empty");
  }
});

test("reconciliation rejects scope, version, evidence, and mirror drift without promotion", async () => {
  for (const mismatched of [
    { ...request, organizationId: "22222222-2222-4222-8222-222222222299" },
    { ...request, projectId: "6fd7f9e2-26ec-4d67-a39f-23ca2a44bc99" },
    { ...request, runId: "6240686a-d80b-4a23-a80d-5e0f45957999" },
    { ...request, fingerprint: "9".repeat(64) },
    { ...request, marketplace: "CA" as "US" },
    { ...request, asins: ASINS.slice(0, 2) },
  ]) {
    const harness = reconciliationHarness();
    assert.equal(await harness.service.preview(mismatched), null);
    assert.equal(harness.repository.applyCalls, 0);
  }

  const versionDrift = reconciliationHarness();
  const versionPreview = await versionDrift.service.preview(request);
  versionDrift.repository.job = { ...versionDrift.repository.job!, updatedAt: "2026-08-25T09:59:59.000Z" };
  await assert.rejects(
    versionDrift.service.apply({ ...request, token: versionPreview!.token }),
    PersistedReadinessConflictError,
  );

  const evidenceDrift = reconciliationHarness();
  const evidencePreview = await evidenceDrift.service.preview(request);
  evidenceDrift.evidence.digest = "f".repeat(64);
  await assert.rejects(
    evidenceDrift.service.apply({ ...request, token: evidencePreview!.token }),
    PersistedReadinessConflictError,
  );
  assert.equal(evidenceDrift.repository.applyCalls, 0);

  const mirrorDrift = reconciliationHarness();
  const mirrorPreview = await mirrorDrift.service.preview(request);
  mirrorDrift.mirror.job = { ...mirrorDrift.mirror.job, message: "concurrent mirror change" };
  await assert.rejects(
    mirrorDrift.service.apply({ ...request, token: mirrorPreview!.token }),
    PersistedReadinessConflictError,
  );
  assert.equal(mirrorDrift.repository.applyCalls, 0);
});

test("one generated-missing ASIN blocks the whole Listing repair", async () => {
  const harness = reconciliationHarness();
  harness.evidence.readyAsins = ASINS.slice(0, 2);

  await assert.rejects(harness.service.preview(request), PersistedReadinessEvidenceError);
  assert.equal(harness.repository.applyCalls, 0);
  assert.equal(harness.mirror.writeCalls, 0);
  for (const asin of ASINS) {
    assert.equal(harness.repository.job?.asinProgress[asin]?.listing?.status, "connector-failed");
  }
});

test("a DB-applied mirror-pending repair retries idempotently with the same token", async () => {
  const harness = reconciliationHarness();
  const preview = await harness.service.preview(request);
  harness.mirror.conflictOnce = true;

  const pending = await harness.service.apply({ ...request, token: preview!.token });
  assert.equal(pending?.disposition, "mirror-pending");
  assert.equal(harness.repository.applyCalls, 1);
  assert.equal(harness.repository.finalizeCalls, 0);
  assert.equal(harness.repository.job?.asinProgress[ASINS[0]]?.listing?.status, "ready");
  assert.equal(harness.mirror.job.asinProgress[ASINS[0]].listing.status, "connector-failed");

  const retried = await harness.service.apply({ ...request, token: preview!.token });
  assert.equal(retried?.disposition, "applied");
  assert.equal(harness.repository.applyCalls, 2);
  assert.equal(harness.repository.finalizeCalls, 1);
  assert.equal(harness.mirror.job.asinProgress[ASINS[0]].listing.status, "ready");

  const repeated = await harness.service.apply({ ...request, token: preview!.token });
  assert.equal(repeated?.disposition, "applied");
  assert.equal(harness.mirror.writeCalls, 1);
});

test("PostgreSQL apply locks one exact row and preserves unrelated module rows", async () => {
  const target = currentDatabaseJob();
  let row = jobRow(target);
  const modules = new Map(Object.entries(target.asinProgress).flatMap(([asin, progress]) =>
    Object.entries(progress).map(([module, value]) => [`${asin}\0${module}`, {
      asin,
      module,
      status: value.status,
      reason: value.reason,
      updated_at: value.updatedAt,
    }]),
  ));
  const sql: string[] = [];
  const queries = {
    async transaction<T>(operation: () => Promise<T>) { return operation(); },
    async query(text: string, values?: unknown[]) {
      sql.push(text);
      if (/FROM sync_jobs[\s\S]+FOR UPDATE/.test(text)) return { rows: [row], rowCount: 1 };
      if (/FROM sync_job_modules/.test(text)) return { rows: [...modules.values()], rowCount: modules.size };
      if (/UPDATE sync_job_modules/.test(text)) {
        const key = `${values?.[1]}\0${values?.[2]}`;
        const current = modules.get(key);
        assert.equal(current?.status, "connector-failed");
        modules.set(key, { ...current!, status: "ready", reason: null, updated_at: String(values?.[3]) });
        return { rows: [], rowCount: 1 };
      }
      if (/UPDATE sync_jobs/.test(text)) {
        row = {
          ...row,
          asin_progress: JSON.parse(String(values?.[2])),
          stages: JSON.parse(String(values?.[3])),
          error: JSON.parse(String(values?.[4])),
          updated_at: String(values?.[5]),
        };
        return { rows: [row], rowCount: 1 };
      }
      throw new Error(`unexpected query: ${text}`);
    },
  };
  const store = new PostgresSyncJobStore(queries as never);
  const result = await store.applyPersistedReadinessRepair({
    scope: exactScope,
    token: "repair-token",
    expectedUpdatedAt: UPDATED,
    evidenceDigest: EVIDENCE_DIGEST,
    mirrorBeforeDigest: "b".repeat(64),
    mirrorAfterDigest: "a".repeat(64),
    appliedAt: APPLIED,
    module: "listing",
  });

  assert.equal(result?.disposition, "mirror-pending");
  assert.equal(sql.filter((statement) => /FROM sync_jobs[\s\S]+FOR UPDATE/.test(statement)).length, 1);
  assert.equal(sql.filter((statement) => /UPDATE sync_job_modules/.test(statement)).length, ASINS.length);
  assert.ok(sql.every((statement) => !/DELETE|INSERT INTO sync_jobs/i.test(statement)));
  assert.equal(modules.get(`${ASINS[0]}\0catalog`)?.status, "connector-failed");
  assert.equal(modules.get(`${ASINS[0]}\0fba`)?.status, "connector-failed");
  assert.equal(modules.get(`${ASINS[0]}\0category`)?.status, "upstream-empty");
  assert.equal(modules.get(`${ASINS[0]}\0listing`)?.status, "ready");
  assert.match(sql[0], /WHERE job_id = \$1[\s\S]+organization_id = \$2[\s\S]+FOR UPDATE/);
});

test("CLI previews by default and applies only with an explicit token without external capabilities", async () => {
  const calls = { preview: 0, apply: 0 };
  const output: string[] = [];
  const service = {
    async preview() {
      calls.preview += 1;
      return { jobId: JOB_ID, token: "preview-token", candidates: [] };
    },
    async apply(input: { token: string }) {
      calls.apply += 1;
      assert.equal(input.token, "preview-token");
      return { jobId: JOB_ID, disposition: "applied" };
    },
  };
  const baseArgs = cliScopeArgs();

  await runPersistedReadinessReconciliationCli(baseArgs, {
    service: service as never,
    write: (value) => output.push(value),
  });
  assert.deepEqual(calls, { preview: 1, apply: 0 });

  await assert.rejects(
    runPersistedReadinessReconciliationCli([...baseArgs, "--apply"], {
      service: service as never,
      write: (value) => output.push(value),
    }),
    /--token is required/,
  );
  await runPersistedReadinessReconciliationCli(
    [...baseArgs, "--apply", "--token", "preview-token"],
    { service: service as never, write: (value) => output.push(value) },
  );
  assert.deepEqual(calls, { preview: 1, apply: 1 });
  assert.equal(output.length, 2);
});

test("file mirror compare-and-swap binds the exact hash and leaves no partial file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sync-readiness-repair-"));
  try {
    const target = path.join(directory, `${JOB_ID}.json`);
    await writeFile(target, JSON.stringify(currentMirror(), null, 2));
    const store = createFileSyncJobMirrorStore(directory);
    const before = await store.read(JOB_ID);
    assert.ok(before);
    const nextJob = { ...before.job, message: "atomically repaired" };
    const nextDigest = digest(nextJob);

    assert.equal(await store.compareAndSwap({
      jobId: JOB_ID,
      expectedDigest: before.digest,
      nextJob,
      nextDigest,
    }), "applied");
    assert.equal(digest(JSON.parse(await readFile(target, "utf8"))), nextDigest);
    assert.equal(await store.compareAndSwap({
      jobId: JOB_ID,
      expectedDigest: before.digest,
      nextJob,
      nextDigest,
    }), "already-applied");
    assert.deepEqual(await readdir(directory), [`${JOB_ID}.json`]);
  } finally {
    await rm(directory, { recursive: true });
  }
});

function reconciliationHarness() {
  const repository = memoryRepository(currentDatabaseJob());
  const mirror = memoryMirrorStore(currentMirror());
  const evidence = memoryEvidence();
  const service = new SyncPersistedReadinessReconciliationService({
    repository,
    mirrorStore: mirror,
    evidenceSource: evidence,
    now: () => APPLIED,
  });
  return { repository, mirror, evidence, service };
}

function memoryEvidence(): GeneratedListingEvidenceSource & { readyAsins: string[]; digest: string } {
  return {
    readyAsins: [...ASINS],
    digest: EVIDENCE_DIGEST,
    async read(asins) {
      return {
        digest: this.digest,
        readyAsins: this.readyAsins.filter((asin) => asins.includes(asin)),
      };
    },
  };
}

function memoryMirrorStore(initial: Record<string, any>): SyncJobMirrorStore & {
  job: Record<string, any>;
  writeCalls: number;
  conflictOnce: boolean;
} {
  return {
    job: structuredClone(initial),
    writeCalls: 0,
    conflictOnce: false,
    async read(jobId) {
      if (jobId !== this.job.jobId) return null;
      return { job: structuredClone(this.job) as SyncJobMirror, digest: digest(this.job) };
    },
    async compareAndSwap(input) {
      if (this.conflictOnce) {
        this.conflictOnce = false;
        return "conflict" as const;
      }
      const currentDigest = digest(this.job);
      if (currentDigest === input.nextDigest) return "already-applied" as const;
      if (currentDigest !== input.expectedDigest) return "conflict" as const;
      this.job = structuredClone(input.nextJob);
      this.writeCalls += 1;
      return "applied" as const;
    },
  };
}

function memoryRepository(initial: SyncJobRecord): PersistedReadinessRepository & {
  job: SyncJobRecord | null;
  applyCalls: number;
  finalizeCalls: number;
} {
  return {
    job: structuredClone(initial),
    applyCalls: 0,
    finalizeCalls: 0,
    async findById(jobId) { return this.job?.jobId === jobId ? this.job : null; },
    async applyPersistedReadinessRepair(input) {
      this.applyCalls += 1;
      if (!this.job || this.job.jobId !== input.scope.jobId || this.job.organizationId !== input.scope.organizationId) return null;
      const marker = this.job.error?.persistedReadinessRepair as Record<string, unknown> | undefined;
      if (marker?.token === input.token) {
        return { disposition: marker.state === "applied" ? "applied" as const : "mirror-pending" as const, job: this.job };
      }
      if (this.job.updatedAt !== input.expectedUpdatedAt) return { disposition: "conflict" as const };
      const asinProgress = structuredClone(this.job.asinProgress) as Record<string, Record<string, any>>;
      for (const asin of input.scope.asins) {
        if (asinProgress[asin]?.listing?.status !== "connector-failed") return { disposition: "conflict" as const };
        asinProgress[asin].listing = { status: "ready", reason: null, updatedAt: input.appliedAt };
      }
      const stages = this.job.stages.map((stage) => {
        if (stage.id !== "listing") return stage;
        const rest = { ...stage };
        delete rest.detail;
        return { ...rest, status: "done", completedAt: stage.completedAt ?? input.appliedAt };
      });
      const error = {
        ...this.job.error,
        resumeStages: (this.job.error?.resumeStages as string[]).filter((stage) => stage !== "listing"),
        persistedReadinessRepair: {
          token: input.token,
          state: "mirror-pending",
          evidenceDigest: input.evidenceDigest,
          mirrorBeforeDigest: input.mirrorBeforeDigest,
          mirrorAfterDigest: input.mirrorAfterDigest,
          module: input.module,
          appliedAt: input.appliedAt,
        },
      };
      this.job = { ...this.job, asinProgress, stages, error, updatedAt: input.appliedAt };
      return { disposition: "mirror-pending" as const, job: this.job };
    },
    async finalizePersistedReadinessRepair(input) {
      this.finalizeCalls += 1;
      if (!this.job) return null;
      const marker = this.job.error?.persistedReadinessRepair as Record<string, unknown> | undefined;
      if (marker?.token !== input.token) return { disposition: "conflict" as const };
      this.job = {
        ...this.job,
        error: { ...this.job.error, persistedReadinessRepair: { ...marker, state: "applied", finalizedAt: input.finalizedAt } },
        updatedAt: input.finalizedAt,
      };
      return { disposition: "applied" as const, job: this.job };
    },
  };
}

function currentDatabaseJob(): SyncJobRecord {
  const mirror = currentMirror();
  return {
    jobId: JOB_ID,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    runId: RUN_ID,
    actorId: "10000000-0000-4000-8000-000000000001",
    fingerprint: FINGERPRINT,
    asins: ASINS,
    marketplace: "US",
    status: "completed",
    message: mirror.message,
    currentStageId: mirror.currentStageId,
    stages: mirror.stages as SyncJobRecord["stages"],
    asinProgress: mirror.asinProgress as SyncJobRecord["asinProgress"],
    leasedBy: null,
    leaseGeneration: 1,
    leaseExpiresAt: null,
    error: { diagnosticsVersion: "1", resumeStages: ["catalog", "fba", "listing", "category"] },
    createdAt: mirror.createdAt,
    updatedAt: UPDATED,
    completedAt: mirror.completedAt,
    scope: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      marketplace: "US",
      asins: ASINS,
    },
  };
}

function currentMirror() {
  const stages = [
    { id: "catalog", label: "Catalog", kind: "auto", status: "partial", estimatedSeconds: 1, detail: "SellerSprite unavailable" },
    { id: "fba", label: "FBA", kind: "auto", status: "partial", estimatedSeconds: 1, detail: "3/3 missing" },
    { id: "listing", label: "Listing", kind: "auto", status: "partial", estimatedSeconds: 1, detail: "listing connector failed", completedAt: UPDATED },
    { id: "category", label: "Category", kind: "auto", status: "partial", estimatedSeconds: 1, detail: "3/3 missing" },
    { id: "image_remarks", label: "Images", kind: "auto", status: "skipped", estimatedSeconds: 1 },
    { id: "alexa_voc", label: "Alexa", kind: "manual", status: "manual", estimatedSeconds: 1 },
    { id: "build", label: "Build", kind: "auto", status: "done", estimatedSeconds: 1 },
  ];
  const asinProgress = Object.fromEntries(ASINS.map((asin) => [asin, {
    catalog: { status: "connector-failed", reason: "SellerSprite unavailable", updatedAt: UPDATED },
    fba: { status: "connector-failed", reason: "connector failed", updatedAt: UPDATED },
    listing: { status: "connector-failed", reason: "connector failed", updatedAt: UPDATED },
    category: { status: "upstream-empty", reason: "upstream empty", updatedAt: UPDATED },
    image_remarks: { status: "manual", reason: "disabled", updatedAt: UPDATED },
    alexa_voc: { status: "manual", reason: "manual", updatedAt: UPDATED },
  }]));
  return {
    jobId: JOB_ID,
    asins: ASINS,
    marketplace: "US",
    status: "completed-with-gaps",
    message: "同步完成，部分 ASIN 或模块存在明确缺口。",
    currentStageId: "build",
    stages,
    asinProgress,
    createdAt: "2026-08-24T17:24:24.000Z",
    updatedAt: UPDATED,
    completedAt: UPDATED,
    dynamicSnapshot: "pending",
    scope: {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      runId: RUN_ID,
      marketplace: "US",
      asins: ASINS,
    },
    fingerprint: FINGERPRINT,
    publication: { status: "pending", requestedAt: UPDATED, target: { webPort: 31900 } },
    diagnostics: [
      { connector: "sellerSprite", stage: "child_sales", asin: "B0GVN7RZ3Q", failureKind: "governor", causeCode: "RESOURCE_GOVERNOR" },
      { connector: "sellerSprite", stage: "listing", asin: ASINS[0], failureKind: "governor", causeCode: "RESOURCE_GOVERNOR" },
      { connector: "sellerSprite", stage: "listing", asin: ASINS[1], failureKind: "provider-degraded", causeCode: "PROVIDER_DEGRADED" },
      { connector: "sorftime", stage: "fba", asin: ASINS[0], failureKind: "connection", causeCode: "CONNECTION_RESET" },
    ],
    providerDegraded: [{ connector: "sellerSprite", failureKind: "governor", causeCode: "RESOURCE_GOVERNOR" }],
  };
}

function jobRow(job: SyncJobRecord) {
  return {
    job_id: job.jobId,
    organization_id: job.organizationId,
    project_id: job.projectId,
    run_id: job.runId,
    actor_id: job.actorId,
    fingerprint: job.fingerprint,
    marketplace: job.marketplace,
    asins: job.asins,
    status: job.status,
    message: job.message,
    current_stage_id: job.currentStageId,
    stages: job.stages,
    asin_progress: job.asinProgress,
    leased_by: job.leasedBy,
    lease_generation: job.leaseGeneration,
    lease_expires_at: job.leaseExpiresAt,
    policy_version: "standard-v1",
    error: job.error,
    created_at: job.createdAt,
    updated_at: job.updatedAt,
    completed_at: job.completedAt ?? null,
  };
}

function cliScopeArgs() {
  return [
    "--job-id", JOB_ID,
    "--organization-id", ORGANIZATION_ID,
    "--project-id", PROJECT_ID,
    "--run-id", RUN_ID,
    "--fingerprint", FINGERPRINT,
    "--marketplace", "US",
    "--asins", ASINS.join(","),
    "--module", "listing",
  ];
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
