import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

import { Pool, type Pool as PgPool } from "pg";

import { SCOOTER_ASINS } from "../agent/helpers/voc-positioning-fixture";
import { startPostgresTestContainer } from "../agent/helpers/postgres-test-container";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const proxyToken = `smoke-${randomBytes(18).toString("hex")}`;
const actorId = "84000000-0000-4000-8000-000000000001";
const organizationId = "84000000-0000-4000-8000-000000000002";
const processOutput: string[] = [];

type Evidence = {
  ok: true;
  postgres: { image: "postgres:16-alpine"; schema: string };
  ports: { web: number; firstAgent: number; secondAgent: number };
  webRestart: { submittedViaWeb: number; rereadViaWeb: number; sameRunId: true };
  agentRestart: {
    recoveredBy: string;
    finalRunStatus: string;
    reportCount: number;
    reportId: string;
    reportVersion: number;
    rereadSameReport: true;
  };
  commands: string[];
};

type StartedProcess = Readonly<{
  child: ChildProcess;
  label: string;
  url: string;
}>;

async function main() {
  assert.ok(
    existsSync(join(root, "dist", "server")),
    "Run npm run build before npm run smoke:stack:postgres",
  );

  const postgres = await startPostgresTestContainer();
  const children: StartedProcess[] = [];
  const schema = `smoke_${randomUUID().replaceAll("-", "")}`;
  let databaseUrl = "";
  let runIdForDiagnostics = "";
  let evidence: Evidence | null = null;

  try {
    await postgres.pool.query(`CREATE SCHEMA ${schema}`);
    databaseUrl = databaseUrlFor(postgres.pool, schema);
    const webPort = await freePort();
    const agentPortA = await freePort();
    const agentPortB = await freePort();
    const webOrigin = `http://127.0.0.1:${webPort}`;

    const agentA = await startAgent({
      port: agentPortA,
      databaseUrl,
      webOrigin,
      ownerId: "smoke-agent-a",
    });
    children.push(agentA);
    const webA = await startWeb({
      port: webPort,
      agentUrl: `http://127.0.0.1:${agentPortA}`,
    });
    children.push(webA);

    const submitted = await fetchJson<{ projectId: string; runId: string }>(
      `${webOrigin}/api/agent/v1/local-voc`,
      {
        method: "POST",
        body: JSON.stringify({ asins: SCOOTER_ASINS, marketplace: "US" }),
      },
    );
    assert.equal(submitted.status, 200);
    const runId = submitted.body.runId;
    runIdForDiagnostics = runId;
    await waitForRunStatus(webOrigin, runId, ["running", "succeeded"]);

    await stopProcess(webA);
    removeChild(children, webA);
    const webB = await startWeb({
      port: webPort,
      agentUrl: `http://127.0.0.1:${agentPortA}`,
    });
    children.push(webB);
    const rereadAfterWebRestart = await fetchJson<{ run: { id: string } }>(
      `${webOrigin}/api/agent/v1/runs/${runId}`,
    );
    assert.equal(rereadAfterWebRestart.status, 200);
    assert.equal(rereadAfterWebRestart.body.run.id, runId);

    await waitForRunStatus(webOrigin, runId, ["succeeded"]);
    const originalReports = await fetchReports(webOrigin, runId);
    assert.equal(originalReports.length, 1);
    await simulateExpiredRunningLease(databaseUrl, runId);

    await stopProcess(agentA);
    removeChild(children, agentA);
    await stopProcess(webB);
    removeChild(children, webB);

    const agentB = await startAgent({
      port: agentPortB,
      databaseUrl,
      webOrigin,
      ownerId: "smoke-agent-b",
      leaseMs: "1000",
      heartbeatMs: "100",
      pollMs: "10",
    });
    children.push(agentB);
    const webC = await startWeb({
      port: webPort,
      agentUrl: `http://127.0.0.1:${agentPortB}`,
    });
    children.push(webC);

    const finalRun = await waitForRunStatus(webOrigin, runId, ["succeeded"]);
    const reports = await fetchReports(webOrigin, runId);
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.id, originalReports[0]!.id);
    assert.equal(reports[0]!.version, originalReports[0]!.version);
    const reread = await fetchReports(webOrigin, runId);
    assert.deepEqual(reread, reports);

    evidence = {
      ok: true,
      postgres: { image: "postgres:16-alpine", schema },
      ports: { web: webPort, firstAgent: agentPortA, secondAgent: agentPortB },
      webRestart: {
        submittedViaWeb: submitted.status,
        rereadViaWeb: rereadAfterWebRestart.status,
        sameRunId: true,
      },
      agentRestart: {
        recoveredBy: "smoke-agent-b",
        finalRunStatus: finalRun.run.status,
        reportCount: reports.length,
        reportId: reports[0]!.id,
        reportVersion: reports[0]!.version,
        rereadSameReport: true,
      },
      commands: [
        "npm run build",
        "npm run smoke:stack:postgres",
        "node node_modules/tsx/dist/cli.mjs server/index.ts",
        "node scripts/team-prod-server.mjs",
      ],
    };
  } catch (error) {
    if (databaseUrl && runIdForDiagnostics) {
      const state = await inspectSmokeState(databaseUrl, runIdForDiagnostics).catch(
        (stateError: unknown) => ({
          inspectError: stateError instanceof Error ? stateError.message : "unknown",
        }),
      );
      throw new Error(
        `${error instanceof Error ? error.message : "Smoke failed"}; state=${sanitize(JSON.stringify(state))}`,
      );
    }
    throw error;
  } finally {
    await Promise.allSettled([...children].reverse().map((entry) => stopProcess(entry)));
    await postgres.close();
  }

  console.log(JSON.stringify(evidence, null, 2));
}

