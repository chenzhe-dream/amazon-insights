import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Pool as PgPool } from "pg";

import { hashPassword } from "../../server/auth/password";
import { openPostgresAgentRepository } from "../../server/db/postgres-repository";
import { startPostgresTestContainer } from "../agent/helpers/postgres-test-container";
import { STANDARD_FAKE_LIMITS } from "../fixtures/concurrency/fake-provider";

const root = new URL("../..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const fakeAgentEntry = join(root, "tests", "fixtures", "concurrency", "fake-provider.ts");
const proxyToken = `fake-smoke-${randomBytes(18).toString("hex")}`;
const organizationId = "85000000-0000-4000-8000-000000000001";
const password = `fake-${randomBytes(18).toString("base64url")}`;
const processOutput: string[] = [];
const terminalStatuses = new Set(["completed", "failed"]);
const governedResources = ["sellerSprite", "sif", "sorftime", "model", "image"] as const;

type StartedProcess = Readonly<{
  child: ChildProcess;
  port: number;
  origin: string;
  agentId: string;
}>;

type UserLogin = Readonly<{
  userId: string;
  email: string;
  cookie: string;
}>;

type SubmittedJob = Readonly<{
  userId: string;
  email: string;
  cookie: string;
  jobId: string;
  status: number;
  acceptedMs: number;
  asins: readonly string[];
}>;

type FakeEvent = Readonly<{
  at: string;
  type: string;
  agentId: string;
  jobId?: string;
  resource?: keyof typeof STANDARD_FAKE_LIMITS;
  active?: number;
}>;

type DbSample = Readonly<{
  at: string;
  running: number;
  queued: number;
  completed: number;
  failed: number;
  activePermits: number;
  connections: number;
  resourcePermits: ResourceCounts;
}>;

type ResourceName = (typeof governedResources)[number];

type ResourceCounts = Record<ResourceName, number>;

async function main() {
  const postgres = await startPostgresTestContainer();
  const tempDir = await mkdtemp(join(tmpdir(), "twenty-user-concurrency-"));
  const children: StartedProcess[] = [];
  const samples: DbSample[] = [];
  let samplerStopped = false;
  const schema = `capacity_${randomUUID().replaceAll("-", "")}`;
  let databaseUrl = "";

  try {
    await postgres.pool.query(`CREATE SCHEMA ${schema}`);
    databaseUrl = databaseUrlFor(postgres.pool, schema);
    const schemaPool = postgres.createPool({ searchPath: schema });
    await seedUsers(databaseUrl);
    const statsPath = join(tempDir, "fake-events.jsonl");
    const mirrorDir = join(tempDir, "mirrors");
    const sampler = sampleDatabase(schemaPool, samples, () => samplerStopped);

    const firstAgent = await startFakeAgent({
      databaseUrl,
      statsPath,
      mirrorDir,
      agentId: "fake-agent-a",
    });
    children.push(firstAgent);

    const users = await loginUsers(firstAgent);
    const startedAt = Date.now();
    const submissions = await submitTwentyJobs(firstAgent, users);
    assert.equal(submissions.length, 20);
    assert.equal(submissions.filter((item) => item.status >= 500).length, 0);
    assert.equal(submissions.filter((item) => item.status === 202).length, 20);
    assert.ok(p95(submissions.map((item) => item.acceptedMs)) <= 2_000);

    await waitFor(
      async () => {
        const counts = await syncJobCounts(schemaPool);
        return counts.running >= 4 && counts.completed < 20 ? counts : null;
      },
      "four running jobs before restart",
      10_000,
      25,
    );
    await stopProcess(firstAgent);
    removeChild(children, firstAgent);
    await delay(1_250);

    const secondAgent = await startFakeAgent({
      databaseUrl,
      statsPath,
      mirrorDir,
      agentId: "fake-agent-b",
    });
    children.push(secondAgent);

    await waitForTerminal(schemaPool, submissions);
    await Promise.all(
      submissions.map((job) => fetchJob(secondAgent, job.cookie, job.jobId)),
    );
    await assertDatabaseInvariants(schemaPool, submissions);

    samplerStopped = true;
    await sampler;
    const events = await readEvents(statsPath);
    const eventMaxima = maxResourceConcurrency(events);
    const eventAttemptCounts = eventResourceStartCounts(events);
    const sampledPermitMaxima = maxSampledResourcePermits(samples);
    const dbEvidence = await readDbResourceEvidence(schemaPool);
    const maxWholeJobs = Math.max(...samples.map((sample) => sample.running), 0);
    const maxConnections = Math.max(...samples.map((sample) => sample.connections), 0);
    const maxActivePermits = Math.max(...samples.map((sample) => sample.activePermits), 0);
    const maxSellerSpriteRolling = maxRollingAttempts(dbEvidence.sellerSpriteAttemptTimes);
    const expectedLimits = expectedResourceLimits();
    assert.equal(
      maxWholeJobs <= STANDARD_FAKE_LIMITS.wholeJob,
      true,
      `whole job concurrency exceeded: ${maxWholeJobs}`,
    );
    for (const resource of governedResources) {
      assert.equal(
        sampledPermitMaxima[resource] <= expectedLimits[resource],
        true,
        `${resource} DB active permit concurrency exceeded expected ${expectedLimits[resource]}: ${sampledPermitMaxima[resource]}`,
      );
      assert.equal(
        eventMaxima[resource] <= STANDARD_FAKE_LIMITS[resource],
        true,
        `${resource} fake physical concurrency exceeded production cap: ${eventMaxima[resource]}`,
      );
      assert.equal(
        dbEvidence.attemptCounts[resource],
        eventAttemptCounts[resource],
        `${resource} DB physical attempts ${dbEvidence.attemptCounts[resource]} did not match fake starts ${eventAttemptCounts[resource]}`,
      );
    }
    if (process.env.FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION !== "1") {
      assert.equal(sampledPermitMaxima.model, 2, "model cap was not exercised to 2");
      assert.equal(sampledPermitMaxima.image, 2, "image cap was not exercised to 2");
    }
    assert.equal(
      maxSellerSpriteRolling <= 30,
      true,
      `SellerSprite rolling attempts exceeded: ${maxSellerSpriteRolling}`,
    );
    assert.equal(maxConnections <= 10, true, `PG connections exceeded: ${maxConnections}`);
    assert.equal(maxActivePermits <= 6, true, `active permits exceeded: ${maxActivePermits}`);
    await assertNoActivePermits(schemaPool);

    for (const child of [...children].reverse()) {
      await stopProcess(child);
      removeChild(children, child);
      await assertPortClosed(child.origin);
    }

    const completedAt = Date.now();
    console.log(JSON.stringify({
      ok: true,
      deliberateCapViolationMode:
        process.env.FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION === "1",
      postgres: { image: "postgres:16-alpine", schema },
      submissions: {
        accepted: submissions.length,
        p95AcceptedMs: p95(submissions.map((item) => item.acceptedMs)),
        distinctJobIds: new Set(submissions.map((item) => item.jobId)).size,
      },
      restart: {
        killedAgent: "fake-agent-a",
        restartedAgent: "fake-agent-b",
      },
      http: {
        postSubmissions: 20,
        refreshPolls: submissions.length,
        refreshMethod: "GET",
      },
      maxima: {
        wholeJob: maxWholeJobs,
        sellerSprite: eventMaxima.sellerSprite,
        sif: eventMaxima.sif,
        sorftime: eventMaxima.sorftime,
        model: eventMaxima.model,
        image: eventMaxima.image,
        dbSellerSprite: sampledPermitMaxima.sellerSprite,
        dbSif: sampledPermitMaxima.sif,
        dbSorftime: sampledPermitMaxima.sorftime,
        dbModel: sampledPermitMaxima.model,
        dbImage: sampledPermitMaxima.image,
        sellerSpriteRolling60s: maxSellerSpriteRolling,
        postgresConnections: maxConnections,
        activePermits: maxActivePermits,
      },
      dbPhysicalAttempts: dbEvidence.attemptCounts,
      terminal: await syncJobCounts(schemaPool),
      durationMs: completedAt - startedAt,
      safeJobIds: submissions.map((item) => item.jobId),
    }, null, 2));
  } catch (error) {
    samplerStopped = true;
    throw new Error(
      `${error instanceof Error ? error.message : "twenty-user smoke failed"}; diagnostics=${JSON.stringify(processOutput.slice(-12))}`,
    );
  } finally {
    samplerStopped = true;
    await Promise.allSettled([...children].reverse().map((entry) => stopProcess(entry)));
    await postgres.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function seedUsers(databaseUrl: string) {
  const repository = await openPostgresAgentRepository({ connectionString: databaseUrl });
  try {
    const now = new Date().toISOString();
    for (let index = 0; index < 20; index += 1) {
      const email = userEmail(index);
      await repository.createLocalUser!({
        id: userId(index),
        organizationId,
        email,
        displayName: `Concurrency User ${index + 1}`,
        role: "member",
        status: "active",
        createdAt: now,
        updatedAt: now,
        passwordHash: await hashPassword(password),
      });
    }
  } finally {
    await repository.close();
  }
}

async function startFakeAgent(input: {
  databaseUrl: string;
  statsPath: string;
  mirrorDir: string;
  agentId: string;
}): Promise<StartedProcess> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const agentDatabaseUrl = new URL(input.databaseUrl);
  agentDatabaseUrl.searchParams.set("application_name", input.agentId);
  const child = spawn(process.execPath, [tsxCli, fakeAgentEntry], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "test",
      FAKE_AGENT_PORT: String(port),
      FAKE_AGENT_ID: input.agentId,
      FAKE_TRUSTED_ORIGIN: origin,
      FAKE_PROVIDER_STATS_PATH: input.statsPath,
      FAKE_PROVIDER_MIRROR_DIR: input.mirrorDir,
      AGENT_DATABASE_URL: agentDatabaseUrl.toString(),
      AGENT_SERVICE_PROXY_TOKEN: proxyToken,
      AGENT_SERVICE_TRUSTED_ORIGINS: origin,
      AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  trackOutput(child);
  await waitForHealth(`${origin}/health`, child);
  return { child, port, origin, agentId: input.agentId };
}

async function loginUsers(agent: StartedProcess): Promise<UserLogin[]> {
  const logins: UserLogin[] = [];
  for (let index = 0; index < 20; index += 1) {
    const email = userEmail(index);
    const response = await fetch(`${agent.origin}/v1/auth/login`, {
      method: "POST",
      headers: {
        ...proxyHeaders(agent),
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(response.status, 200);
    const cookie = String(response.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.match(cookie, /^agent_session=/);
    logins.push({ userId: userId(index), email, cookie });
  }
  return logins;
}

async function submitTwentyJobs(
  agent: StartedProcess,
  users: readonly UserLogin[],
): Promise<SubmittedJob[]> {
  return await Promise.all(
    users.map(async (user, index) => {
      const asins = jobAsins(index);
      const started = Date.now();
      const response = await fetch(`${agent.origin}/v1/local-data/sync-asins`, {
        method: "POST",
        headers: {
          ...proxyHeaders(agent),
          cookie: user.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ marketplace: "US", asins }),
      });
      const acceptedMs = Date.now() - started;
      const body = await response.json() as { jobId?: string };
      assert.equal(
        typeof body.jobId,
        "string",
        `submission ${index + 1} returned ${response.status}: ${JSON.stringify(body)}`,
      );
      return {
        ...user,
        asins,
        jobId: body.jobId!,
        status: response.status,
        acceptedMs,
      };
    }),
  );
}

async function fetchJob(
  agent: StartedProcess,
  cookie: string,
  jobId: string,
): Promise<unknown> {
  const response = await fetch(`${agent.origin}/v1/local-data/sync-asins/${jobId}`, {
    method: "GET",
    headers: {
      ...proxyHeaders(agent),
      cookie,
    },
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { jobId?: string };
  assert.equal(body.jobId, jobId);
  return body;
}

async function waitForTerminal(pool: PgPool, submissions: readonly SubmittedJob[]) {
  await waitFor(
    async () => {
      const counts = await syncJobCounts(pool);
      return counts.completed + counts.failed === submissions.length ? counts : null;
    },
    "all fake sync jobs terminal",
    30_000,
    100,
  );
}

async function assertDatabaseInvariants(
  pool: PgPool,
  submissions: readonly SubmittedJob[],
) {
  const ids = submissions.map((item) => item.jobId);
  assert.equal(new Set(ids).size, 20);
  const rows = await pool.query<{
    job_id: string;
    actor_id: string;
    fingerprint: string;
    status: string;
    asins: string[];
  }>(
    `SELECT job_id, actor_id, fingerprint, status, asins
     FROM sync_jobs
     WHERE job_id = ANY($1)
     ORDER BY job_id`,
    [ids],
  );
  assert.equal(rows.rowCount, 20);
  assert.equal(new Set(rows.rows.map((row) => row.fingerprint)).size, 20);
  assert.equal(rows.rows.every((row) => terminalStatuses.has(row.status)), true);
  for (const submission of submissions) {
    const row = rows.rows.find((candidate) => candidate.job_id === submission.jobId);
    assert.ok(row);
    assert.equal(row.actor_id, submission.userId);
    assert.deepEqual([...row.asins].sort(), [...submission.asins].sort());
  }
  const submissionRows = await pool.query<{ count: number }>(
    "SELECT count(*)::integer AS count FROM sync_job_submissions",
  );
  assert.equal(submissionRows.rows[0]?.count, 20);
}

async function assertNoActivePermits(pool: PgPool) {
  const permits = await pool.query<{ count: number }>(
    `SELECT count(*)::integer AS count
     FROM concurrency_resource_permits
     WHERE released_at IS NULL
       AND lease_expires_at > now()`,
  );
  assert.equal(permits.rows[0]?.count, 0);
}

async function sampleDatabase(
  pool: PgPool,
  samples: DbSample[],
  stopped: () => boolean,
) {
  while (!stopped()) {
    try {
      const counts = await syncJobCounts(pool);
      const activePermits = await pool.query<{ count: number }>(
        `SELECT count(*)::integer AS count
         FROM concurrency_resource_permits
         WHERE released_at IS NULL
           AND lease_expires_at > now()`,
      );
      const resourcePermits = await pool.query<{
        resource: ResourceName;
        count: number;
      }>(
        `SELECT resource, count(*)::integer AS count
         FROM concurrency_resource_permits
         WHERE resource = ANY($1)
           AND released_at IS NULL
           AND lease_expires_at > now()
         GROUP BY resource`,
        [[...governedResources]],
      );
      const connections = await pool.query<{ count: number }>(
        "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE datname = current_database() AND application_name LIKE 'fake-agent-%'",
      );
      samples.push({
        at: new Date().toISOString(),
        ...counts,
        activePermits: activePermits.rows[0]?.count ?? 0,
        connections: connections.rows[0]?.count ?? 0,
        resourcePermits: {
          ...emptyResourceCounts(),
          ...Object.fromEntries(resourcePermits.rows.map((row) => [row.resource, row.count])),
        } as ResourceCounts,
      });
    } catch {
      // The sampler is diagnostic only; final invariants query directly.
    }
    await delay(10);
  }
}

async function syncJobCounts(pool: PgPool) {
  const result = await pool.query<{
    queued: number;
    running: number;
    completed: number;
    failed: number;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'queued')::integer AS queued,
       count(*) FILTER (WHERE status = 'running')::integer AS running,
       count(*) FILTER (WHERE status = 'completed')::integer AS completed,
       count(*) FILTER (WHERE status = 'failed')::integer AS failed
     FROM sync_jobs`,
  );
  return {
    queued: result.rows[0]?.queued ?? 0,
    running: result.rows[0]?.running ?? 0,
    completed: result.rows[0]?.completed ?? 0,
    failed: result.rows[0]?.failed ?? 0,
  };
}

async function readEvents(path: string): Promise<FakeEvent[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FakeEvent);
}

async function readDbResourceEvidence(pool: PgPool) {
  const attempts = await pool.query<{
    resource: ResourceName;
    count: number;
  }>(
    `SELECT resource, count(*)::integer AS count
     FROM concurrency_physical_attempts
     WHERE resource = ANY($1)
     GROUP BY resource`,
    [[...governedResources]],
  );
  const sellerSpriteAttempts = await pool.query<{ recorded_at: Date }>(
    `SELECT recorded_at
     FROM concurrency_physical_attempts
     WHERE resource = 'sellerSprite'
     ORDER BY recorded_at ASC`,
  );
  return {
    attemptCounts: {
      ...emptyResourceCounts(),
      ...Object.fromEntries(attempts.rows.map((row) => [row.resource, row.count])),
    } as ResourceCounts,
    sellerSpriteAttemptTimes: sellerSpriteAttempts.rows.map((row) =>
      row.recorded_at.getTime(),
    ),
  };
}

function maxSampledResourcePermits(samples: readonly DbSample[]): ResourceCounts {
  const maxima = emptyResourceCounts();
  for (const sample of samples) {
    for (const resource of governedResources) {
      maxima[resource] = Math.max(maxima[resource], sample.resourcePermits[resource]);
    }
  }
  return maxima;
}

function maxResourceConcurrency(events: readonly FakeEvent[]): ResourceCounts {
  const maxima = emptyResourceCounts();
  for (const event of events) {
    if (
      event.type === "resource-start" &&
      isGovernedResource(event.resource) &&
      typeof event.active === "number"
    ) {
      maxima[event.resource] = Math.max(maxima[event.resource], event.active);
    }
  }
  return maxima;
}

function eventResourceStartCounts(events: readonly FakeEvent[]): ResourceCounts {
  const counts = emptyResourceCounts();
  for (const event of events) {
    if (event.type === "resource-start" && isGovernedResource(event.resource)) {
      counts[event.resource] += 1;
    }
  }
  return counts;
}

function emptyResourceCounts(): ResourceCounts {
  return {
    sellerSprite: 0,
    sif: 0,
    sorftime: 0,
    model: 0,
    image: 0,
  };
}

function isGovernedResource(value: unknown): value is ResourceName {
  return governedResources.includes(value as ResourceName);
}

function expectedResourceLimits(): ResourceCounts {
  return {
    sellerSprite:
      process.env.FAKE_PROVIDER_DELIBERATE_CAP_VIOLATION === "1"
        ? 1
        : STANDARD_FAKE_LIMITS.sellerSprite,
    sif: STANDARD_FAKE_LIMITS.sif,
    sorftime: STANDARD_FAKE_LIMITS.sorftime,
    model: STANDARD_FAKE_LIMITS.model,
    image: STANDARD_FAKE_LIMITS.image,
  };
}

function maxRollingAttempts(times: readonly number[]): number {
  const sorted = [...times].sort((left, right) => left - right);
  let max = 0;
  for (let left = 0, right = 0; right < sorted.length; right += 1) {
    while (sorted[right]! - sorted[left]! > 60_000) left += 1;
    max = Math.max(max, right - left + 1);
  }
  return max;
}

async function waitForHealth(url: string, child: ChildProcess) {
  await waitFor(
    async () => {
      if (child.exitCode !== null) {
        throw new Error("Fake agent exited before health check passed");
      }
      try {
        const response = await fetch(url);
        return response.ok ? true : null;
      } catch {
        return null;
      }
    },
    "fake agent health",
    30_000,
    100,
  );
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

async function assertPortClosed(origin: string) {
  await waitFor(
    async () => {
      try {
        await fetch(`${origin}/health`);
        return null;
      } catch {
        return true;
      }
    },
    `closed listener ${origin}`,
    5_000,
    100,
  );
}

function proxyHeaders(agent: StartedProcess) {
  return {
    origin: agent.origin,
    "x-agent-proxy-token": proxyToken,
    "x-agent-client-ip": "127.0.0.1",
  };
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

async function waitFor<T>(
  predicate: () => Promise<T | null>,
  description: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for ${description}`);
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

function p95(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? 0;
}

function userId(index: number): string {
  return `85000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`;
}

function userEmail(index: number): string {
  return `concurrency-${String(index + 1).padStart(2, "0")}@example.test`;
}

function jobAsins(index: number): readonly string[] {
  return [0, 1, 2].map(
    (slot) => `B0T${String(index + 1).padStart(2, "0")}${String(slot + 1).padStart(5, "0")}`,
  );
}

function sanitize(value: string) {
  return value
    .replaceAll(proxyToken, "[redacted]")
    .replaceAll(password, "[redacted]")
    .replace(/\b((?:postgres(?:ql)?|https?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@");
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: error instanceof Error ? sanitize(error.message) : "Unknown smoke failure",
    }),
  );
  process.exitCode = 1;
});
