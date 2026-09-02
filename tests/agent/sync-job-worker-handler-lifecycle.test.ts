import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs, { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SyncJobLeaseLostError,
  type SyncJobLease,
  type SyncJobRecord,
  type SyncJobRepository,
} from "../../server/db/sync-job-repository";
import {
  createDetachedRunner,
  SyncJobWorkerHandler,
} from "../../server/services/sync-job-worker-handler";

const NOW = "2026-08-27T08:00:00.000Z";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for lifecycle event");
    await delay(5);
  }
}

function runningLease(): SyncJobLease {
  const job: SyncJobRecord = {
    jobId: "lifecycle-job",
    organizationId: "lifecycle-organization",
    projectId: null,
    runId: null,
    actorId: null,
    fingerprint: "lifecycle-fingerprint",
    asins: ["B0LIFECYCLE"],
    marketplace: "US",
    status: "running",
    message: "running",
    currentStageId: "catalog",
    stages: [{
      id: "catalog",
      label: "Catalog",
      kind: "auto",
      status: "active",
      estimatedSeconds: 1,
    }],
    asinProgress: {},
    leasedBy: "lifecycle-worker",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-08-27T08:01:00.000Z",
    error: null,
    createdAt: NOW,
    updatedAt: NOW,
    scope: {
      organizationId: "lifecycle-organization",
      projectId: null,
      runId: null,
      marketplace: "US",
      asins: ["B0LIFECYCLE"],
    },
  };
  return { job, leaseGeneration: 1 };
}

function repositoryForLifecycle(input: {
  readonly events: string[];
  readonly recordProgress?: SyncJobRepository["recordProgress"];
  readonly heartbeat?: SyncJobRepository["heartbeat"];
}): SyncJobRepository {
  const lease = runningLease();
  return {
    async readStageOutput() {
      return null;
    },
    async recordProgress(progress) {
      if (input.recordProgress) return await input.recordProgress(progress);
      return lease.job;
    },
    async heartbeat(heartbeat) {
      if (input.heartbeat) return await input.heartbeat(heartbeat);
      return lease.job;
    },
    async complete() {
      input.events.push("db:complete");
      return { ...lease.job, status: "completed" };
    },
    async fail(failure) {
      input.events.push(`db:fail:${failure.message}`);
      return { ...lease.job, status: "failed" };
    },
  } as unknown as SyncJobRepository;
}

