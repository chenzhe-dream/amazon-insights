import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";

import { Pool, type Pool as PgPool } from "pg";

import { createAgentService } from "../../server/agent-service";
import { openRuntimeAgentRepository } from "../../server/db/open-runtime-repository";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import type { WorkerClock } from "../../server/runtime/worker-loop";
import { SCOOTER_ASINS } from "./helpers/voc-positioning-fixture";
import {
  startPostgresTestContainer,
  type PostgresTestContainer,
} from "./helpers/postgres-test-container";

const fixtureOrigin = "http://127.0.0.1:31900";
const proxyToken = "postgres-runtime-tracer-token";
const actorId = "83000000-0000-4000-8000-000000000001";
const organizationId = "83000000-0000-4000-8000-000000000002";
const now = "2026-08-19T12:00:00.000Z";

let postgres: PostgresTestContainer;

before(async () => {
  postgres = await startPostgresTestContainer();
});

after(async () => {
  await postgres?.close();
});

test("PostgreSQL Agent Service completes a local VOC HTTP run and reopens the same database URL", async (t) => {
  const databaseUrl = await isolatedDatabaseUrl();
  const firstService = await createAgentService({
    env: serviceEnv(databaseUrl, "pg-http-worker"),
  });
  t.after(async () => {
    await firstService.stop();
  });

  await firstService.start({ host: "127.0.0.1", port: 0 });
  const baseUrl = serviceBaseUrl(firstService);
  const submitted = await fetch(`${baseUrl}/v1/local-voc`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      marketplace: "US",
      asins: [...SCOOTER_ASINS],
    }),
  });
  assert.equal(submitted.status, 200);
  const { runId } = (await submitted.json()) as { runId: string };

  const terminalRun = await waitForRun(baseUrl, runId, "succeeded");
  assert.equal(terminalRun.run.status, "succeeded");
  const reports = await fetchReports(baseUrl, runId);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.stage, "voc-positioning");
  const reportRead = await fetch(`${baseUrl}/v1/reports/${reports[0]!.id}`, {
    headers: requestHeaders(),
  });
  assert.equal(reportRead.status, 200);
  assert.equal(((await reportRead.json()) as { report: { id: string } }).report.id, reports[0]!.id);
  await firstService.stop();

  const reopenedService = await createAgentService({
    env: serviceEnv(databaseUrl, "pg-http-reopen-worker", { runtime: false }),
  });
  t.after(async () => {
    await reopenedService.stop();
  });
  await reopenedService.start({ host: "127.0.0.1", port: 0 });
  const reopenedBaseUrl = serviceBaseUrl(reopenedService);
  const reopenedReports = await fetchReports(reopenedBaseUrl, runId);
  assert.deepEqual(
    reopenedReports.map((report) => report.id),
    reports.map((report) => report.id),
  );
  t.diagnostic(
    JSON.stringify({
      submitted: submitted.status,
      runId,
      reportId: reports[0]!.id,
      reportVersion: reports[0]!.version,
      reopenedReportCount: reopenedReports.length,
    }),
  );
});

