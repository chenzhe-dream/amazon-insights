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

export type SkillExecutionLineageInput = Omit<
  SkillExecutionFingerprintInput,
  "jobAttemptId"
> & { logicalExecutionCycleId: string };

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

  const inputPrice = decimalParts(pricing.inputUsdPerMillionTokens);
  const outputPrice = decimalParts(pricing.outputUsdPerMillionTokens);
  const scale = Math.max(inputPrice.scale, outputPrice.scale);
  const denominator = powerOfTen(scale);
  const numerator =
    BigInt(inputTokens) *
      inputPrice.coefficient *
      powerOfTen(scale - inputPrice.scale) +
    BigInt(outputTokens) *
      outputPrice.coefficient *
      powerOfTen(scale - outputPrice.scale);
  const zero = BigInt(0);
  const costMicros =
    numerator === zero
      ? zero
      : (numerator + denominator - BigInt(1)) / denominator;
  if (costMicros > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new TypeError("Invalid model accounting value for costMicros");
  }
  return Number(costMicros);
}

function decimalParts(value: number): {
  coefficient: bigint;
  scale: number;
} {
  if (Object.is(value, -0) || value === 0) {
    return { coefficient: BigInt(0), scale: 0 };
  }
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]?\d+))?$/.exec(
    value.toString(),
  );
  if (!match) {
    throw new TypeError("Invalid model accounting value for decimal price");
  }
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent)) {
    throw new TypeError("Invalid model accounting value for decimal price");
  }
  let coefficient = BigInt(`${match[1]}${fraction}`);
  let scale = fraction.length - exponent;
  if (scale < 0) {
    coefficient *= powerOfTen(-scale);
    scale = 0;
  }
  return { coefficient, scale };
}

function powerOfTen(exponent: number): bigint {
  if (!Number.isSafeInteger(exponent) || exponent < 0 || exponent > 400) {
    throw new TypeError("Invalid model accounting value for decimal scale");
  }
  return BigInt(10) ** BigInt(exponent);
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
  if (!Number.isFinite(cutoff.getTime())) {
    throw new TypeError("Invalid model accounting value for dataCutoffAt");
  }
  const canonicalDataCutoffAt = cutoff.toISOString();
  const inputContentHash = canonicalJsonSha256(input.inputContract.value);
  return sha256(
    canonicalJson({
      schema: "skill-execution-fingerprint@1",
      runId: input.runId,
      stageId: input.stageId,
      jobAttemptId: input.jobAttemptId,
      skill: input.skill,
      snapshotIds: [...input.snapshotIds],
      dataCutoffAt: canonicalDataCutoffAt,
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

export function createSkillExecutionLineage(
  input: SkillExecutionLineageInput,
): string {
  assertSha256(input.logicalExecutionCycleId, "logicalExecutionCycleId");
  const syntheticAttempt = "logical-stage-input";
  const { logicalExecutionCycleId, ...executionIdentity } = input;
  const fingerprint = createSkillExecutionFingerprint({
    ...executionIdentity,
    jobAttemptId: syntheticAttempt,
  });
  return sha256(canonicalJson({
    schema: "skill-execution-lineage@2",
    logicalExecutionCycleId,
    fingerprint,
  }));
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
