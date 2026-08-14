import { z } from "zod";

import type {
  ModelBudgetAmount,
  ModelBudgetReservationRecord,
  ModelBudgetTransitionResult,
} from "../db/model-budget-repository";
import { BudgetExceededError } from "./budget-policy";
import type { ReserveModelRequestInput } from "./model-budget-coordinator";
import {
  ModelProviderError,
  type ModelProvider,
  type ModelProviderUsage,
  type StructuredGenerationRequest,
  type StructuredGenerationResult,
} from "./model-provider";
import {
  calculateModelCostMicros,
  createModelRequestFingerprint,
  createModelRequestIdempotencyKey,
  type ModelRequestAttemptIdentity,
} from "./model-request-accounting";
import { createStructuredResponseFormat } from "./structured-response-format";
import {
  redactStringForLog,
  summarizeContent,
  type ContentSummary,
} from "./redaction";
import {
  EntityIdSchema,
  SkillProvenanceSchema,
} from "../../shared/agent-contracts";
import type { SkillRegistry } from "../skills/registry";

const FORBIDDEN_SECRET_KEY =
  /(?:api.?key|authorization|cookie|credential|password|passwd|secret|session|token)/i;
const FORBIDDEN_CONTROL_KEYS = new Set([
  "agentcalls",
  "budget",
  "budgetoverride",
  "bypassbudget",
  "developerinstructions",
  "loop",
  "nextagent",
  "prompt",
  "recursiveagent",
  "requestedtools",
  "skipbudget",
  "spawnagent",
  "systemprompt",
  "toolcalls",
  "tools",
]);
const FORBIDDEN_IDENTITY_KEYS = new Set([
  "createdby",
  "displayname",
  "email",
  "identity",
  "memberid",
  "organizationid",
  "userid",
]);
const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type SkillRuntimeErrorCode =
  | "CONFIGURATION_ERROR"
  | "INPUT_SECURITY_ERROR"
  | "INPUT_VALIDATION_ERROR"
  | "MODEL_OUTPUT_ERROR"
  | "PROVIDER_ERROR"
  | "TIMEOUT"
  | "CANCELLED";

export class SkillRuntimeError extends Error {
  constructor(
    readonly code: SkillRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillRuntimeError";
  }
}

export interface NamedInputContract<I> {
  name: string;
  schema: z.ZodType<I>;
  allowedFields: readonly string[];
}

export interface NamedOutputContract<O> {
  name: string;
  schema: z.ZodType<O>;
}

export interface ModelExecutionConfig {
  name: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  pricing: {
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
  };
}

export interface SkillExecutionRequest<I, O> {
  skill: { id: string; version: string };
  inputContract: NamedInputContract<I>;
  outputContract: NamedOutputContract<O>;
  input: unknown;
  snapshotIds: readonly string[];
  model: ModelExecutionConfig;
  signal?: AbortSignal;
}

const SkillExecutionContextSchema = z
  .object({
    runId: EntityIdSchema,
    projectId: EntityIdSchema,
    jobAttemptId: EntityIdSchema,
  })
  .strict();

export type SkillExecutionContext = z.infer<typeof SkillExecutionContextSchema>;

export const SkillRunRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0.0"),
    skill: SkillProvenanceSchema,
    snapshotIds: z.array(EntityIdSchema).min(1),
    provider: z.string().trim().min(1),
    model: z.string().trim().min(1),
    responseId: z.string().trim().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    attemptCount: z.number().int().positive(),
  })
  .strict()
  .refine(
    (record) => record.totalTokens === record.inputTokens + record.outputTokens,
    { message: "Total tokens must equal input plus output tokens" },
  );

export type SkillRunRecord = z.infer<typeof SkillRunRecordSchema>;

export interface SkillRunLogSummary {
  schemaVersion: "1.0.0";
  skill: { id: string; version: string; contentHash: string };
  snapshotCount: number;
  provider: string;
  model: string;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  estimatedCostUsd: number;
  attemptCount: number;
  inputSummary: ContentSummary;
  outputSummary: ContentSummary;
}

