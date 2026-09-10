import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { ManualAlexaVocRepositoryError } from "../../server/db/manual-alexa-voc-repository";
import { AlexaVocNormalizationExecutionService } from "../../server/services/alexa-voc-normalization-execution-service";
import { createAlexaVocNormalizationFingerprint } from "../../server/domain/voc/alexa-voc-normalization-contracts";
import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { JobLeaseLostError, type JobAttemptRecord } from "../../server/db/repository";
import { WorkerTaskError } from "../../server/runtime/retry-policy";
import { createAlexaVocNormalizationJobHandler } from "../../server/services/alexa-voc-normalization-worker-handler";
import { AlexaVocPublicationConflictError } from "../../server/services/alexa-voc-publication-error";

const job = {
  id: "job", runId: "run", stageId: "stage", stage: "alexa-voc-normalization",
  leasedBy: "owner", leaseGeneration: 1, logicalExecutionCycleId: "a".repeat(64),
} as JobAttemptRecord;
const prepared = {
  snapshots: [{ id: "a", asin: "B0NORM0001" }, { id: "b", asin: "B0NORM0002" }],
  context: { actorId: "actor", organizationId: "org", projectId: "project", dataCutoffAt: "2026-09-10T00:00:00.000Z" },
  providerName: "fixture",
  model: { name: "fixture", estimatedInputTokens: 10, maxOutputTokens: 10, timeoutMs: 1000,
    pricing: { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1 } },
};

for (const failure of [
  new WorkerTaskError("configuration", "trusted subject unavailable"),
  new WorkerTaskError("authentication", "actor unavailable"),
  new WorkerTaskError("cancelled", "cancelled"),
  new JobLeaseLostError(),
  new WorkerTaskError("infrastructure", "database unavailable"),
  new ManualAlexaVocRepositoryError("permission"),
]) {
  test(`normalization stops siblings on ${failure.name}/${failure.message}`, async () => {
    let calls = 0, terminals = 0, finalized = 0;
    const handler = createAlexaVocNormalizationJobHandler({
      prepare: () => prepared,
      service: { execute: async () => { calls++; throw failure; } },
      onTerminal: () => { terminals++; },
      finalize: () => { finalized++; return true; },
    });
    await assert.rejects(handler({ job, signal: new AbortController().signal }), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(terminals, 0);
    assert.equal(finalized, 0);
  });
}

for (const corruption of ["missing-snapshot", "scope", "execution-fingerprint", "audit-fingerprint"] as const) {
  test(`real execution-service ${corruption} stops page without terminalizing authority failure`, async () => {
    const organizationId = randomUUID(), projectId = randomUUID(), runId = randomUUID();
    const firstId = randomUUID(), secondId = randomUUID();
    const rawText = "ASIN B0NORM0001\ntrusted local fixture";
    const executionIdentity = { providerName: prepared.providerName, model: prepared.model };
    const fingerprint = createAlexaVocNormalizationFingerprint({
      marketplace: "US", asin: "B0NORM0001", rawReportSha256: canonicalJsonSha256(rawText), executionIdentity,
    });
    let lookups = 0, modelCalls = 0, commits = 0, terminals = 0, finalized = 0;
    const service = new AlexaVocNormalizationExecutionService({
      repository: {
        findNormalizationInputSnapshot: async ({ snapshotId }) => {
          lookups++;
          if (corruption === "missing-snapshot") return null;
          return {
            id: snapshotId, organizationId, projectId: corruption === "scope" ? randomUUID() : projectId,
            runId, marketplace: "US", asin: "B0NORM0001",
            rawReportSha256: canonicalJsonSha256(rawText), plaintextBytes: Buffer.byteLength(rawText),
            executionFingerprint: corruption === "execution-fingerprint" ? "f".repeat(64) : fingerprint,
            executionIdentity, envelope: {} as never, createdAt: prepared.context.dataCutoffAt,
          };
        },
        findCommittedNormalizationByFingerprint: async () => null,
        commitNormalizationAndWake: async () => { commits++; throw new Error("must not commit"); },
      },
      normalizationInputCipher: {
        activeKeyId: "fixture", encrypt: () => { throw new Error("unused"); }, decrypt: () => rawText,
      },
      auditedRunner: { run: async () => {
        modelCalls++;
        return { agentRun: { id: randomUUID(), executionFingerprint: "f".repeat(64) }, value: {} } as never;
      } },
    });
    const handler = createAlexaVocNormalizationJobHandler({
      prepare: () => ({ ...prepared,
        context: { ...prepared.context, actorId: randomUUID(), organizationId, projectId },
        snapshots: [{ id: firstId, asin: "B0NORM0001" }, { id: secondId, asin: "B0NORM0002" }],
      }),
      service, onTerminal: () => { terminals++; }, finalize: () => { finalized++; return true; },
    });
    await assert.rejects(handler({ job: { ...job, runId }, signal: new AbortController().signal }),
      (error) => error instanceof WorkerTaskError && error.category === "configuration");
    assert.equal(lookups, 1);
    assert.equal(modelCalls, corruption === "audit-fingerprint" ? 1 : 0);
    assert.equal(commits, 0);
    assert.equal(terminals, 0);
    assert.equal(finalized, 0);
  });
}

test("aborted normalization lease makes no sibling model calls", async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const handler = createAlexaVocNormalizationJobHandler({
    prepare: () => prepared,
    service: { execute: async () => { calls++; return {} as never; } },
    onTerminal: () => {}, finalize: () => true,
  });
  await assert.rejects(handler({ job, signal: controller.signal }));
  assert.equal(calls, 0);
});

for (const abortAfterReplay of [false, true]) {
  test(`durable replay conflict defers retry without false terminal; abort=${abortAfterReplay}`, async () => {
    const controller = new AbortController();
    const failure = new AlexaVocPublicationConflictError(new Error("fixture conflict"));
    let calls = 0, finalized = 0;
    const terminals: string[] = [];
    const handler = createAlexaVocNormalizationJobHandler({
      prepare: () => ({ ...prepared, snapshots: [
        { ...prepared.snapshots[0]!, executionFingerprint: "a".repeat(64),
          replay: { agentRunId: "audit-a", revision: "1" } },
        prepared.snapshots[1]!,
      ] }),
      onReplay: () => { if (abortAfterReplay) controller.abort(); throw failure; },
      service: { execute: async () => { calls++; return { agentRunId: "audit-b" } as never; } },
      onTerminal: ({ snapshotId }) => { terminals.push(snapshotId); },
      finalize: () => { finalized++; return false; },
    });
    await assert.rejects(handler({ job, signal: controller.signal }),
      (error) => abortAfterReplay ? error === controller.signal.reason : error === failure);
    assert.equal(calls, abortAfterReplay ? 0 : 1);
    assert.deepEqual(terminals, abortAfterReplay ? [] : ["b"]);
    assert.equal(finalized, 0);
  });
}