test("PostgreSQL Agent Service reclaims an interrupted lease and keeps one immutable report", async (t) => {
  const databaseUrl = await isolatedDatabaseUrl();
  const firstService = await createAgentService({
    env: serviceEnv(databaseUrl, "pg-interrupted-worker"),
  });
  t.after(async () => {
    await firstService.stop();
  });
  await firstService.start({ host: "127.0.0.1", port: 0 });
  const firstBaseUrl = serviceBaseUrl(firstService);
  const submitted = await fetch(`${firstBaseUrl}/v1/local-voc`, {
    method: "POST",
    headers: requestHeaders(),
    body: JSON.stringify({
      marketplace: "US",
      asins: [...SCOOTER_ASINS],
    }),
  });
  assert.equal(submitted.status, 200);
  const { runId } = (await submitted.json()) as { runId: string };
  await waitForRun(firstBaseUrl, runId, "succeeded");
  const originalReports = await fetchReports(firstBaseUrl, runId);
  assert.equal(originalReports.length, 1);
  await firstService.stop();
  await simulateReportOnlyInterruptedLease(databaseUrl, runId);

  const recoveryInstant = "2026-08-19T12:02:00.000Z";
  const recoveryService = await createAgentService({
    env: serviceEnv(databaseUrl, "pg-recovery-worker", {
      leaseMs: "1000",
      heartbeatMs: "100",
      pollMs: "10",
      stopMs: "100",
    }),
    clock: () => new Date(recoveryInstant),
    workerClock: fixedWorkerClock(recoveryInstant),
  });
  t.after(async () => {
    await recoveryService.stop();
  });
  await recoveryService.start({ host: "127.0.0.1", port: 0 });
  const recoveryBaseUrl = serviceBaseUrl(recoveryService);
  try {
    await waitForRun(recoveryBaseUrl, runId, "succeeded");
  } catch (error) {
    throw new Error(
      `Recovery poll failed: ${
        error instanceof Error ? error.message : String(error)
      }; ${JSON.stringify(await inspectRun(databaseUrl, runId))}`,
    );
  }
  const reports = await fetchReports(recoveryBaseUrl, runId);
  assert.equal(reports.length, 1);
  assert.equal(reports[0]!.id, originalReports[0]!.id);
  assert.equal(reports[0]!.version, 1);

  const reread = await fetchReports(recoveryBaseUrl, runId);
  assert.deepEqual(reread, reports);
  t.diagnostic(
    JSON.stringify({
      runId,
      reportId: reports[0]!.id,
      reportVersion: reports[0]!.version,
      interruptedLeaseRecoveredBy: "pg-recovery-worker",
    }),
  );
});