test("background progress failure aborts and settles the runner before failing the database", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-background-failure-"));
  const events: string[] = [];
  const runnerStarted = deferred<void>();
  const runnerSettled = deferred<void>();
  const releaseUnabortedRunner = deferred<void>();
  let progressCalls = 0;
  const repository = repositoryForLifecycle({
    events,
    async recordProgress() {
      progressCalls += 1;
      events.push("db:progress-error");
      throw new Error("authoritative progress write failed");
    },
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 5,
    runner: async (_lease, context) => {
      events.push("runner:start");
      runnerStarted.resolve();
      try {
        const outcome = await Promise.race([
          new Promise<"aborted">((resolve) => {
            context.abortSignal?.addEventListener("abort", () => resolve("aborted"), { once: true });
          }),
          releaseUnabortedRunner.promise.then(() => "released" as const),
        ]);
        if (outcome === "aborted") {
          events.push("runner:abort");
          throw new DOMException("runner stopped", "AbortError");
        }
        events.push("runner:publication");
        return { status: "completed" };
      } finally {
        events.push("runner:settled");
        runnerSettled.resolve();
      }
    },
  });

  try {
    const handle = handler.handle(runningLease());
    await runnerStarted.promise;
    await waitFor(() => progressCalls > 0);
    const earlyOutcome = await Promise.race([
      handle.then(() => "resolved" as const),
      delay(150).then(() => "waiting" as const),
    ]);
    if (earlyOutcome === "resolved" && !events.includes("runner:settled")) {
      releaseUnabortedRunner.resolve();
    }
    await runnerSettled.promise;
    await handle;

    assert.equal(earlyOutcome, "resolved");
    assert.ok(events.indexOf("runner:abort") >= 0, events.join(" -> "));
    assert.ok(
      events.indexOf("runner:abort") < events.indexOf("runner:settled"),
      events.join(" -> "),
    );
    assert.ok(
      events.indexOf("runner:settled") < events.indexOf("db:fail:authoritative progress write failed"),
      events.join(" -> "),
    );
    assert.equal(events.includes("runner:publication"), false, events.join(" -> "));
    assert.equal(events.some((event) => event.includes("AbortError")), false);
  } finally {
    releaseUnabortedRunner.resolve();
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("lost lease aborts and settles the runner without failing the database", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-lost-lease-"));
  const events: string[] = [];
  const runnerStarted = deferred<void>();
  const runnerSettled = deferred<void>();
  let heartbeatCalls = 0;
  const repository = repositoryForLifecycle({
    events,
    async heartbeat() {
      heartbeatCalls += 1;
      events.push("db:lease-lost");
      throw new SyncJobLeaseLostError();
    },
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 5,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      events.push("runner:start");
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => {
          events.push("runner:abort");
          resolve();
        }, { once: true });
      });
      events.push("runner:settled");
      runnerSettled.resolve();
    },
  });

  try {
    const handle = handler.handle(runningLease());
    await runnerStarted.promise;
    await waitFor(() => heartbeatCalls > 0);
    await handle;
    assert.deepEqual(events, [
      "runner:start",
      "db:lease-lost",
      "runner:abort",
      "runner:settled",
    ]);
    await runnerSettled.promise;
  } finally {
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("heartbeat failure preserves its first error after the runner rejects on abort", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-heartbeat-failure-"));
  const events: string[] = [];
  const runnerStarted = deferred<void>();
  let heartbeatCalls = 0;
  const repository = repositoryForLifecycle({
    events,
    async heartbeat() {
      heartbeatCalls += 1;
      events.push("db:heartbeat-error");
      throw new Error("authoritative heartbeat failed");
    },
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 5,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      events.push("runner:start");
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => {
          events.push("runner:abort");
          resolve();
        }, { once: true });
      });
      events.push("runner:settled");
      throw new DOMException("runner stopped", "AbortError");
    },
  });

  try {
    const handle = handler.handle(runningLease());
    await runnerStarted.promise;
    await waitFor(() => heartbeatCalls > 0);
    await handle;
    assert.ok(
      events.indexOf("runner:settled") < events.indexOf("db:fail:authoritative heartbeat failed"),
      events.join(" -> "),
    );
    assert.equal(events.some((event) => event.includes("AbortError")), false);
  } finally {
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("external abort waits for runner cleanup and does not fail the database", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-external-abort-"));
  const events: string[] = [];
  const runnerStarted = deferred<void>();
  const abortObserved = deferred<void>();
  const allowCleanup = deferred<void>();
  const repository = repositoryForLifecycle({ events });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      events.push("runner:start");
      runnerStarted.resolve();
      await new Promise<void>((resolve) => {
        context.abortSignal?.addEventListener("abort", () => {
          events.push("runner:abort");
          abortObserved.resolve();
          resolve();
        }, { once: true });
      });
      await allowCleanup.promise;
      events.push("runner:settled");
    },
  });
  const controller = new AbortController();

  try {
    const handle = handler.handle(runningLease(), controller.signal);
    await runnerStarted.promise;
    controller.abort();
    await abortObserved.promise;
    assert.equal(await Promise.race([
      handle.then(() => "resolved" as const),
      delay(50).then(() => "waiting" as const),
    ]), "waiting");
    allowCleanup.resolve();
    await handle;
    assert.deepEqual(events, ["runner:start", "runner:abort", "runner:settled"]);
  } finally {
    allowCleanup.resolve();
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("normal runner completion does not abort its internal signal", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-normal-completion-"));
  const events: string[] = [];
  const repository = repositoryForLifecycle({ events });
  const controller = new AbortController();
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (_lease, context) => {
      events.push(`runner:aborted:${String(context.abortSignal?.aborted)}`);
      return { status: "completed", message: "completed" };
    },
  });

  try {
    await handler.handle(runningLease(), controller.signal);
    assert.deepEqual(events, ["runner:aborted:false", "db:complete"]);
    assert.equal(controller.signal.aborted, false);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("publication mirror failure after authoritative progress does not fail a successful job", async () => {
  const mirrorDirectory = await mkdtemp(join(tmpdir(), "sync-runner-publication-mirror-failure-"));
  const events: string[] = [];
  const originalRenameSync = fs.renameSync;
  let recordProgressCalls = 0;
  let rejectMirrorRenames = false;
  const initialLease = runningLease();
  const lease: SyncJobLease = {
    ...initialLease,
    job: { ...initialLease.job, projectId: "lifecycle-project", runId: "lifecycle-run" },
  };
  const repository = repositoryForLifecycle({
    events,
    async recordProgress() {
      recordProgressCalls += 1;
      events.push("db:progress");
      rejectMirrorRenames = true;
      return { ...lease.job, jobVersion: recordProgressCalls };
    },
  });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 5,
    runner: async () => {
      await waitFor(() => recordProgressCalls > 0);
      return { status: "completed" };
    },
  });
  fs.renameSync = ((source, destination) => {
    if (rejectMirrorRenames) {
      throw Object.assign(new Error("publication mirror failure"), { code: "EIO" });
    }
    return originalRenameSync(source, destination);
  }) as typeof fs.renameSync;

  try {
    await handler.handle(lease);
    assert.ok(events.includes("db:progress"), events.join(" -> "));
    assert.ok(events.includes("db:complete"), events.join(" -> "));
    assert.equal(events.some((event) => event.startsWith("db:fail:")), false, events.join(" -> "));
  } finally {
    fs.renameSync = originalRenameSync;
    await rm(mirrorDirectory, { recursive: true, force: true });
  }
});

