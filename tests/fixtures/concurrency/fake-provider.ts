import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import type { FastifyInstance } from "fastify";

import { buildAgentApp } from "../../../server/app";
import { AuthenticationService } from "../../../server/auth/authentication-service";
import { BoundedLoginRateLimiter } from "../../../server/auth/login-rate-limiter";
import { PostgresResourceGovernor } from "../../../server/db/concurrency-control-repository";
import { openPostgresAgentRepository } from "../../../server/db/postgres-repository";
import type { RuntimeAgentRepository } from "../../../server/db/repository";
import { SyncJobDispatcher } from "../../../server/runtime/sync-job-dispatcher";
import {
  SyncJobWorkerHandler,
  type SyncJobRunner,
} from "../../../server/services/sync-job-worker-handler";
import { createDefaultLocalDataBridgeDeps } from "../../../server/routes/local-data";
import { loadAgentAuthenticationConfig } from "../../../server/config";
import type {
  GovernedResource,
  ResourceGovernor,
} from "../../../server/db/concurrency-control-repository";
import type { SyncJobLease } from "../../../server/db/sync-job-repository";

export const STANDARD_FAKE_LIMITS = Object.freeze({
  wholeJob: 4,
  sellerSprite: 2,
  sif: 1,
  sorftime: 1,
  model: 2,
  image: 2,
});

type FakeProviderOptions = Readonly<{
  statsPath: string;
  stepDelayMs?: number;
}>;

type FakeEvent = Readonly<{
  at: string;
  type:
    | "agent-ready"
    | "job-start"
    | "job-end"
    | "resource-start"
    | "resource-end"
    | "seller-attempt"
    | "agent-stopping"
    | "agent-stopped";
  agentId: string;
  jobId?: string;
  resource?: GovernedResource;
  active?: number;
  port?: number;
}>;

type ActiveCounters = Record<GovernedResource, number>;

const resources: readonly GovernedResource[] = [
  "sellerSprite",
  "sif",
  "sorftime",
  "model",
  "image",
];

export function createFakeSyncRunner(
  repository: RuntimeAgentRepository,
  agentId: string,
  options: FakeProviderOptions,
): SyncJobRunner {
  const counters: ActiveCounters = {
    wholeJob: 0,
    sellerSprite: 0,
    sif: 0,
    sorftime: 0,
    model: 0,
    image: 0,
  };
  const governor = new PostgresResourceGovernor(
    repository.concurrencyControl,
    `${agentId}-resource-governor`,
  );
  const stepDelayMs = options.stepDelayMs ?? 90;

  return async (lease, context) => {
    await emit(options.statsPath, {
      at: new Date().toISOString(),
      type: "job-start",
      agentId,
      jobId: lease.job.jobId,
    });
    try {
      for (const resource of resources) {
        await Promise.all(
          Array.from({ length: parallelAttemptsFor(resource) }, () =>
            runResourceStep({
              resource,
              lease,
              governor,
              counters,
              context,
              agentId,
              options,
              delayMs: stepDelayMs,
            }),
          ),
        );
      }
      await writeTerminalMirror(lease, context);
      return {
        status: "completed",
        message: "Fake provider completed bounded sync job",
      };
    } finally {
      await emit(options.statsPath, {
        at: new Date().toISOString(),
        type: "job-end",
        agentId,
        jobId: lease.job.jobId,
      });
    }
  };
}

async function runResourceStep(input: {
  resource: GovernedResource;
  lease: SyncJobLease;
  governor: ResourceGovernor;
  counters: ActiveCounters;
  context: Parameters<SyncJobRunner>[1];
  agentId: string;
  options: FakeProviderOptions;
  delayMs: number;
}) {
  const operation = async () => {
    await beginResource(input);
    try {
      await delay(input.delayMs, input.context.abortSignal);
    } finally {
      await endResource(input);
    }
  };

  await input.governor.run({
    organizationId: input.lease.job.organizationId,
    resource: input.resource,
    jobId: input.lease.job.jobId,
    attemptKind: "initial",
    leaseMs: 1_000,
    maxWaitMs: 10_000,
    operation,
  });
}

function parallelAttemptsFor(resource: GovernedResource): number {
  return resource === "model" || resource === "image" ? 2 : 1;
}

async function beginResource(input: {
  resource: GovernedResource;
  lease: SyncJobLease;
  counters: ActiveCounters;
  agentId: string;
  options: FakeProviderOptions;
}) {
  input.counters[input.resource] += 1;
  const now = new Date().toISOString();
  await emit(input.options.statsPath, {
    at: now,
    type: "resource-start",
    agentId: input.agentId,
    jobId: input.lease.job.jobId,
    resource: input.resource,
    active: input.counters[input.resource],
  });
  if (input.resource === "sellerSprite") {
    await emit(input.options.statsPath, {
      at: now,
      type: "seller-attempt",
      agentId: input.agentId,
      jobId: input.lease.job.jobId,
      resource: input.resource,
    });
  }
}