async function startAgent({
  port,
  databaseUrl,
  webOrigin,
  ownerId,
  leaseMs = "30000",
  heartbeatMs = "1000",
  pollMs = "100",
}: {
  port: number;
  databaseUrl: string;
  webOrigin: string;
  ownerId: string;
  leaseMs?: string;
  heartbeatMs?: string;
  pollMs?: string;
}): Promise<StartedProcess> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [tsxCli, join(root, "server", "index.ts")], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      AGENT_SERVICE_HOST: "127.0.0.1",
      AGENT_SERVICE_PORT: String(port),
      AGENT_DATABASE_URL: databaseUrl,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: webOrigin,
      AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
      AGENT_EXECUTION_ACTOR_ID: actorId,
      AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
      AGENT_VOC_LOCAL_FAKE: "1",
      OPENAI_API_KEY: "local-fake",
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
      AGENT_VOC_WORKER_LEASE_MS: leaseMs,
      AGENT_VOC_WORKER_HEARTBEAT_MS: heartbeatMs,
      AGENT_VOC_WORKER_POLL_MS: pollMs,
      AGENT_VOC_WORKER_STOP_TIMEOUT_MS: "1000",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  trackOutput(child);
  await waitForHealth(`${url}/health`, child, "Agent Service");
  return { child, label: ownerId, url };
}

async function startWeb({
  port,
  agentUrl,
}: {
  port: number;
  agentUrl: string;
}): Promise<StartedProcess> {
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(root, "scripts", "team-prod-server.mjs")], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(port),
      AGENT_SERVICE_INTERNAL_URL: agentUrl,
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  trackOutput(child);
  await waitForHealth(`${url}/api/health`, child, "Web");
  return { child, label: `web:${port}`, url };
}

