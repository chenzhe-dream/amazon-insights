import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000002",
  projectId: "10000000-0000-4000-8000-000000000003",
  runId: "10000000-0000-4000-8000-000000000004",
  marketplace: "US",
  asins: ["B07DYG1C9B", "B07VY9Q95Q", "B0BPXRVWYK"],
};

test("equivalent active scopes reuse one persisted job and launch one worker", async (t) => {
  const storeModule = await import("../../scripts/lib/sync-job-store.mjs") as Record<string, unknown>;
  assert.equal(typeof storeModule.createSyncJobStore, "function");
  assert.equal(typeof storeModule.createSyncJobStartCoordinator, "function");

  const directory = mkdtempSync(join(tmpdir(), "sync-job-dedupe-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const createStore = storeModule.createSyncJobStore as (options: { directory: string }) => {
    createOrReuseSyncJob(input: Record<string, unknown>): { job: { jobId: string; fingerprint: string }; reused: boolean };
    patchSyncJob(jobId: string, patch: Record<string, unknown>): unknown;
  };
  const createCoordinator = storeModule.createSyncJobStartCoordinator as (options: {
    store: ReturnType<typeof createStore>;
    launch(job: { jobId: string }): Promise<void>;
  }) => { start(input: Record<string, unknown>): Promise<{ job: { jobId: string }; reused: boolean }> };
  const store = createStore({ directory });
  let launches = 0;
  const coordinator = createCoordinator({
    store,
    async launch() { launches += 1; },
  });

  const [first, second] = await Promise.all([
    coordinator.start({ ...scope, asins: [...scope.asins].reverse() }),
    coordinator.start(scope),
  ]);

  assert.equal(first.job.jobId, second.job.jobId);
  assert.equal([first.reused, second.reused].filter(Boolean).length, 1);
  assert.equal(launches, 1);
  assert.match((first.job as { fingerprint?: unknown }).fingerprint as string, /^[a-f0-9]{64}$/);

  store.patchSyncJob(first.job.jobId, { status: "completed" });
  const afterTerminal = await coordinator.start(scope);
  assert.notEqual(afterTerminal.job.jobId, first.job.jobId);
  assert.equal(afterTerminal.reused, false);
  assert.equal(launches, 2);
});

test("a restarted store rebuilds its active fingerprint index from persisted jobs", async (t) => {
  const storeModule = await import("../../scripts/lib/sync-job-store.mjs") as Record<string, unknown>;
  assert.equal(typeof storeModule.createSyncJobStore, "function");
  const directory = mkdtempSync(join(tmpdir(), "sync-job-rebuild-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const createStore = storeModule.createSyncJobStore as (options: { directory: string }) => {
    createOrReuseSyncJob(input: Record<string, unknown>): { job: { jobId: string }; reused: boolean };
  };

  const first = createStore({ directory }).createOrReuseSyncJob(scope);
  const recovered = createStore({ directory }).createOrReuseSyncJob({ ...scope, asins: [...scope.asins].reverse() });

  assert.equal(recovered.job.jobId, first.job.jobId);
  assert.equal(recovered.reused, true);
});
