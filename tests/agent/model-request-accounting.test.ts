import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateModelCostMicros,
  canonicalJsonSha256,
  createSkillExecutionFingerprint,
  createModelRequestFingerprint,
  createModelRequestIdempotencyKey,
  type ModelRequestFingerprintInput,
  type SkillExecutionFingerprintInput,
} from "../../server/runtime/model-request-accounting";

const contentHash = "a".repeat(64);
const runId = "11111111-1111-4111-8111-111111111111";
const jobAttemptId = "22222222-2222-4222-8222-222222222222";

function executionIdentity(
  overrides: Partial<SkillExecutionFingerprintInput> = {},
): SkillExecutionFingerprintInput {
  return {
    runId,
    stageId: "66666666-6666-4666-8666-666666666666",
    jobAttemptId,
    skill: {
      id: "skill-a",
      version: "1.0.0",
      contentHash,
      inputSchema: "Input@1.0.0",
      outputSchema: "Output@1.0.0",
    },
    snapshotIds: [
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444",
    ],
    dataCutoffAt: "2026-08-15T08:00:00.000Z",
    provider: "fake",
    model: {
      name: "configured-model",
      estimatedInputTokens: 200,
      maxOutputTokens: 100,
      timeoutMs: 1_000,
      pricing: {
        inputUsdPerMillionTokens: 1.25,
        outputUsdPerMillionTokens: 3.5,
      },
    },
    inputContract: {
      name: "Input@1.0.0",
      schemaDigest: "d".repeat(64),
      value: { facts: { mentions: 12, safe: true }, page: 1 },
    },
    outputContract: {
      name: "Output@1.0.0",
      schemaDigest: "e".repeat(64),
    },
    ...overrides,
  };
}

function identity(
  overrides: Partial<ModelRequestFingerprintInput> = {},
): ModelRequestFingerprintInput {
  return {
    skill: { id: "skill-a", version: "1.0.0", contentHash },
    provider: "fake",
    model: {
      name: "configured-model",
      estimatedInputTokens: 200,
      maxOutputTokens: 100,
      timeoutMs: 1_000,
      pricing: {
        inputUsdPerMillionTokens: 1.25,
        outputUsdPerMillionTokens: 3.5,
      },
    },
    inputContractName: "Input@1.0.0",
    outputContractName: "Output@1.0.0",
    outputSchemaDigest: "c".repeat(64),
    parsedInput: {
      asins: ["B000000001", "B000000002", "B000000003"],
      facts: { mentions: 12, safe: true },
    },
    snapshotIds: ["33333333-3333-4333-8333-333333333333"],
    request: {
      ordinal: 0,
      kind: "initial",
      transientRetryCount: 0,
      formatRepair: false,
    },
    ...overrides,
  };
}

test("canonical JSON hashing is stable across object key order and preserves array order", () => {
  const left = {
    z: 1,
    a: { beta: true, alpha: [1, "two", null] },
  };
  const right = {
    a: { alpha: [1, "two", null], beta: true },
    z: 1,
  };

  assert.equal(canonicalJsonSha256(left), canonicalJsonSha256(right));
  assert.notEqual(
    canonicalJsonSha256({ values: [1, 2] }),
    canonicalJsonSha256({ values: [2, 1] }),
  );
});

test("canonical hashing rejects undefined and every non-JSON or unstable value", () => {
  const sparse = [1, 2];
  delete sparse[1];
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;

  for (const invalid of [
    undefined,
    { value: undefined },
    [undefined],
    sparse,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    () => undefined,
    Symbol("not-json"),
    new Date("2026-08-14T00:00:00.000Z"),
    new Map([["key", "value"]]),
    cyclic,
  ]) {
    assert.throws(() => canonicalJsonSha256(invalid), /canonical JSON/i);
  }
});

test("request fingerprint is lowercase SHA-256 and covers every semantic request identity", () => {
  const baseline = identity();
  const baselineFingerprint = createModelRequestFingerprint(baseline);
  assert.match(baselineFingerprint, /^[0-9a-f]{64}$/);

  const reorderedInput = identity({
    parsedInput: {
      facts: { safe: true, mentions: 12 },
      asins: ["B000000001", "B000000002", "B000000003"],
    },
  });
  assert.equal(
    createModelRequestFingerprint(reorderedInput),
    baselineFingerprint,
  );

  const variants: ModelRequestFingerprintInput[] = [
    identity({
      skill: { ...baseline.skill, contentHash: "b".repeat(64) },
    }),
    identity({ provider: "other-provider" }),
    identity({ model: { ...baseline.model, name: "other-model" } }),
    identity({
      model: { ...baseline.model, maxOutputTokens: 101 },
    }),
    identity({
      model: {
        ...baseline.model,
        pricing: {
          ...baseline.model.pricing,
          inputUsdPerMillionTokens: 1.5,
        },
      },
    }),
    identity({ parsedInput: { changed: true } }),
    identity({
      snapshotIds: ["44444444-4444-4444-8444-444444444444"],
    }),
    identity({ outputContractName: "Output@2.0.0" }),
    identity({ outputSchemaDigest: "d".repeat(64) }),
    identity({
      request: {
        ordinal: 1,
        kind: "transient-retry",
        transientRetryCount: 1,
        formatRepair: false,
      },
    }),
    identity({
      request: {
        ordinal: 1,
        kind: "format-repair",
        transientRetryCount: 0,
        formatRepair: true,
      },
    }),
  ];

  for (const variant of variants) {
    assert.notEqual(
      createModelRequestFingerprint(variant),
      baselineFingerprint,
    );
  }
});