export interface SkillExecutionResult<O> {
  value: O;
  record: Readonly<SkillRunRecord>;
  logSummary: Readonly<SkillRunLogSummary>;
}

export interface SkillModelBudgetCoordinator {
  reserve(input: ReserveModelRequestInput): Promise<ModelBudgetReservationRecord>;
  dispatch(reservationId: string): Promise<ModelBudgetTransitionResult>;
  release(reservationId: string): Promise<ModelBudgetTransitionResult>;
  settle(
    reservationId: string,
    actual: ModelBudgetAmount,
  ): Promise<ModelBudgetTransitionResult>;
}

interface SkillRunnerDependencies {
  registry: SkillRegistry;
  provider: ModelProvider;
  providerName: string;
  budgetCoordinator: SkillModelBudgetCoordinator;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  logger?: (summary: Readonly<SkillRunLogSummary>) => void;
}

function normalizeKey(value: string) {
  return value.replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function assertSafeTree(
  value: unknown,
  context: "input" | "output",
  path = "$",
  seen = new Set<object>(),
): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) {
    throw new SkillRuntimeError(
      context === "input" ? "INPUT_SECURITY_ERROR" : "MODEL_OUTPUT_ERROR",
      `${context} contains a recursive object at ${path}`,
    );
  }
  seen.add(value);

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new SkillRuntimeError(
        context === "input" ? "INPUT_SECURITY_ERROR" : "MODEL_OUTPUT_ERROR",
        `${context} contains a non-string key at ${path}`,
      );
    }
    const normalized = normalizeKey(key);
    if (PROTOTYPE_KEYS.has(key.toLowerCase())) {
      throw new SkillRuntimeError(
        context === "input" ? "INPUT_SECURITY_ERROR" : "MODEL_OUTPUT_ERROR",
        `${context} contains a prototype-pollution key at ${path}.${key}`,
      );
    }
    if (context === "input" && FORBIDDEN_SECRET_KEY.test(normalized)) {
      throw new SkillRuntimeError(
        "INPUT_SECURITY_ERROR",
        `Input contains a secret or credential field at ${path}.${key}`,
      );
    }
    if (context === "input" && FORBIDDEN_IDENTITY_KEYS.has(normalized)) {
      throw new SkillRuntimeError(
        "INPUT_SECURITY_ERROR",
        `Input contains forbidden identity metadata at ${path}.${key}`,
      );
    }
    if (context === "input" && normalized.includes("header")) {
      throw new SkillRuntimeError(
        "INPUT_SECURITY_ERROR",
        `Input contains forbidden request headers at ${path}.${key}`,
      );
    }
    if (FORBIDDEN_CONTROL_KEYS.has(normalized)) {
      throw new SkillRuntimeError(
        context === "input" ? "INPUT_SECURITY_ERROR" : "MODEL_OUTPUT_ERROR",
        `${context} contains a forbidden tool, agent, loop, budget, prompt, or instruction directive at ${path}.${key}`,
      );
    }
    assertSafeTree(
      (value as Record<PropertyKey, unknown>)[key],
      context,
      `${path}.${key}`,
      seen,
    );
  }
  seen.delete(value);
}

function assertDeclaredTopLevelInput(
  input: unknown,
  allowedFields: readonly string[],
) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new SkillRuntimeError(
      "INPUT_VALIDATION_ERROR",
      "Skill input must be an object",
    );
  }
  const allowed = new Set(allowedFields);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new SkillRuntimeError(
        "INPUT_SECURITY_ERROR",
        `Input field is not declared: ${key}`,
      );
    }
  }
}

function assertFiniteNonNegative(value: number, label: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new SkillRuntimeError(
      "CONFIGURATION_ERROR",
      `Invalid model configuration: ${label}`,
    );
  }
}

function assertSafeInteger(
  value: number,
  label: string,
  allowZero: boolean,
) {
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new SkillRuntimeError(
      "CONFIGURATION_ERROR",
      `Invalid model configuration: ${label}`,
    );
  }
}

