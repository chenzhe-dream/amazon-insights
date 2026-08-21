import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentService } from "../../server/agent-service";
import { openSqliteAgentRepository } from "../../server/db/sqlite-repository";
import { LocalVocFakeProvider } from "../../server/runtime/local-voc-fake-provider";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import {
  SCOOTER_ASINS,
  realVocSnapshot,
} from "./helpers/voc-positioning-fixture";

const ORIGIN = "http://127.0.0.1:31900";
const PROXY_TOKEN = "voc-resume-proxy-token";
const CUTOFF = "2026-08-15T23:59:59.999Z";

test("missing VOC waits and a validated file import resumes the same durable job", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-waiting-resume-"));
  const databasePath = join(directory, "agent.sqlite");
  const repository = openSqliteAgentRepository({
    path: databasePath,
    busyTimeoutMs: 5_000,
  });
  const organizationId = randomUUID();
  const actorId = randomUUID();
  const projectId = randomUUID();
  const runId = randomUUID();
  const stageId = randomUUID();
  const jobId = randomUUID();
  const now = "2026-08-16T00:00:00.000Z";

  await repository.createUser({
    id: actorId,
    organizationId,
    email: `voc-resume-${actorId}@example.com`,
    displayName: "VOC resume actor",
    role: "member",
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createProject({
    id: projectId,
    organizationId,
    name: "VOC waiting-input integration",
    marketplace: "US",
    asins: [...SCOOTER_ASINS],
    createdBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  await repository.createAnalysisRun({
    id: runId,
    projectId,
    mode: "collect-missing",
    status: "queued",
    createdBy: actorId,
    dataCutoffAt: CUTOFF,
    idempotencyScope: `voc-resume:${runId}`,
    idempotencyKey: "initial",
    createdAt: now,
    updatedAt: now,
  });
  await repository.createRunStage({
    id: stageId,
    runId,
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
  await repository.enqueueJob({
    id: jobId,
    stageId,
    attemptNumber: 1,
    maxAttempts: 3,
    availableAt: now,
    createdAt: now,
  });

  const service = await createAgentService({
    repository,
    provider: new LocalVocFakeProvider(),
    providerName: "voc-resume-fixture",
    env: runtimeEnv(databasePath, actorId, organizationId),
  });
  t.after(async () => {
    await service.stop();
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });

  await service.start({ host: "127.0.0.1", port: 0 });
  await waitFor(async () =>
    (await repository.findRunStage(stageId))?.status === "waiting-input",
  );

  const waitingRun = await repository.findAnalysisRun(runId);
  const waitingAttempts = await repository.listJobAttempts(stageId);
  assert.equal(waitingRun?.status, "waiting-input");
  assert.equal(waitingAttempts.length, 1);
  assert.equal(waitingAttempts[0]?.id, jobId);
  assert.equal(waitingAttempts[0]?.status, "failed");
  assert.match(
    String((await repository.findRunStage(stageId))?.lastError?.message ?? ""),
    /VOC input is required/i,
  );

  const rejected = await service.app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/voc-import`,
    headers: proxyHeaders(),
    payload: {
      importMode: "file-import",
      candidate: { secret: "raw-import-secret-sentinel" },
    },
  });
  assert.equal(rejected.statusCode, 400);
  assert.doesNotMatch(rejected.body, /raw-import-secret-sentinel/i);

  const fixture = realVocSnapshot(SCOOTER_ASINS, randomUUID(), runId);
  const {
    id: _fixtureId,
    runId: _fixtureRunId,
    createdAt: _fixtureCreatedAt,
    ...candidate
  } = fixture;
  void _fixtureId;
  void _fixtureRunId;
  void _fixtureCreatedAt;
  const earlierCutoffCandidate = {
    ...candidate,
    dataCutoffAt: "2026-08-14T00:00:00.000Z",
    contentHash: canonicalJsonSha256({
      schemaVersion: candidate.schemaVersion,
      marketplace: candidate.marketplace,
      asins: candidate.asins,
      dataCutoffAt: "2026-08-14T00:00:00.000Z",
      sources: candidate.sources,
      payload: candidate.payload,
    }),
  };
  const rejectedCutoff = await service.app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/voc-import`,
    headers: proxyHeaders(),
    payload: {
      importMode: "file-import",
      candidate: earlierCutoffCandidate,
    },
  });
  assert.equal(rejectedCutoff.statusCode, 409, rejectedCutoff.body);
  assert.match(rejectedCutoff.body, /cutoff/i);
  assert.doesNotMatch(rejectedCutoff.body, /raw-import-secret-sentinel/i);
  assert.equal((await repository.findRunStage(stageId))?.status, "waiting-input");
  assert.equal((await repository.findAnalysisRun(runId))?.status, "waiting-input");
  assert.equal((await repository.listJobAttempts(stageId)).length, 1);
  assert.equal(
    (await repository.listAgentRuns({ organizationId, runId })).length,
    0,
  );

  const imported = await service.app.inject({
    method: "POST",
    url: `/v1/runs/${runId}/voc-import`,
    headers: proxyHeaders(),
    payload: { importMode: "file-import", candidate },
  });
  assert.equal(imported.statusCode, 200, imported.body);
  assert.equal(imported.json().runId, runId);
  assert.equal(imported.json().stageId, stageId);
  assert.equal(imported.json().jobId, jobId);

  await waitFor(async () => {
    const status = (await repository.findRunStage(stageId))?.status;
    return status === "succeeded" || status === "failed";
  });
  const terminalStage = await repository.findRunStage(stageId);
  const terminalAttempts = await repository.listJobAttempts(stageId);
  const terminalAgentRuns = await repository.listAgentRuns({
    organizationId,
    runId,
  });
  assert.equal(
    terminalStage?.status,
    "succeeded",
    JSON.stringify({ terminalStage, terminalAttempts, terminalAgentRuns }),
  );
  assert.equal((await repository.findAnalysisRun(runId))?.status, "succeeded");
  const resumedAttempts = await repository.listJobAttempts(stageId);
  assert.equal(resumedAttempts.length, 1);
  assert.equal(resumedAttempts[0]?.id, jobId);
  assert.equal(resumedAttempts[0]?.status, "succeeded");
  assert.equal((await repository.listAnalysisReports({
    actorOrganizationId: organizationId,
    runId,
    stage: "voc-positioning",
  })).length, 1);
});

function proxyHeaders() {
  return {
    origin: ORIGIN,
    "x-agent-proxy-token": PROXY_TOKEN,
    "content-type": "application/json",
  };
}

function runtimeEnv(
  databasePath: string,
  actorId: string,
  organizationId: string,
): Record<string, string> {
  return {
    OPENAI_API_KEY: "configured-test-key",
    AGENT_VOC_MODEL: "configured-model",
    AGENT_VOC_ESTIMATED_INPUT_TOKENS: "4000",
    AGENT_VOC_MAX_OUTPUT_TOKENS: "4000",
    AGENT_VOC_TIMEOUT_MS: "5000",
    AGENT_VOC_INPUT_USD_PER_MILLION_TOKENS: "1",
    AGENT_VOC_OUTPUT_USD_PER_MILLION_TOKENS: "2",
    AGENT_VOC_CALL_MAX_TOKENS: "50000",
    AGENT_VOC_CALL_MAX_COST_MICROS: "50000",
    AGENT_VOC_RUN_MAX_TOKENS: "50000",
    AGENT_VOC_RUN_MAX_COST_MICROS: "50000",
    AGENT_VOC_DAILY_MAX_TOKENS: "50000",
    AGENT_VOC_DAILY_MAX_COST_MICROS: "50000",
    AGENT_VOC_WORKER_OWNER_ID: "voc-resume-worker",
    AGENT_VOC_WORKER_POLL_MS: "10",
    NODE_ENV: "test",
    AGENT_SERVICE_HOST: "127.0.0.1",
    AGENT_SQLITE_PATH: databasePath,
    AGENT_SERVICE_PROXY_TOKEN: PROXY_TOKEN,
    AGENT_SERVICE_TRUSTED_ORIGINS: ORIGIN,
    AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
    AGENT_EXECUTION_ACTOR_ID: actorId,
    AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
  };
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the expected durable runtime state");
}