test("job execution fingerprint covers every prepared execution identity", () => {
  const baseline = executionIdentity();
  const fingerprint = createSkillExecutionFingerprint(baseline);
  assert.match(fingerprint, /^[0-9a-f]{64}$/);
  assert.equal(
    createSkillExecutionFingerprint(
      executionIdentity({
        inputContract: {
          ...baseline.inputContract,
          value: { page: 1, facts: { safe: true, mentions: 12 } },
        },
      }),
    ),
    fingerprint,
  );

  const variants: SkillExecutionFingerprintInput[] = [
    executionIdentity({ runId: "77777777-7777-4777-8777-777777777777" }),
    executionIdentity({ stageId: "77777777-7777-4777-8777-777777777777" }),
    executionIdentity({ jobAttemptId: "77777777-7777-4777-8777-777777777777" }),
    executionIdentity({ skill: { ...baseline.skill, version: "1.0.1" } }),
    executionIdentity({ skill: { ...baseline.skill, contentHash: "b".repeat(64) } }),
    executionIdentity({ skill: { ...baseline.skill, inputSchema: "Input@2.0.0" } }),
    executionIdentity({ snapshotIds: [...baseline.snapshotIds].reverse() }),
    executionIdentity({ dataCutoffAt: "2026-08-15T08:00:01.000Z" }),
    executionIdentity({ provider: "other-provider" }),
    executionIdentity({ model: { ...baseline.model, name: "other-model" } }),
    executionIdentity({ model: { ...baseline.model, maxOutputTokens: 101 } }),
    executionIdentity({
      model: {
        ...baseline.model,
        pricing: {
          ...baseline.model.pricing,
          outputUsdPerMillionTokens: 3.75,
        },
      },
    }),
    executionIdentity({
      inputContract: { ...baseline.inputContract, value: { page: 2 } },
    }),
    executionIdentity({
      inputContract: { ...baseline.inputContract, schemaDigest: "f".repeat(64) },
    }),
    executionIdentity({
      outputContract: { ...baseline.outputContract, name: "Output@2.0.0" },
    }),
    executionIdentity({
      outputContract: { ...baseline.outputContract, schemaDigest: "f".repeat(64) },
    }),
  ];
  for (const variant of variants) {
    assert.notEqual(createSkillExecutionFingerprint(variant), fingerprint);
  }
});

test("job attempt plus ordinal produces stable run-scoped idempotency keys", () => {
  const first = createModelRequestIdempotencyKey({
    runId,
    jobAttemptId,
    ordinal: 0,
  });
  const restarted = createModelRequestIdempotencyKey({
    runId,
    jobAttemptId,
    ordinal: 0,
  });
  const retry = createModelRequestIdempotencyKey({
    runId,
    jobAttemptId,
    ordinal: 1,
  });
  const otherAttempt = createModelRequestIdempotencyKey({
    runId,
    jobAttemptId: "55555555-5555-4555-8555-555555555555",
    ordinal: 0,
  });

  assert.equal(first, restarted);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(first, retry);
  assert.notEqual(first, otherAttempt);
});

test("cost micros use conservative ceiling and actual usage may exceed projection", () => {
  assert.equal(
    calculateModelCostMicros(1, 0, {
      inputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 0,
    }),
    1,
  );
  assert.equal(
    calculateModelCostMicros(2, 1, {
      inputUsdPerMillionTokens: 1.25,
      outputUsdPerMillionTokens: 3.5,
    }),
    6,
  );

  const projected = calculateModelCostMicros(10, 10, {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  });
  const actual = calculateModelCostMicros(100, 100, {
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 2,
  });
  assert.equal(projected, 30);
  assert.equal(actual, 300);
  assert.ok(actual > projected);
});

test("cost micros reject negative, fractional, non-finite, and unsafe accounting", () => {
  for (const invalidTokenCount of [
    -1,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        calculateModelCostMicros(invalidTokenCount, 1, {
          inputUsdPerMillionTokens: 1,
          outputUsdPerMillionTokens: 1,
        }),
      /model accounting/i,
    );
  }

  for (const invalidPrice of [
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    assert.throws(
      () =>
        calculateModelCostMicros(1, 1, {
          inputUsdPerMillionTokens: invalidPrice,
          outputUsdPerMillionTokens: 1,
        }),
      /model accounting/i,
    );
  }

  assert.throws(
    () =>
      calculateModelCostMicros(Number.MAX_SAFE_INTEGER, 1, {
        inputUsdPerMillionTokens: Number.MAX_SAFE_INTEGER,
        outputUsdPerMillionTokens: 1,
      }),
    /model accounting/i,
  );
});
