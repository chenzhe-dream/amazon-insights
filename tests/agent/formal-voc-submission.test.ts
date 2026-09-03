import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { LocalVocSubmissionResponseSchema } from "../../shared/agent-contracts";
import { buildAgentApp } from "../../server/app";
import type { RuntimeAgentRepository } from "../../server/db/repository";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { SCOOTER_ASINS } from "./helpers/voc-positioning-fixture";

const origin = "http://127.0.0.1:31900";
const token = "formal-voc-browser-token";

function env(fake?: boolean) {
  return {
    AGENT_SERVICE_PROXY_TOKEN: token,
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SERVICE_TRUSTED_ORIGINS: origin,
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    AGENT_VOC_LOCAL_ORIGIN: origin,
    AGENT_VOC_LOCAL_FAKE: fake ? "1" : undefined,
    OPENAI_API_KEY: fake ? undefined : "configured-test-key",
  };
}

function headers() {
  return {
    origin,
    "x-agent-proxy-token": token,
    "content-type": "application/json",
  };
}

function failAfterSnapshotWrite(repository: RuntimeAgentRepository): RuntimeAgentRepository {
  let injected = false;
  const wrap = (target: RuntimeAgentRepository): RuntimeAgentRepository => new Proxy(target, {
    get(subject, property, receiver) {
      if (property === "transaction") {
        return <T>(operation: (transactionRepository: RuntimeAgentRepository) => Promise<T>) =>
          subject.transaction((transactionRepository) =>
            operation(wrap(transactionRepository as RuntimeAgentRepository)));
      }
      const value = Reflect.get(subject, property, receiver);
      if (property === "createDataSnapshotForRun" && typeof value === "function") {
        return async (...args: unknown[]) => {
          const result = await value.apply(subject, args);
          if (!injected) {
            injected = true;
            throw new Error("secret snapshot persistence detail");
          }
          return result;
        };
      }
      return typeof value === "function" ? value.bind(subject) : value;
    },
  }) as RuntimeAgentRepository;
  return wrap(repository);
}

for (const mode of ["fixture", "configured"] as const) {
  test(`${mode} runtime uses the same durable VOC submission route`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "formal-voc-submit-"));
    const repository = openSqliteAgentRepository({ path: join(dir, "agent.sqlite"), busyTimeoutMs: 5_000 });
    const executionContext = { actorId: randomUUID(), organizationId: randomUUID() };
    const app = buildAgentApp({
      env: env(mode === "fixture"),
      repository,
      executionContext,
      storageAvailable: true,
      openaiCapability: { configured: true, available: true, reason: null },
    });
    t.after(async () => {
      await app.close();
      repository.close();
      rmSync(dir, { recursive: true, force: true });
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/local-voc",
      headers: headers(),
      payload: { asins: SCOOTER_ASINS, marketplace: "US" },
    });
    assert.equal(response.statusCode, 200);
    const payload = LocalVocSubmissionResponseSchema.parse(response.json());
    assert.ok(await repository.findProjectById(payload.projectId));
    const run = await repository.findAnalysisRun(payload.runId);
    assert.equal(run?.projectId, payload.projectId);
    const snapshots = await repository.listDataSnapshotsByRun({
      actorOrganizationId: executionContext.organizationId,
      runId: payload.runId,
    });
    assert.equal(snapshots.length, 1);
    const restored = await app.inject({
      method: "GET",
      url: `/v1/runs/${payload.runId}`,
      headers: headers(),
    });
    assert.equal(restored.statusCode, 200);
    const stage = restored.json().stages.find((item: { stage: string }) => item.stage === "voc-positioning");
    assert.equal((await repository.listJobAttempts(stage.id)).length, 1);
  });
}

test("unavailable VOC runtime rejects submission before mutation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "formal-voc-unavailable-"));
  const repository = openSqliteAgentRepository({ path: join(dir, "agent.sqlite"), busyTimeoutMs: 5_000 });
  const executionContext = { actorId: randomUUID(), organizationId: randomUUID() };
  const app = buildAgentApp({
    env: env(false),
    repository,
    executionContext,
    storageAvailable: true,
    openaiCapability: { configured: true, available: false, reason: "OpenAI runtime is not active" },
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-voc",
    headers: headers(),
    payload: { asins: SCOOTER_ASINS, marketplace: "US" },
  });
  assert.equal(response.statusCode, 503);
  assert.equal(response.json().error.code, "CONFIGURATION_ERROR");
  assert.equal(await repository.findUserById(executionContext.actorId), null);
});

test("snapshot failure rolls back the complete durable VOC submission", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "formal-voc-rollback-"));
  const databasePath = join(dir, "agent.sqlite");
  const repository = openSqliteAgentRepository({ path: databasePath, busyTimeoutMs: 5_000 });
  const executionContext = { actorId: randomUUID(), organizationId: randomUUID() };
  const app = buildAgentApp({
    env: env(true),
    repository: failAfterSnapshotWrite(repository),
    executionContext,
    storageAvailable: true,
    openaiCapability: { configured: true, available: true, reason: null },
  });
  t.after(async () => {
    await app.close();
    repository.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: "POST",
    url: "/v1/local-voc",
    headers: headers(),
    payload: { asins: SCOOTER_ASINS, marketplace: "US" },
  });
  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /secret snapshot persistence detail/);

  const database = new DatabaseSync(databasePath, { readOnly: true });
  const counts = database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users) AS users,
      (SELECT COUNT(*) FROM projects) AS projects,
      (SELECT COUNT(*) FROM analysis_runs) AS runs,
      (SELECT COUNT(*) FROM run_stages) AS stages,
      (SELECT COUNT(*) FROM data_snapshots) AS snapshots,
      (SELECT COUNT(*) FROM job_attempts) AS jobs
  `).get();
  database.close();
  assert.deepEqual({ ...counts }, {
    users: 0,
    projects: 0,
    runs: 0,
    stages: 0,
    snapshots: 0,
    jobs: 0,
  });
});