test("final diagnostic mirror failure after a successful child exit does not fail the job", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-runner-diagnostic-mirror-failure-"));
  const runnerPath = join(directory, "successful-runner.mjs");
  const events: string[] = [];
  const originalRenameSync = fs.renameSync;
  let rejectMirrorRenames = false;
  await writeFile(runnerPath, "process.exitCode = 0;\n", "utf8");
  const detachedRunner = createDetachedRunner(process.cwd(), { runnerPath });
  const repository = repositoryForLifecycle({ events });
  const handler = new SyncJobWorkerHandler({
    syncJobs: repository,
    mirrorDirectory: directory,
    heartbeatIntervalMs: 60_000,
    progressPollMs: 60_000,
    runner: async (lease, context) => {
      rejectMirrorRenames = true;
      await detachedRunner(lease, context);
      return { status: "completed" };
    },
  });
  fs.renameSync = ((source, destination) => {
    if (rejectMirrorRenames) {
      throw Object.assign(new Error("diagnostic mirror failure"), { code: "EIO" });
    }
    return originalRenameSync(source, destination);
  }) as typeof fs.renameSync;

  try {
    await handler.handle(runningLease());
    assert.deepEqual(events, ["db:complete"]);
  } finally {
    fs.renameSync = originalRenameSync;
    await rm(directory, { recursive: true, force: true });
  }
});

test("production detached runner settles only after close cleanup and diagnostics persistence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sync-detached-close-order-"));
  const startMarker = join(directory, "started.txt");
  const events: string[] = [];
  const controller = new AbortController();
  const runner = createDetachedRunner(process.cwd(), {
    runnerPath: join(process.cwd(), "tests", "fixtures", "sync-runner-abort-cleanup.mjs"),
    environment: {
      SYNC_RUNNER_START_MARKER: startMarker,
    },
  });

  try {
    const outcome = runner(runningLease(), {
      workerId: "lifecycle-worker",
      leaseGeneration: 1,
      mirrorPath: join(directory, "mirror.json"),
      abortSignal: controller.signal,
      async writeMirror() {
        events.push("diagnostics:start");
        await delay(25);
        events.push("diagnostics:complete");
      },
    }).then(
      () => ({ status: "resolved" as const, name: null }),
      (error: unknown) => ({
        status: "rejected" as const,
        name: error instanceof Error ? error.name : String(error),
      }),
    );
    await waitFor(() => existsSync(startMarker));
    controller.abort();
    const result = await outcome;

    assert.deepEqual(events, ["diagnostics:start", "diagnostics:complete"]);
    assert.deepEqual(result, { status: "rejected", name: "AbortError" });
  } finally {
    controller.abort();
    await waitFor(() => events.includes("diagnostics:complete"), 3_000).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