test("PostgreSQL runtime facades serialize idempotent run creation and job claims", async () => {
  const databaseUrl = await isolatedDatabaseUrl();
  const first = await openRuntimeAgentRepository({
    kind: "postgres",
    databaseUrl,
  });
  const second = await openRuntimeAgentRepository({
    kind: "postgres",
    databaseUrl,
  });
  try {
    const subject = await seedProject(first);
    const candidate = {
      projectId: subject.projectId,
      mode: "existing-data" as const,
      status: "queued" as const,
      createdBy: subject.actorId,
      dataCutoffAt: now,
      idempotencyScope: "pg-runtime-tracer:idempotent-run",
      idempotencyKey: "same-key",
      createdAt: now,
      updatedAt: now,
    };
    const creationResults = await Promise.allSettled([
      first.createAnalysisRunOnce({
        ...candidate,
        id: randomUUID(),
      }),
      second.createAnalysisRunOnce({
        ...candidate,
        id: randomUUID(),
      }),
    ]);
    if (creationResults.some((result) => result.status === "rejected")) {
      throw new Error(
        `createAnalysisRunOnce race failed: ${JSON.stringify({
          results: creationResults.map((result) =>
            result.status === "fulfilled"
              ? result.value
              : String(result.reason),
          ),
          rawRuns: await rawRows(databaseUrl, "SELECT * FROM analysis_runs"),
        })}`,
      );
    }
    const creations = creationResults.map((result) => {
      assert.equal(result.status, "fulfilled");
      return result.value;
    });
    assert.deepEqual(
      creations.map((creation) => creation.created).sort(),
      [false, true],
    );
    assert.equal(creations[0]!.run.id, creations[1]!.run.id);

    const stageId = randomUUID();
    await first.createRunStage({
      id: stageId,
      runId: creations[0]!.run.id,
      stage: "voc-positioning",
      status: "queued",
      progress: 0,
      attemptCount: 0,
      startedAt: null,
      completedAt: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    });
    await first.enqueueJob({
      id: randomUUID(),
      stageId,
      attemptNumber: 1,
      maxAttempts: 3,
      availableAt: now,
      createdAt: now,
    });

    const claims = await Promise.all([
      first.claimNextJob({
        ownerId: "pg-claim-worker-a",
        claimedAt: now,
        leaseDurationMs: 30_000,
      }),
      second.claimNextJob({
        ownerId: "pg-claim-worker-b",
        claimedAt: now,
        leaseDurationMs: 30_000,
      }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.equal(claims.find(Boolean)?.stageId, stageId);
  } finally {
    await Promise.allSettled([first.close(), second.close()]);
  }
});

async function isolatedDatabaseUrl(): Promise<string> {
  const schema = `test_${randomUUID().replaceAll("-", "")}`;
  await postgres.pool.query(`CREATE SCHEMA ${schema}`);
  return databaseUrl(postgres.pool, schema);
}

function databaseUrl(pool: PgPool, schema: string): string {
  const options = pool.options as {
    host?: string;
    port?: number;
    user?: string;
    database?: string;
  };
  const url = new URL("postgresql://localhost");
  url.hostname = options.host ?? "127.0.0.1";
  url.port = String(options.port);
  url.username = options.user ?? "postgres";
  url.pathname = `/${options.database}`;
  url.searchParams.set("options", `-c search_path=${schema}`);
  return url.toString();
}

async function rawRows(databaseUrl: string, sql: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    return (await pool.query(sql)).rows;
  } finally {
    await pool.end();
  }
}

async function simulateReportOnlyInterruptedLease(
  databaseUrl: string,
  runId: string,
): Promise<void> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const job = await pool.query<{ id: string; stage_id: string }>(
      `SELECT ja.id, ja.stage_id
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE rs.run_id = $1 AND rs.stage = 'voc-positioning'
        ORDER BY ja.attempt_number DESC
        LIMIT 1`,
      [runId],
    );
    const row = job.rows[0];
    assert.ok(row);
    await pool.query("BEGIN");
    try {
      await pool.query(
        `UPDATE job_attempts
            SET status = 'running',
                leased_by = 'pg-interrupted-worker',
                lease_expires_at = '2026-08-19T12:00:00.000Z',
                completed_at = NULL,
                retryable = FALSE,
                retry_scheduled_at = NULL,
                error_json = NULL,
                updated_at = '2026-08-19T12:00:00.000Z'
          WHERE id = $1`,
        [row.id],
      );
      await pool.query(
        `UPDATE run_stages
            SET status = 'running',
                progress = 0,
                completed_at = NULL,
                last_error_json = NULL,
                updated_at = '2026-08-19T12:00:00.000Z'
          WHERE id = $1`,
        [row.stage_id],
      );
      await pool.query(
        `UPDATE analysis_runs
            SET status = 'running',
                updated_at = '2026-08-19T12:00:00.000Z'
          WHERE id = $1`,
        [runId],
      );
      await pool.query("COMMIT");
    } catch (error) {
      await pool.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    await pool.end();
  }
}

function serviceEnv(
  databaseUrl: string,
  ownerId: string,
  options: Readonly<{
    runtime?: boolean;
    leaseMs?: string;
    heartbeatMs?: string;
    pollMs?: string;
    stopMs?: string;
  }> = {},
): Record<string, string> {
  const includeRuntime = options.runtime ?? true;
  return {
    NODE_ENV: "test",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_DATABASE_URL: databaseUrl,
    AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    AGENT_SERVICE_TRUSTED_ORIGINS: fixtureOrigin,
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    AGENT_EXECUTION_ACTOR_ID: actorId,
    AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
    ...(includeRuntime
      ? {
          AGENT_VOC_LOCAL_FAKE: "1",
          AGENT_VOC_MODEL: "local-voc-fake",
          AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
          AGENT_VOC_MAX_OUTPUT_TOKENS: "4000",
          AGENT_VOC_TIMEOUT_MS: "5000",
          AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "0",
          AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "0",
          AGENT_VOC_CALL_MAX_TOKENS: "50000",
          AGENT_VOC_CALL_MAX_COST_MICROS: "50000",
          AGENT_VOC_RUN_MAX_TOKENS: "50000",
          AGENT_VOC_RUN_MAX_COST_MICROS: "50000",
          AGENT_VOC_DAILY_MAX_TOKENS: "50000",
          AGENT_VOC_DAILY_MAX_COST_MICROS: "50000",
          AGENT_VOC_WORKER_OWNER_ID: ownerId,
          AGENT_VOC_WORKER_LEASE_MS: options.leaseMs ?? "30000",
          AGENT_VOC_WORKER_HEARTBEAT_MS: options.heartbeatMs ?? "1000",
          AGENT_VOC_WORKER_POLL_MS: options.pollMs ?? "10",
          AGENT_VOC_WORKER_STOP_TIMEOUT_MS: options.stopMs ?? "1000",
        }
      : {}),
  };
}

function requestHeaders(): HeadersInit {
  return {
    origin: fixtureOrigin,
    "x-agent-proxy-token": proxyToken,
    "content-type": "application/json",
  };
}

function serviceBaseUrl(service: Awaited<ReturnType<typeof createAgentService>>) {
  const address = service.app.server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function waitForRun(
  baseUrl: string,
  runId: string,
  status: string,
): Promise<{ run: { status: string } }> {
  let lastFailure = "";
  return await waitFor(async () => {
    const response = await fetch(`${baseUrl}/v1/runs/${runId}`, {
      headers: requestHeaders(),
    });
    if (response.status !== 200) {
      lastFailure = `GET run failed ${response.status}: ${await response.text()}`;
      return null;
    }
    const body = (await response.json()) as { run: { status: string } };
    return body.run.status === status ? body : null;
  }, () => lastFailure);
}

async function fetchReports(
  baseUrl: string,
  runId: string,
): Promise<Array<{ id: string; stage: string; version: number }>> {
  const response = await fetch(`${baseUrl}/v1/runs/${runId}/reports`, {
    headers: requestHeaders(),
  });
  assert.equal(response.status, 200);
  return ((await response.json()) as {
    reports: Array<{ id: string; stage: string; version: number }>;
  }).reports;
}

function fixedWorkerClock(instant: string): WorkerClock {
  return {
    now: () => instant,
    sleep: (_durationMs, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
          { once: true },
        );
      }),
  };
}