async function waitForHealth(url: string, child: ChildProcess, label: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited before health check passed`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Process is still starting.
    }
    await delay(250);
  }
  throw new Error(`${label} health check timed out`);
}

async function waitForRunStatus(
  webOrigin: string,
  runId: string,
  expected: readonly string[],
): Promise<{ run: { status: string } }> {
  let lastStatus = "unseen";
  return await waitFor(async () => {
    const response = await fetchJson<{ run: { status: string } }>(
      `${webOrigin}/api/agent/v1/runs/${runId}`,
    );
    assert.equal(response.status, 200);
    lastStatus = response.body.run.status;
    return expected.includes(response.body.run.status) ? response.body : null;
  }, () => `run status ${lastStatus}; expected ${expected.join(",")}`);
}

async function fetchReports(
  webOrigin: string,
  runId: string,
): Promise<Array<{ id: string; version: number }>> {
  const response = await fetchJson<{ reports: Array<{ id: string; version: number }> }>(
    `${webOrigin}/api/agent/v1/runs/${runId}/reports`,
  );
  assert.equal(response.status, 200);
  return response.body.reports;
}

async function fetchJson<T>(
  url: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return { status: response.status, body: await response.json() as T };
}

async function simulateExpiredRunningLease(databaseUrl: string, runId: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const expiredAt = "2000-01-01T00:00:00.000Z";
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
    assert.ok(row, "expected a VOC job to expire");
    await pool.query("BEGIN");
    await pool.query(
      `UPDATE job_attempts
              SET status = 'running',
                  leased_by = 'smoke-agent-a',
              lease_expires_at = $2,
              completed_at = NULL,
              retryable = FALSE,
              retry_scheduled_at = NULL,
              error_json = NULL,
              updated_at = $2
        WHERE id = $1`,
      [row.id, expiredAt],
    );
    await pool.query(
      `UPDATE run_stages
          SET status = 'running',
              progress = 0,
              completed_at = NULL,
              last_error_json = NULL,
              updated_at = $2
        WHERE id = $1`,
      [row.stage_id, expiredAt],
    );
    await pool.query(
      `UPDATE analysis_runs
          SET status = 'running',
              updated_at = $2
        WHERE id = $1`,
      [runId, expiredAt],
    );
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await pool.end();
  }
}

async function inspectSmokeState(databaseUrl: string, runId: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const run = await pool.query(
      "SELECT id, status, updated_at FROM analysis_runs WHERE id = $1",
      [runId],
    );
    const stages = await pool.query(
      "SELECT id, stage, status, progress, attempt_count, updated_at FROM run_stages WHERE run_id = $1 ORDER BY stage",
      [runId],
    );
    const jobs = await pool.query(
      `SELECT ja.id, ja.status, ja.leased_by, ja.lease_expires_at, ja.attempt_number, ja.error_json
         FROM job_attempts ja
         JOIN run_stages rs ON rs.id = ja.stage_id
        WHERE rs.run_id = $1
        ORDER BY ja.attempt_number`,
      [runId],
    );
    const reports = await pool.query(
      "SELECT id, version, stage, status FROM analysis_reports WHERE run_id = $1 ORDER BY version",
      [runId],
    );
    return {
      run: run.rows,
      stages: stages.rows,
      jobs: jobs.rows,
      reports: reports.rows,
    };
  } finally {
    await pool.end();
  }
}

function databaseUrlFor(pool: PgPool, schema: string): string {
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

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function trackOutput(child: ChildProcess) {
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk: Buffer) => {
      processOutput.push(sanitize(String(chunk)).slice(0, 2_000));
      if (processOutput.length > 40) processOutput.shift();
    });
  }
}

function removeChild(children: StartedProcess[], target: StartedProcess) {
  const index = children.indexOf(target);
  if (index >= 0) children.splice(index, 1);
}

async function stopProcess(processInfo: StartedProcess) {
  const child = processInfo.child;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolve) => child.once("exit", () => resolve())),
    delay(5_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }),
  ]);
}

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  describe: () => string,
): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${describe()}`);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? sanitize(error.message) : "Unknown smoke failure",
      diagnostics: processOutput.slice(-10),
    }),
  );
  process.exitCode = 1;
});

function sanitize(value: string) {
  return value.replaceAll(proxyToken, "[redacted]");
}
