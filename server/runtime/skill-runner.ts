import { z } from "zod";

import {
  BudgetExceededError,
  assertBudgetAvailable,
  type BudgetAmount,
  type BudgetCheck,
} from "./budget-policy";
import {
  ModelProviderError,
  type ModelProvider,
  type StructuredGenerationRequest,
} from "./model-provider";
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
  budget: Omit<BudgetCheck, "projected">;
  signal?: AbortSignal;
}

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

interface SkillRunnerDependencies {
  registry: SkillRegistry;
  provider: ModelProvider;
  providerName: string;
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

function estimatedCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelExecutionConfig["pricing"],
) {
  return (
    (inputTokens * pricing.inputUsdPerMillionTokens +
      outputTokens * pricing.outputUsdPerMillionTokens) /
    1_000_000
  );
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

export class SkillRunner {
  private readonly now: () => number;

  constructor(private readonly dependencies: SkillRunnerDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async run<I, O>(
    request: SkillExecutionRequest<I, O>,
  ): Promise<SkillExecutionResult<O>> {
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

    const instructions = [
      loaded.instructions,
      ...[...loaded.references].map(
        ([referencePath, content]) => `\n# Reference: ${referencePath}\n\n${content}`,
      ),
      "\nReturn only the declared structured output. Do not request tools or invoke agents.",
    ].join("\n");
    const projected: BudgetAmount = {
      tokens: request.model.estimatedInputTokens + request.model.maxOutputTokens,
      costUsd: estimatedCost(
        request.model.estimatedInputTokens,
        request.model.maxOutputTokens,
        request.model.pricing,
      ),
    };
    const startedAt = this.now();
    let attemptCount = 0;
    let transientRetryCount = 0;
    let repairAttempted = false;
    const consumed: BudgetAmount = { tokens: 0, costUsd: 0 };
    let consumedInputTokens = 0;
    let consumedOutputTokens = 0;
    let generated;
    let parsedOutput: z.ZodSafeParseResult<O>;

    const consumeUsage = (usage: {
      inputTokens: number;
      outputTokens: number;
    }) => {
      const nextInputTokens = consumedInputTokens + usage.inputTokens;
      const nextOutputTokens = consumedOutputTokens + usage.outputTokens;
      const nextTotalTokens = nextInputTokens + nextOutputTokens;
      const usageCost = estimatedCost(
        usage.inputTokens,
        usage.outputTokens,
        request.model.pricing,
      );
      const nextCost = consumed.costUsd + usageCost;
      if (
        !Number.isSafeInteger(usage.inputTokens) ||
        usage.inputTokens < 0 ||
        !Number.isSafeInteger(usage.outputTokens) ||
        usage.outputTokens < 0 ||
        !Number.isSafeInteger(nextInputTokens) ||
        !Number.isSafeInteger(nextOutputTokens) ||
        !Number.isSafeInteger(nextTotalTokens) ||
        !Number.isFinite(usageCost) ||
        usageCost < 0 ||
        !Number.isFinite(nextCost)
      ) {
        throw new SkillRuntimeError(
          "PROVIDER_ERROR",
          "Model provider returned invalid token usage",
        );
      }
      consumedInputTokens = nextInputTokens;
      consumedOutputTokens = nextOutputTokens;
      consumed.tokens = nextTotalTokens;
      consumed.costUsd = nextCost;
    };

    while (true) {
      const usage = Object.fromEntries(
        (["call", "run", "daily"] as const).map((scope) => [
          scope,
          {
            tokens:
              request.budget.usage[scope].tokens +
              (scope === "call" ? 0 : consumed.tokens),
            costUsd:
              request.budget.usage[scope].costUsd +
              (scope === "call" ? 0 : consumed.costUsd),
          },
        ]),
      ) as BudgetCheck["usage"];
      assertBudgetAvailable({ limits: request.budget.limits, usage, projected });

      attemptCount += 1;
      const generationRequest: StructuredGenerationRequest<O> = {
        model: request.model.name,
        instructions: repairAttempted
          ? `${instructions}\n\nFORMAT REPAIR: The previous response failed the declared schema. Regenerate the answer from the original input and exactly match the schema. Do not add fields.`
          : instructions,
        input: parsedInput.data,
        outputSchema: request.outputContract.schema,
        outputSchemaName: request.outputContract.name.replace("@", "_"),
        maxOutputTokens: request.model.maxOutputTokens,
        timeoutMs: request.model.timeoutMs,
        signal: request.signal,
      };

      try {
        generated = await this.generateWithTimeout(generationRequest);
      } catch (error) {
        if (error instanceof ModelProviderError && error.usage) {
          consumeUsage(error.usage);
        }
        if (
          error instanceof ModelProviderError &&
          error.kind === "invalid_output"
        ) {
          if (!repairAttempted) {
            repairAttempted = true;
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

      consumeUsage(generated);

      assertSafeTree(generated.value, "output");
      parsedOutput = request.outputContract.schema.safeParse(generated.value);
      if (parsedOutput.success) break;
      if (!repairAttempted) {
        repairAttempted = true;
        continue;
      }
      throw new SkillRuntimeError(
        "MODEL_OUTPUT_ERROR",
        "Model output does not match the declared schema after one repair attempt",
        { cause: parsedOutput.error },
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
      estimatedCostUsd: consumed.costUsd,
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
