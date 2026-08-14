import { createHash } from "node:crypto";

export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}

export interface ModelRequestAttemptIdentity {
  ordinal: number;
  kind: "initial" | "transient-retry" | "format-repair";
  transientRetryCount: number;
  formatRepair: boolean;
}

export interface ModelRequestFingerprintInput {
  skill: {
    id: string;
    version: string;
    contentHash: string;
  };
  provider: string;
  model: {
    name: string;
    estimatedInputTokens: number;
    maxOutputTokens: number;
    timeoutMs: number;
    pricing: ModelPricing;
  };
  inputContractName: string;
  outputContractName: string;
  outputSchemaDigest: string;
  parsedInput: unknown;
  snapshotIds: readonly string[];
  request: ModelRequestAttemptIdentity;
}

export interface ModelRequestIdempotencyInput {
  runId: string;
  jobAttemptId: string;
  ordinal: number;
}

export interface SkillExecutionFingerprintInput {
  runId: string;
  stageId: string;
  jobAttemptId: string;
  skill: {
    id: string;
    version: string;
    contentHash: string;
    inputSchema: string;
    outputSchema: string;
  };
  snapshotIds: readonly string[];
  dataCutoffAt: string;
  provider: string;
  model: ModelRequestFingerprintInput["model"];
  inputContract: {
    name: string;
    schemaDigest: string;
    value: unknown;
  };
  outputContract: {
    name: string;
    schemaDigest: string;
  };
}

export function calculateModelCostMicros(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  assertNonNegativeSafeInteger(inputTokens, "inputTokens");
  assertNonNegativeSafeInteger(outputTokens, "outputTokens");
  assertNonNegativeFinite(
    pricing.inputUsdPerMillionTokens,
    "inputUsdPerMillionTokens",
  );
  assertNonNegativeFinite(
    pricing.outputUsdPerMillionTokens,
    "outputUsdPerMillionTokens",
  );

  const inputCost = inputTokens * pricing.inputUsdPerMillionTokens;
  const outputCost = outputTokens * pricing.outputUsdPerMillionTokens;
  const unroundedMicros = inputCost + outputCost;
  const costMicros = Math.ceil(unroundedMicros);
  if (
    !Number.isFinite(inputCost) ||
    !Number.isFinite(outputCost) ||
    !Number.isFinite(unroundedMicros) ||
    !Number.isSafeInteger(costMicros) ||
    costMicros < 0
  ) {
    throw new TypeError("Invalid model accounting value for costMicros");
  }
  return costMicros;
}