async function endResource(input: {
  resource: GovernedResource;
  lease: SyncJobLease;
  counters: ActiveCounters;
  agentId: string;
  options: FakeProviderOptions;
}) {
  input.counters[input.resource] = Math.max(
    0,
    input.counters[input.resource] - 1,
  );
  await emit(input.options.statsPath, {
    at: new Date().toISOString(),
    type: "resource-end",
    agentId: input.agentId,
    jobId: input.lease.job.jobId,
    resource: input.resource,
    active: input.counters[input.resource],
  });
}

async function writeTerminalMirror(
  lease: SyncJobLease,
  context: Parameters<SyncJobRunner>[1],
) {
  const completedAt = new Date().toISOString();
  await context.writeMirror({
    status: "completed",
    message: "Fake provider completed bounded sync job",
    currentStageId: "image_remarks",
    stages: lease.job.stages.map((stage) =>
      stage.kind === "manual"
        ? stage
        : {
            ...stage,
            status: stage.id === "build" ? "skipped" : "done",
            completedAt,
          },
    ),
    asinProgress: Object.fromEntries(
      lease.job.asins.map((asin) => [
        asin,
        Object.fromEntries(
          [
            "catalog",
            "keywords",
            "reviews",
            "sales_trend",
            "child_sales",
            "price_strategy",
            "fba",
            "listing",
            "category",
            "traffic",
            "image_remarks",
          ].map((module) => [
            module,
            { status: "ready", reason: null, updatedAt: completedAt },
          ]),
        ),
      ]),
    ),
    completedAt,
  });
}

async function emit(statsPath: string, event: FakeEvent) {
  await mkdir(dirname(statsPath), { recursive: true });
  await appendFile(statsPath, `${JSON.stringify(event)}\n`, "utf8");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new Error("Fake provider aborted"));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timeout);
        reject(new Error("Fake provider aborted"));
      },
      { once: true },
    );
  });
}

async function startFakeAgentProcess() {
  const port = Number(process.env.FAKE_AGENT_PORT);
  const databaseUrl = process.env.AGENT_DATABASE_URL;
  const proxyToken = process.env.AGENT_SERVICE_PROXY_TOKEN;
  const trustedOrigin = process.env.FAKE_TRUSTED_ORIGIN;
  const statsPath = process.env.FAKE_PROVIDER_STATS_PATH;
  const agentId = process.env.FAKE_AGENT_ID ?? `fake-agent-${process.pid}`;
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new Error("FAKE_AGENT_PORT is required");
  }
  if (!databaseUrl || !proxyToken || !trustedOrigin || !statsPath) {
    throw new Error("Fake agent environment is incomplete");
  }

  const env = {
    ...process.env,
    NODE_ENV: "test",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_PORT: String(port),
    AGENT_DATABASE_URL: databaseUrl,
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: trustedOrigin,
    AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1",
  };
  const repository = await openPostgresAgentRepository({
    connectionString: databaseUrl,
  });
  const authConfig = loadAgentAuthenticationConfig(env);
  const authService = new AuthenticationService({
    repository,
    limiter: new BoundedLoginRateLimiter(authConfig.loginLimiter),
    sessionTtlMs: authConfig.sessionTtlMs,
  });
  const app: FastifyInstance = buildAgentApp({
    env,
    storageAvailable: true,
    repository,
    authConfig,
    authService,
    localDataBridgeDeps: createDefaultLocalDataBridgeDeps(repository),
  });
  const dispatcher = new SyncJobDispatcher({
    syncJobs: repository.syncJobs,
    concurrencyControl: repository.concurrencyControl,
    handler: new SyncJobWorkerHandler({
      syncJobs: repository.syncJobs,
      runner: createFakeSyncRunner(repository, agentId, {
        statsPath,
      }),
      heartbeatIntervalMs: 100,
      heartbeatLeaseMs: 1_000,
      progressPollMs: 50,
      mirrorDirectory: process.env.FAKE_PROVIDER_MIRROR_DIR,
    }),
    workerIdPrefix: agentId,
    loopCount: 6,
    leaseMs: 1_000,
    wholeJobLimit: 4,
    idleDelayMs: 25,
  });
  app.get("/__fake/evidence", async () => ({ ok: true, agentId }));

  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await emit(statsPath!, {
      at: new Date().toISOString(),
      type: "agent-stopping",
      agentId,
    });
    await dispatcher.stop();
    await app.close();
    await repository.close();
    await emit(statsPath!, {
      at: new Date().toISOString(),
      type: "agent-stopped",
      agentId,
    });
  }

  process.once("SIGTERM", () => {
    void stop().finally(() => process.exit(0));
  });
  process.once("SIGINT", () => {
    void stop().finally(() => process.exit(0));
  });

  await app.listen({ host: "127.0.0.1", port });
  dispatcher.start();
  await emit(statsPath, {
    at: new Date().toISOString(),
    type: "agent-ready",
    agentId,
    port,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startFakeAgentProcess().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Fake agent failed");
    process.exitCode = 1;
  });
}