async function seedProject(repository: RuntimeAgentRepository) {
  const actor = {
    id: "83000000-0000-4000-8000-000000000003",
    organizationId: "83000000-0000-4000-8000-000000000004",
  };
  await repository.createUser({
    ...actor,
    email: "pg-runtime-tracer@example.com",
    displayName: "PG runtime tracer",
    role: "admin",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  const projectId = "83000000-0000-4000-8000-000000000005";
  await repository.createProject({
    id: projectId,
    organizationId: actor.organizationId,
    name: "PG runtime tracer",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actor.id,
    createdAt: now,
    updatedAt: now,
  });
  return { actorId: actor.id, organizationId: actor.organizationId, projectId };
}

async function inspectRun(databaseUrl: string, runId: string) {
  const repository = await openRuntimeAgentRepository({
    kind: "postgres",
    databaseUrl,
  });
  try {
    const run = await repository.findAnalysisRun(runId);
    const stages = await repository.listRunStages(runId);
    const reports = await repository.listAnalysisReports({
      actorOrganizationId: organizationId,
      runId,
      stage: "voc-positioning",
    });
    return { run, stages, reports };
  } finally {
    await repository.close();
  }
}

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  describeFailure: () => string = () => "",
): Promise<T> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const detail = describeFailure();
  throw new Error(
    detail
      ? `Timed out waiting for PostgreSQL runtime tracer; ${detail}`
      : "Timed out waiting for PostgreSQL runtime tracer",
  );
}