function assertModelConfig(config: ModelExecutionConfig) {
  if (!config.name.trim()) {
    throw new SkillRuntimeError("CONFIGURATION_ERROR", "Model is not configured");
  }
  assertSafeInteger(config.estimatedInputTokens, "estimatedInputTokens", true);
  assertSafeInteger(config.maxOutputTokens, "maxOutputTokens", false);
  assertSafeInteger(config.timeoutMs, "timeoutMs", false);
  assertFiniteNonNegative(
    config.pricing.inputUsdPerMillionTokens,
    "inputUsdPerMillionTokens",
  );
  assertFiniteNonNegative(
    config.pricing.outputUsdPerMillionTokens,
    "outputUsdPerMillionTokens",
  );
}

function providerRuntimeMessage(kind: ModelProviderError["kind"]): string {
  switch (kind) {
    case "transient":
      return "Model provider remained temporarily unavailable";
    case "permanent":
      return "Model provider request failed";
    case "timeout":
      return "Model request timed out";
    case "aborted":
      return "Model request was aborted";
    case "refusal":
      return "Model provider refused the request";
    case "incomplete":
      return "Model provider returned an incomplete response";
    case "empty":
      return "Model provider returned an empty response";
    case "invalid_output":
      return "Model provider returned invalid structured output";
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function assertBudgetCoordinator(
  coordinator: SkillModelBudgetCoordinator | undefined,
) {
  if (
    !coordinator ||
    typeof coordinator.reserve !== "function" ||
    typeof coordinator.dispatch !== "function" ||
    typeof coordinator.release !== "function" ||
    typeof coordinator.settle !== "function"
  ) {
    throw new TypeError("Persistent model budget coordinator is required");
  }
}

function modelBudgetAmountFromUsage(
  usage: ModelProviderUsage,
  pricing: ModelExecutionConfig["pricing"],
): ModelBudgetAmount {
  if (
    typeof usage.responseId !== "string" ||
    usage.responseId.trim().length === 0 ||
    !Number.isSafeInteger(usage.inputTokens) ||
    usage.inputTokens < 0 ||
    !Number.isSafeInteger(usage.outputTokens) ||
    usage.outputTokens < 0 ||
    !Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
  ) {
    throw new SkillRuntimeError(
      "PROVIDER_ERROR",
      "Model provider returned invalid token usage",
    );
  }
  try {
    return {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costMicros: calculateModelCostMicros(
        usage.inputTokens,
        usage.outputTokens,
        pricing,
      ),
    };
  } catch (error) {
    throw new SkillRuntimeError(
      "PROVIDER_ERROR",
      "Model provider returned invalid token usage",
      { cause: error },
    );
  }
}

function accumulateUsage(
  consumedInputTokens: number,
  consumedOutputTokens: number,
  consumedCostMicros: number,
  actual: ModelBudgetAmount,
) {
  const inputTokens = consumedInputTokens + actual.inputTokens;
  const outputTokens = consumedOutputTokens + actual.outputTokens;
  const totalTokens = inputTokens + outputTokens;
  const costMicros = consumedCostMicros + actual.costMicros;
  if (
    !Number.isSafeInteger(inputTokens) ||
    !Number.isSafeInteger(outputTokens) ||
    !Number.isSafeInteger(totalTokens) ||
    !Number.isSafeInteger(costMicros)
  ) {
    throw new SkillRuntimeError(
      "PROVIDER_ERROR",
      "Model provider returned invalid token usage",
    );
  }
  return { inputTokens, outputTokens, costMicros };
}

function budgetCoordinationError(cause: unknown) {
  return new SkillRuntimeError(
    "PROVIDER_ERROR",
    "Model request budget coordination failed",
    { cause },
  );
}

export class SkillRunner {
  private readonly now: () => number;

  constructor(private readonly dependencies: SkillRunnerDependencies) {
    assertBudgetCoordinator(dependencies.budgetCoordinator);
    this.now = dependencies.now ?? Date.now;
  }

  async run<I, O>(
    request: SkillExecutionRequest<I, O>,
    executionContext: SkillExecutionContext,
  ): Promise<SkillExecutionResult<O>> {
    if (Object.prototype.hasOwnProperty.call(request, "budget")) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Legacy budget overrides are not accepted by SkillRunner",
      );
    }
    const parsedExecutionContext = SkillExecutionContextSchema.safeParse(
      executionContext,
    );
    if (!parsedExecutionContext.success) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Server execution context is missing or invalid",
        { cause: parsedExecutionContext.error },
      );
    }
    if (request.signal?.aborted) {
      throw new SkillRuntimeError("CANCELLED", "Skill execution was aborted");
    }
    const parsedSnapshotIds = z
      .array(EntityIdSchema)
      .min(1)
      .safeParse(request.snapshotIds);
    if (!parsedSnapshotIds.success) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Snapshot provenance must contain at least one valid snapshot ID",
        { cause: parsedSnapshotIds.error },
      );
    }
    assertModelConfig(request.model);
    assertDeclaredTopLevelInput(request.input, request.inputContract.allowedFields);
    assertSafeTree(request.input, "input");

    const parsedInput = request.inputContract.schema.safeParse(request.input);
    if (!parsedInput.success) {
      throw new SkillRuntimeError(
        "INPUT_VALIDATION_ERROR",
        "Skill input does not match its declared schema",
        { cause: parsedInput.error },
      );
    }

    const loaded = await this.dependencies.registry.load(
      request.skill.id,
      request.skill.version,
    );
    if (
      loaded.manifest.inputSchema !== request.inputContract.name ||
      loaded.manifest.outputSchema !== request.outputContract.name
    ) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Runtime contracts do not match the Skill manifest",
      );
    }

    let responseFormat;
    try {
      responseFormat = createStructuredResponseFormat(
        request.outputContract.schema,
        request.outputContract.name,
      );
    } catch (error) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Skill output contract cannot produce a strict response format",
        { cause: error },
      );
    }

    const instructions = [
      loaded.instructions,
      ...[...loaded.references].map(
        ([referencePath, content]) => `\n# Reference: ${referencePath}\n\n${content}`,
      ),
      "\nReturn only the declared structured output. Do not request tools or invoke agents.",
    ].join("\n");
    const projectedTokens =
      request.model.estimatedInputTokens + request.model.maxOutputTokens;
    if (!Number.isSafeInteger(projectedTokens) || projectedTokens <= 0) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Invalid model configuration: projectedTokens",
      );
    }
    let projectedCostMicros: number;
    try {
      projectedCostMicros = calculateModelCostMicros(
        request.model.estimatedInputTokens,
        request.model.maxOutputTokens,
        request.model.pricing,
      );
    } catch (error) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Invalid model configuration: pricing",
        { cause: error },
      );
    }
    const projected: ModelBudgetAmount = {
      inputTokens: request.model.estimatedInputTokens,
      outputTokens: request.model.maxOutputTokens,
      costMicros: projectedCostMicros,
    };
    const startedAt = this.now();
    let attemptCount = 0;
    let transientRetryCount = 0;
    let repairAttempted = false;
    let nextRequestKind: ModelRequestAttemptIdentity["kind"] = "initial";
    let consumedInputTokens = 0;
    let consumedOutputTokens = 0;
    let consumedCostMicros = 0;
    let generated!: StructuredGenerationResult<O>;
    let parsedOutput!: z.ZodSafeParseSuccess<O>;

    while (true) {
      const requestIdentity: ModelRequestAttemptIdentity = {
        ordinal: attemptCount,
        kind: nextRequestKind,
        transientRetryCount,
        formatRepair: repairAttempted,
      };
      const idempotencyKey = createModelRequestIdempotencyKey({
        runId: parsedExecutionContext.data.runId,
        jobAttemptId: parsedExecutionContext.data.jobAttemptId,
        ordinal: requestIdentity.ordinal,
      });
      let requestFingerprint: string;
      try {
        requestFingerprint = createModelRequestFingerprint({
          skill: {
            id: loaded.manifest.id,
            version: loaded.manifest.version,
            contentHash: loaded.manifest.contentHash,
          },
          provider: this.dependencies.providerName,
          model: request.model,
          inputContractName: request.inputContract.name,
          outputContractName: request.outputContract.name,
          outputSchemaDigest: responseFormat.digest,
          parsedInput: parsedInput.data,
          snapshotIds: parsedSnapshotIds.data,
          request: requestIdentity,
        });
      } catch (error) {
        throw new SkillRuntimeError(
          "INPUT_VALIDATION_ERROR",
          "Parsed Skill input cannot be canonically fingerprinted",
          { cause: error },
        );
      }
      const reservation = await this.reserveModelRequest({
        idempotencyKey,
        requestFingerprint,
        runId: parsedExecutionContext.data.runId,
        projectId: parsedExecutionContext.data.projectId,
        projected,
      });
      if (request.signal?.aborted) {
        if (reservation.state === "reserved") {
          await this.releaseModelRequest(reservation.id);
        }
        throw new SkillRuntimeError("CANCELLED", "Skill execution was aborted");
      }
      const dispatch = await this.dispatchModelRequest(reservation.id);
      if (!dispatch.transitioned) {
        throw new SkillRuntimeError(
          "PROVIDER_ERROR",
          "Model request was not authorized for dispatch",
        );
      }

      attemptCount += 1;
      const generationRequest: StructuredGenerationRequest<O> = {
        model: request.model.name,
        instructions: repairAttempted
          ? `${instructions}\n\nFORMAT REPAIR: The previous response failed the declared schema. Regenerate the answer from the original input and exactly match the schema. Do not add fields.`
          : instructions,
        input: parsedInput.data,
        outputSchema: request.outputContract.schema,
        responseFormat,
        maxOutputTokens: request.model.maxOutputTokens,
        timeoutMs: request.model.timeoutMs,
        signal: request.signal,
      };

      try {
        generated = await this.generateWithTimeout(generationRequest);
      } catch (error) {
        if (error instanceof ModelProviderError && error.usage) {
          const actual = await this.settleModelUsage(
            reservation.id,
            error.usage,
            request.model.pricing,
          );
          ({
            inputTokens: consumedInputTokens,
            outputTokens: consumedOutputTokens,
            costMicros: consumedCostMicros,
          } = accumulateUsage(
            consumedInputTokens,
            consumedOutputTokens,
            consumedCostMicros,
            actual,
          ));
        }
        if (
          error instanceof ModelProviderError &&
          error.kind === "invalid_output"
        ) {
          if (!repairAttempted) {
            repairAttempted = true;
            nextRequestKind = "format-repair";
            continue;
          }
          throw new SkillRuntimeError(
            "MODEL_OUTPUT_ERROR",
            "Model output failed SDK parsing after one repair attempt",
            { cause: error },
          );
        }
        if (
          error instanceof ModelProviderError &&
          error.kind === "transient" &&
          transientRetryCount < 2
        ) {
          transientRetryCount += 1;
          nextRequestKind = "transient-retry";
          await this.waitBeforeRetry(transientRetryCount, request.signal);
          continue;
        }
        if (error instanceof BudgetExceededError) throw error;
        if (error instanceof ModelProviderError) {
          const code =
            error.kind === "timeout"
              ? "TIMEOUT"
              : error.kind === "aborted"
                ? "CANCELLED"
                : "PROVIDER_ERROR";
          throw new SkillRuntimeError(code, providerRuntimeMessage(error.kind), {
            cause: error,
          });
        }
        throw new SkillRuntimeError(
          "PROVIDER_ERROR",
          "Model provider request failed",
          { cause: error },
        );
      }

      const actual = await this.settleModelUsage(
        reservation.id,
        generated,
        request.model.pricing,
      );
      ({
        inputTokens: consumedInputTokens,
        outputTokens: consumedOutputTokens,
        costMicros: consumedCostMicros,
      } = accumulateUsage(
        consumedInputTokens,
        consumedOutputTokens,
        consumedCostMicros,
        actual,
      ));

      assertSafeTree(generated.value, "output");
      const outputResult = request.outputContract.schema.safeParse(generated.value);
      if (outputResult.success) {
        parsedOutput = outputResult;
        break;
      }
      if (!repairAttempted) {
        repairAttempted = true;
        nextRequestKind = "format-repair";
        continue;
      }
      throw new SkillRuntimeError(
        "MODEL_OUTPUT_ERROR",
        "Model output does not match the declared schema after one repair attempt",
        { cause: outputResult.error },
      );
    }

    const durationMs = Math.max(0, this.now() - startedAt);
    const record = deepFreeze(SkillRunRecordSchema.parse({
      schemaVersion: "1.0.0" as const,
      skill: {
        id: loaded.manifest.id,
        version: loaded.manifest.version,
        contentHash: loaded.manifest.contentHash,
      },
      snapshotIds: parsedSnapshotIds.data,
      provider: this.dependencies.providerName,
      model: request.model.name,
      responseId: generated.responseId,
      inputTokens: consumedInputTokens,
      outputTokens: consumedOutputTokens,
      totalTokens: consumedInputTokens + consumedOutputTokens,
      durationMs,
      estimatedCostUsd: consumedCostMicros / 1_000_000,
      attemptCount,
    }));
    const logSummary = deepFreeze({
      schemaVersion: "1.0.0" as const,
      skill: { ...record.skill },
      snapshotCount: record.snapshotIds.length,
      provider: redactStringForLog(record.provider),
      model: redactStringForLog(record.model),
      responseId: redactStringForLog(record.responseId),
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalTokens: record.totalTokens,
      durationMs: record.durationMs,
      estimatedCostUsd: record.estimatedCostUsd,
      attemptCount: record.attemptCount,
      inputSummary: summarizeContent(parsedInput.data),
      outputSummary: summarizeContent(parsedOutput.data),
    });
    this.dependencies.logger?.(logSummary);
    return { value: parsedOutput.data, record, logSummary };
  }

  private async reserveModelRequest(input: ReserveModelRequestInput) {
    try {
      return await this.dependencies.budgetCoordinator.reserve(input);
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      throw budgetCoordinationError(error);
    }
  }

  private async dispatchModelRequest(reservationId: string) {
    try {
      return await this.dependencies.budgetCoordinator.dispatch(reservationId);
    } catch (error) {
      throw budgetCoordinationError(error);
    }
  }

  private async releaseModelRequest(reservationId: string) {
    try {
      return await this.dependencies.budgetCoordinator.release(reservationId);
    } catch (error) {
      throw budgetCoordinationError(error);
    }
  }

  private async settleModelUsage(
    reservationId: string,
    usage: ModelProviderUsage,
    pricing: ModelExecutionConfig["pricing"],
  ) {
    const actual = modelBudgetAmountFromUsage(usage, pricing);
    try {
      await this.dependencies.budgetCoordinator.settle(reservationId, actual);
    } catch (error) {
      throw budgetCoordinationError(error);
    }
    return actual;
  }

  private async waitBeforeRetry(count: number, signal?: AbortSignal) {
    if (signal?.aborted) {
      throw new SkillRuntimeError("CANCELLED", "Skill execution was aborted");
    }
    const sleep = this.dependencies.sleep;
    if (sleep) await sleep(100 * 2 ** (count - 1), signal);
  }

  private async generateWithTimeout<T>(
    request: StructuredGenerationRequest<T>,
  ) {
    if (request.signal?.aborted) {
      throw new ModelProviderError("aborted", "Model request was aborted");
    }
    const controller = new AbortController();
    let timedOut = false;
    const onExternalAbort = () => controller.abort(request.signal?.reason);
    request.signal?.addEventListener("abort", onExternalAbort, { once: true });
    if (request.signal?.aborted) onExternalAbort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("Model request timed out"));
        reject(new ModelProviderError("timeout", "Model request timed out"));
      }, request.timeoutMs);
    });
    const aborted = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => {
          if (!timedOut) {
            reject(new ModelProviderError("aborted", "Model request was aborted"));
          }
        },
        { once: true },
      );
    });

    try {
      return await Promise.race([
        this.dependencies.provider.generateStructured({
          ...request,
          signal: controller.signal,
        }),
        timeout,
        aborted,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }
}