export function canonicalJsonSha256(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function createModelRequestIdempotencyKey(
  input: ModelRequestIdempotencyInput,
): string {
  assertNonEmptyString(input.runId, "runId");
  assertNonEmptyString(input.jobAttemptId, "jobAttemptId");
  assertNonNegativeSafeInteger(input.ordinal, "ordinal");
  return sha256(
    canonicalJson({
      schema: "skill-model-request-idempotency@1",
      runId: input.runId,
      jobAttemptId: input.jobAttemptId,
      ordinal: input.ordinal,
    }),
  );
}

export function createModelRequestFingerprint(
  input: ModelRequestFingerprintInput,
): string {
  assertSha256(input.outputSchemaDigest, "outputSchemaDigest");
  const parsedInputHash = canonicalJsonSha256(input.parsedInput);
  return sha256(
    canonicalJson({
      schema: "skill-model-request-fingerprint@2",
      skill: input.skill,
      provider: input.provider,
      model: input.model,
      inputContractName: input.inputContractName,
      outputContractName: input.outputContractName,
      outputSchemaDigest: input.outputSchemaDigest,
      parsedInputHash,
      snapshotIds: [...input.snapshotIds],
      request: input.request,
    }),
  );
}

export function createSkillExecutionFingerprint(
  input: SkillExecutionFingerprintInput,
): string {
  for (const [label, value] of [
    ["runId", input.runId],
    ["stageId", input.stageId],
    ["jobAttemptId", input.jobAttemptId],
    ["skill.id", input.skill.id],
    ["skill.version", input.skill.version],
    ["skill.inputSchema", input.skill.inputSchema],
    ["skill.outputSchema", input.skill.outputSchema],
    ["provider", input.provider],
    ["inputContract.name", input.inputContract.name],
    ["outputContract.name", input.outputContract.name],
  ] as const) {
    assertNonEmptyString(value, label);
  }
  assertSha256(input.skill.contentHash, "skill.contentHash");
  assertSha256(input.inputContract.schemaDigest, "inputContract.schemaDigest");
  assertSha256(input.outputContract.schemaDigest, "outputContract.schemaDigest");
  if (input.snapshotIds.length === 0) {
    throw new TypeError("Invalid model accounting value for snapshotIds");
  }
  input.snapshotIds.forEach((snapshotId) =>
    assertNonEmptyString(snapshotId, "snapshotId"),
  );
  const cutoff = new Date(input.dataCutoffAt);
  if (
    !Number.isFinite(cutoff.getTime()) ||
    cutoff.toISOString() !== input.dataCutoffAt
  ) {
    throw new TypeError("Invalid model accounting value for dataCutoffAt");
  }
  const inputContentHash = canonicalJsonSha256(input.inputContract.value);
  return sha256(
    canonicalJson({
      schema: "skill-execution-fingerprint@1",
      runId: input.runId,
      stageId: input.stageId,
      jobAttemptId: input.jobAttemptId,
      skill: input.skill,
      snapshotIds: [...input.snapshotIds],
      dataCutoffAt: input.dataCutoffAt,
      provider: input.provider,
      model: input.model,
      inputContract: {
        name: input.inputContract.name,
        schemaDigest: input.inputContract.schemaDigest,
        contentHash: inputContentHash,
      },
      outputContract: input.outputContract,
    }),
  );
}

function canonicalJson(value: unknown): string {
  return canonicalize(value, new Set<object>());
}

function canonicalize(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "string":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) throw canonicalJsonError();
      return Object.is(value, -0) ? "0" : JSON.stringify(value);
    case "object":
      break;
    default:
      throw canonicalJsonError();
  }

  if (ancestors.has(value)) throw canonicalJsonError();
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return canonicalizeArray(value, ancestors);
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw canonicalJsonError();
    }
    return canonicalizeObject(
      value as Record<string, unknown>,
      ancestors,
    );
  } finally {
    ancestors.delete(value);
  }
}

function canonicalizeArray(value: readonly unknown[], ancestors: Set<object>) {
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.some(
      (key) =>
        typeof key !== "string" ||
        (key !== "length" && !/^(0|[1-9]\d*)$/.test(key)),
    )
  ) {
    throw canonicalJsonError();
  }
  const entries: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      throw canonicalJsonError();
    }
    entries.push(canonicalize(value[index], ancestors));
  }
  return `[${entries.join(",")}]`;
}

function canonicalizeObject(
  value: Record<string, unknown>,
  ancestors: Set<object>,
) {
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) throw canonicalJsonError();
  const stringKeys = (keys as string[]).sort(compareText);
  const entries = stringKeys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) {
      throw canonicalJsonError();
    }
    return `${JSON.stringify(key)}:${canonicalize(descriptor.value, ancestors)}`;
  });
  return `{${entries.join(",")}}`;
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJsonError() {
  return new TypeError("Value is not valid canonical JSON");
}

function assertNonEmptyString(value: string, label: string) {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Invalid model accounting value for ${label}`);
  }
}

function assertSha256(value: string, label: string) {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new TypeError(`Invalid model accounting value for ${label}`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`Invalid model accounting value for ${label}`);
  }
}

function assertNonNegativeFinite(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`Invalid model accounting value for ${label}`);
  }
}
