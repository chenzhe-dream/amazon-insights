import { z } from "zod";

import type {
  ModelBudgetAmount,
  ModelBudgetExecutionAuthority,
  ModelBudgetReservationRecord,
  ModelBudgetTransitionResult,
} from "../db/model-budget-repository";
import { ModelBudgetExecutionAuthorityLostError } from "../db/model-budget-repository";
import type { GovernedAttemptKind } from "../db/concurrency-control-repository";
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
  canonicalJsonSha256,
  createModelRequestFingerprint,
  createModelRequestIdempotencyKey,
  type ModelRequestAttemptIdentity,
} from "./model-request-accounting";
import { createStructuredResponseFormat } from "./structured-response-format";
import {
  createFormatRepairInstruction,
  freezeSafeValidationIssues,
  normalizeFormatRepairGuidance,
  summarizeZodValidationIssues,
  type SafeValidationIssue,
} from "./safe-validation-issues";
import {
  redactStringForLog,
  summarizeContent,
  type ContentSummary,
} from "./redaction";
import {
  AgentRunAttemptSchema,
  EntityIdSchema,
  SkillProvenanceSchema,
  type AgentRunAttempt,
} from "../../shared/agent-contracts";
import type { SkillManifest } from "../skills/manifest";
import type { SkillRegistry } from "../skills/registry";
import type { StructuredResponseFormat } from "./structured-response-format";
import { trustedExecutionAbortKind } from "./execution-abort";
import { MarketExecutionSubjectSchema, MarketModelExecutionAuthoritySchema, type MarketExecutionSubject, type MarketModelExecutionAuthority } from "../../shared/market-execution-subject";
import type { MarketModelBudgetCoordinator, ReserveMarketModelRequestInput } from "./market-model-budget-coordinator";

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
  | "CANCELLED"
  | "INTERRUPTED";

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
  responseSchema?: z.ZodType<unknown>;
  schemaDefinitions?: Readonly<Record<string, z.ZodType>>;
  canonicalizeOutput?: (candidate: unknown) => unknown;
  repairGuidance?: (
    issues: readonly SafeValidationIssue[],
  ) => readonly string[] | null;
  repairPatch?: NamedOutputRepairPatchContract;
}

export interface NamedOutputRepairPatchContract {
  /** Trusted guidance supplies all context for a bounded field-only repair. */
  selfContained?: boolean;
  name: string;
  schema: z.ZodType<unknown>;
  canHandle(
    output: unknown,
    issues: readonly SafeValidationIssue[],
  ): boolean;
  guidance(
    output: unknown,
    issues: readonly SafeValidationIssue[],
  ): readonly string[] | null;
  apply(
    output: unknown,
    patch: unknown,
    issues: readonly SafeValidationIssue[],
  ): unknown;
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
  executionFingerprint?: string;
  signal?: AbortSignal;
}

const SkillExecutionContextSchema = z
  .object({
    organizationId: EntityIdSchema,
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
    estimatedCostMicros: z.number().int().nonnegative(),
    estimatedCostUsd: z.number().nonnegative(),
    attemptCount: z.number().int().positive(),
    attempts: z.array(AgentRunAttemptSchema).min(1).max(4),
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
  estimatedCostMicros: number;
  attemptCount: number;
  inputSummary: ContentSummary;
  outputSummary: ContentSummary;
}

export interface ModelValidationFailureLog {
  readonly event: "model_validation_failed";
  readonly attemptKind: "initial" | "format-repair";
  readonly issueCount: number;
  readonly issues: readonly SafeValidationIssue[];
}

export type ModelValidationLogger = (
  entry: Readonly<ModelValidationFailureLog>,
) => void;

export interface SkillExecutionResult<O> {
  value: O;
  record: Readonly<SkillRunRecord>;
  logSummary: Readonly<SkillRunLogSummary>;
}

export class SkillPreparedExecutionConflictError extends SkillRuntimeError {
  constructor() {
    super(
      "CONFIGURATION_ERROR",
      "Prepared Skill contracts changed during execution",
    );
    this.name = "SkillPreparedExecutionConflictError";
  }
}

export interface SkillRunFailureAudit {
  responseId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostMicros: number | null;
  durationMs: number;
  attemptCount: number;
  usageCompleteness: "complete" | "partial" | "unavailable";
  attempts: readonly AgentRunAttempt[];
}

export interface PreparedSkillExecution<I, O> {
  readonly skill: Readonly<SkillManifest>;
  readonly parsedInput: Readonly<I>;
  readonly snapshotIds: readonly string[];
  readonly model: Readonly<ModelExecutionConfig>;
  readonly providerName: string;
  readonly inputContract: Readonly<{
    name: string;
    schema: z.ZodType<I>;
    schemaDigest: string;
  }>;
  readonly outputContract: Readonly<{
    name: string;
    schema: z.ZodType<O>;
    responseSchema?: z.ZodType<unknown>;
    schemaDefinitions?: Readonly<Record<string, z.ZodType>>;
    schemaDigest: string;
    canonicalizeOutput?: (candidate: unknown) => unknown;
    repairGuidance?: (
      issues: readonly SafeValidationIssue[],
    ) => readonly string[] | null;
    repairPatch?: Readonly<NamedOutputRepairPatchContract & {
      schemaDigest: string;
      responseFormat: StructuredResponseFormat;
    }>;
  }>;
  readonly responseFormat: StructuredResponseFormat;
  readonly instructions: string;
  readonly projected: Readonly<ModelBudgetAmount>;
  readonly signal?: AbortSignal;
}

const failureAudits = new WeakMap<object, Readonly<SkillRunFailureAudit>>();

export function getSkillRunFailureAudit(
  error: unknown,
): Readonly<SkillRunFailureAudit> | null {
  return error !== null && (typeof error === "object" || typeof error === "function")
    ? failureAudits.get(error) ?? null
    : null;
}

export interface SkillModelBudgetCoordinator {
  reserve(input: ReserveModelRequestInput): Promise<ModelBudgetReservationRecord>;
  dispatch(
    reservationId: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority>,
  ): Promise<ModelBudgetTransitionResult>;
  release(
    reservationId: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority>,
  ): Promise<ModelBudgetTransitionResult>;
  settle(
    reservationId: string,
    actual: ModelBudgetAmount,
    responseId?: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority>,
  ): Promise<ModelBudgetTransitionResult>;
}

interface SkillRunnerDependencies {
  registry: SkillRegistry;
  provider: ModelProvider;
  providerName: string;
  budgetCoordinator: SkillModelBudgetCoordinator;
  marketBudgetCoordinator?: Pick<MarketModelBudgetCoordinator, 'reserve' | 'dispatch' | 'release' | 'settle'>;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  logger?: (summary: Readonly<SkillRunLogSummary>) => void;
  validationLogger?: ModelValidationLogger;
  /** Server-owned admission for the complete physical payload, including format repair. */
  validateGenerationRequest?: (request: Readonly<StructuredGenerationRequest<unknown>>) => void;
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

function providerAttemptClassification(
  kind: ModelProviderError["kind"],
  signal?: AbortSignal,
): AgentRunAttempt["errorClassification"] {
  switch (kind) {
    case "transient":
    case "timeout":
      return "upstream-temporary";
    case "permanent":
    case "refusal":
      return "upstream-permanent";
    case "aborted":
      return trustedExecutionAbortKind(signal) === "run-cancelled"
        ? "cancelled"
        : "upstream-temporary";
    case "incomplete":
    case "empty":
    case "invalid_output":
      return "model-output";
  }
}

function auditAttempt(
  identity: ModelRequestAttemptIdentity,
  accounting: AgentRunAttempt["accounting"],
  errorClassification: AgentRunAttempt["errorClassification"],
  providerReasonCode?: AgentRunAttempt["providerReasonCode"],
) {
  return AgentRunAttemptSchema.parse({
    ...identity,
    accounting,
    errorClassification,
    ...(providerReasonCode ? { providerReasonCode } : {}),
  });
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

function attachFailureAudit(
  error: unknown,
  state: {
    latestResponseId: string | null;
    consumedInputTokens: number;
    consumedOutputTokens: number;
    consumedCostMicros: number;
    durationMs: number;
    attempts: readonly AgentRunAttempt[];
  },
) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) {
    return;
  }
  const settledCount = state.attempts.filter(
    (attempt) => attempt.accounting === "settled",
  ).length;
  const usageCompleteness: SkillRunFailureAudit["usageCompleteness"] =
    state.attempts.length > 0 && settledCount === state.attempts.length
      ? "complete"
      : settledCount > 0
        ? "partial"
        : "unavailable";
  const hasKnownUsage = usageCompleteness !== "unavailable";
  const audit: Readonly<SkillRunFailureAudit> = deepFreeze({
    responseId: state.latestResponseId,
    inputTokens: hasKnownUsage ? state.consumedInputTokens : null,
    outputTokens: hasKnownUsage ? state.consumedOutputTokens : null,
    estimatedCostMicros: hasKnownUsage ? state.consumedCostMicros : null,
    durationMs: state.durationMs,
    attemptCount: state.attempts.length,
    usageCompleteness,
    attempts: state.attempts.map((attempt) => ({ ...attempt })),
  });
  failureAudits.set(error, audit);
}

export class SkillRunner {
  private readonly now: () => number;
  private readonly preparedExecutions = new WeakSet<object>();

  constructor(private readonly dependencies: SkillRunnerDependencies) {
    assertBudgetCoordinator(dependencies.budgetCoordinator);
    this.now = dependencies.now ?? Date.now;
  }

  async run<I, O>(
    request: SkillExecutionRequest<I, O>,
    executionContext: SkillExecutionContext,
  ): Promise<SkillExecutionResult<O>> {
    const prepared = await this.prepare(request);
    return this.runPrepared(prepared, executionContext);
  }

  async prepare<I, O>(
    request: SkillExecutionRequest<I, O>,
  ): Promise<PreparedSkillExecution<I, O>> {
    if (Object.prototype.hasOwnProperty.call(request, "budget")) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Legacy budget overrides are not accepted by SkillRunner",
      );
    }
    throwIfExecutionAborted(request.signal);
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
    let repairPatch:
      | Readonly<NamedOutputRepairPatchContract & {
          schemaDigest: string;
          responseFormat: StructuredResponseFormat;
        }>
      | undefined;
    try {
      responseFormat = createStructuredResponseFormat(
        request.outputContract.responseSchema ?? request.outputContract.schema,
        request.outputContract.name,
        request.outputContract.schemaDefinitions,
      );
      if (request.outputContract.repairPatch) {
        const patchResponseFormat = createStructuredResponseFormat(
          request.outputContract.repairPatch.schema,
          request.outputContract.repairPatch.name,
        );
        repairPatch = Object.freeze({
          ...request.outputContract.repairPatch,
          responseFormat: patchResponseFormat,
          schemaDigest: canonicalJsonSha256(patchResponseFormat.format.schema),
        });
      }
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
    let inputSchemaDigest: string;
    let outputSchemaDigest: string;
    try {
      inputSchemaDigest = canonicalJsonSha256(
        JSON.parse(JSON.stringify(z.toJSONSchema(request.inputContract.schema))),
      );
      outputSchemaDigest = canonicalJsonSha256(responseFormat.format.schema);
    } catch (error) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Skill contracts cannot produce stable JSON Schema digests",
        { cause: error },
      );
    }
    const prepared = Object.freeze({
      skill: deepFreeze({
        ...loaded.manifest,
        allowedReferences: [...loaded.manifest.allowedReferences],
        fixtures: [...loaded.manifest.fixtures],
      }),
      parsedInput: deepFreeze(parsedInput.data),
      snapshotIds: deepFreeze([...parsedSnapshotIds.data]),
      model: deepFreeze({
        ...request.model,
        pricing: { ...request.model.pricing },
      }),
      providerName: this.dependencies.providerName,
      inputContract: Object.freeze({
        name: request.inputContract.name,
        schema: request.inputContract.schema,
        schemaDigest: inputSchemaDigest,
      }),
      outputContract: Object.freeze({
        name: request.outputContract.name,
        schema: request.outputContract.schema,
        ...(request.outputContract.schemaDefinitions
          ? { schemaDefinitions: Object.freeze({ ...request.outputContract.schemaDefinitions }) }
          : {}),
        ...(request.outputContract.responseSchema
          ? { responseSchema: request.outputContract.responseSchema }
          : {}),
        schemaDigest: outputSchemaDigest,
        ...(request.outputContract.canonicalizeOutput
          ? { canonicalizeOutput: request.outputContract.canonicalizeOutput }
          : {}),
        ...(request.outputContract.repairGuidance
          ? { repairGuidance: request.outputContract.repairGuidance }
          : {}),
        ...(repairPatch ? { repairPatch } : {}),
      }),
      responseFormat,
      instructions,
      projected: deepFreeze({ ...projected }),
      ...(request.signal ? { signal: request.signal } : {}),
    }) satisfies PreparedSkillExecution<I, O>;
    this.preparedExecutions.add(prepared);
    return prepared;
  }

  async runPrepared<I, O>(
    prepared: PreparedSkillExecution<I, O>,
    executionContext: SkillExecutionContext | MarketExecutionSubject,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority | MarketModelExecutionAuthority>,
  ): Promise<SkillExecutionResult<O>> {
    if (!this.preparedExecutions.has(prepared)) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Prepared Skill execution does not belong to this runner",
      );
    }
    const parsedExecutionContext = z.union([SkillExecutionContextSchema, MarketExecutionSubjectSchema]).safeParse(
      executionContext,
    );
    if (!parsedExecutionContext.success) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Server execution context is missing or invalid",
        { cause: parsedExecutionContext.error },
      );
    }
    const context = parsedExecutionContext.data;
    let marketAuthority: MarketModelExecutionAuthority | null = null;
    if ('kind' in context) {
      const parsedAuthority = MarketModelExecutionAuthoritySchema.safeParse(executionAuthority);
      const coordinator = this.dependencies.marketBudgetCoordinator;
      if (!parsedAuthority.success || !coordinator ||
          ['reserve', 'dispatch', 'release', 'settle'].some(method => typeof coordinator[method as keyof typeof coordinator] !== 'function') ||
          Object.entries(context).some(([key, value]) => parsedAuthority.data[key as keyof MarketExecutionSubject] !== value)) {
        throw new SkillRuntimeError('CONFIGURATION_ERROR', 'Native market execution authority or budget adapter is invalid');
      }
      marketAuthority = parsedAuthority.data;
      executionAuthority = marketAuthority;
    } else if (executionAuthority && 'kind' in executionAuthority) {
      throw new SkillRuntimeError('CONFIGURATION_ERROR', 'Market authority cannot authorize a project execution');
    }
    // These are neutral request-accounting keys, not fabricated legacy DB rows.
    const executionIds = 'kind' in context ? { runId: context.moduleRunId, jobAttemptId: context.attemptId } : context;
    throwIfExecutionAborted(prepared.signal);
    if (prepared.providerName !== this.dependencies.providerName) {
      throw new SkillRuntimeError(
        "CONFIGURATION_ERROR",
        "Prepared Skill execution provider does not match this runner",
      );
    }
    this.assertPreparedContractIdentity(prepared);
    const request = {
      model: prepared.model,
      outputContract: prepared.outputContract,
      inputContract: prepared.inputContract,
      signal: prepared.signal,
    };
    const loaded = { manifest: prepared.skill };
    const parsedInput = { data: prepared.parsedInput };
    const parsedSnapshotIds = { data: prepared.snapshotIds };
    const responseFormat = prepared.responseFormat;
    const instructions = prepared.instructions;
    const projected = prepared.projected;
    const startedAt = this.now();
    let attemptCount = 0;
    let transientRetryCount = 0;
    let repairAttempted = false;
    let formatRepairIssues: readonly SafeValidationIssue[] = [];
    let nextRequestKind: ModelRequestAttemptIdentity["kind"] = "initial";
    let consumedInputTokens = 0;
    let consumedOutputTokens = 0;
    let consumedCostMicros = 0;
    let latestResponseId: string | null = null;
    const attempts: AgentRunAttempt[] = [];
    let generated!: StructuredGenerationResult<unknown>;
    let parsedOutput!: z.ZodSafeParseSuccess<O>;
    let repairPatchState: Readonly<{
      contract: NonNullable<typeof request.outputContract.repairPatch>;
      output: unknown;
    }> | null = null;

    try {
      while (true) {
      const requestIdentity: ModelRequestAttemptIdentity = {
        ordinal: attemptCount,
        kind: nextRequestKind,
        transientRetryCount,
        formatRepair: repairAttempted,
      };
      const activePatch = repairAttempted ? repairPatchState?.contract : null;
      const activeResponseFormat = activePatch?.responseFormat ?? responseFormat;
      const activeOutputSchema = activePatch?.schema ?? request.outputContract.schema;
      const activeOutputContractName = activePatch?.name ?? request.outputContract.name;
      const activeOutputSchemaDigest = activePatch?.schemaDigest ?? prepared.outputContract.schemaDigest;
      const idempotencyKey = createModelRequestIdempotencyKey({
        runId: executionIds.runId,
        agentRunId:
          executionAuthority?.agentRunId ??
          executionIds.jobAttemptId,
        jobAttemptId: executionIds.jobAttemptId,
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
          outputContractName: activeOutputContractName,
          outputSchemaDigest: activeOutputSchemaDigest,
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
      const generationRequest: StructuredGenerationRequest<unknown> = {
        model: request.model.name,
        instructions: repairAttempted
          ? createFormatRepairInstruction(
              activePatch?.selfContained ? "Repair only the explicitly authorized fields. Return the patch schema; never regenerate the report." : instructions,
              formatRepairIssues,
              this.#resolveRepairGuidance(
                activePatch
                  ? () => activePatch.guidance(
                      repairPatchState!.output,
                      formatRepairIssues,
                    )
                  : request.outputContract.repairGuidance,
                formatRepairIssues,
              ),
            )
          : instructions,
        input: activePatch?.selfContained ? {} : parsedInput.data,
        outputSchema: activeOutputSchema,
        ...(!activePatch && request.outputContract.canonicalizeOutput
          ? { canonicalizeOutput: request.outputContract.canonicalizeOutput }
          : {}),
        responseFormat: activeResponseFormat,
        maxOutputTokens: activePatch?.selfContained ? Math.min(request.model.maxOutputTokens, 1024) : request.model.maxOutputTokens,
        timeoutMs: activePatch?.selfContained ? Math.min(request.model.timeoutMs, 60_000) : request.model.timeoutMs,
        signal: request.signal,
        governorScope: {
          organizationId: context.organizationId,
          jobId: executionIds.jobAttemptId,
          attemptKind: governorAttemptKind(requestIdentity.kind),
        },
      };
      this.dependencies.validateGenerationRequest?.(generationRequest);

      const reservation = await this.reserveModelRequest('kind' in context ? {
        idempotencyKey, requestFingerprint, projected, request: requestIdentity, authority: marketAuthority!,
      } : {
        idempotencyKey, requestFingerprint, runId: context.runId, projectId: context.projectId,
        projected, jobAttemptId: context.jobAttemptId, request: requestIdentity,
        executionAuthority: executionAuthority as Readonly<ModelBudgetExecutionAuthority> | undefined,
      });
      if (request.signal?.aborted) {
        if (reservation.state === "reserved") {
          await this.releaseModelRequest(reservation.id, executionAuthority);
        }
        throw executionAbortError(request.signal);
      }
      try {
        this.assertPreparedContractIdentity(prepared);
      } catch (error) {
        if (reservation.state === "reserved") {
          await this.releaseModelRequest(reservation.id, executionAuthority);
        }
        throw error;
      }
      const dispatch = await this.dispatchModelRequest(
        reservation.id,
        executionAuthority,
      );
      if (!dispatch.transitioned) {
        throw new SkillRuntimeError(
          "PROVIDER_ERROR",
          "Model request was not authorized for dispatch",
        );
      }

      attemptCount += 1;


      try {
        generated = await this.generateWithTimeout(generationRequest, marketAuthority
          ? async (usage) => { await this.settleModelUsage(reservation.id, usage, request.model.pricing, marketAuthority); }
          : undefined);
      } catch (error) {
        if (error instanceof ModelProviderError && error.usage) {
          latestResponseId = error.usage.responseId;
          let actual: ModelBudgetAmount;
          try {
            actual = await this.settleModelUsage(
              reservation.id,
              error.usage,
              request.model.pricing,
              executionAuthority,
            );
          } catch (settlementError) {
            attempts.push(auditAttempt(requestIdentity, "unavailable", "infrastructure"));
            throw settlementError;
          }
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
          attempts.push(
            auditAttempt(
              requestIdentity,
              "settled",
              providerAttemptClassification(error.kind, request.signal),
              error.reasonCode,
            ),
          );
        } else if (error instanceof ModelProviderError) {
          attempts.push(
            auditAttempt(
              requestIdentity,
              "unavailable",
              providerAttemptClassification(error.kind, request.signal),
              error.reasonCode,
            ),
          );
        } else {
          attempts.push(
            auditAttempt(requestIdentity, "unavailable", "infrastructure"),
          );
        }
        if (
          error instanceof ModelProviderError &&
          error.kind === "invalid_output"
        ) {
          const issues = freezeSafeValidationIssues(
            error.validationIssues ?? [],
            activeResponseFormat.format.schema,
          );
          this.#logValidationFailure(
            validationAttemptKind(requestIdentity.kind),
            issues,
            activeResponseFormat.format.schema,
          );
          if (!repairAttempted) {
            formatRepairIssues = issues;
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
                ? trustedExecutionAbortKind(request.signal) === "run-cancelled"
                  ? "CANCELLED"
                  : "INTERRUPTED"
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

      latestResponseId = generated.responseId;
      let actual: ModelBudgetAmount;
      try {
        actual = await this.settleModelUsage(
          reservation.id,
          generated,
          request.model.pricing,
          executionAuthority,
        );
      } catch (error) {
        attempts.push(auditAttempt(requestIdentity, "unavailable", "infrastructure"));
        throw error;
      }
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

      this.assertPreparedContractIdentity(prepared);

      let outputResult: z.ZodSafeParseSuccess<O> | z.ZodSafeParseError<unknown>;
      let normalized: unknown;
      try {
        assertSafeTree(generated.value, "output");
        if (activePatch) {
          const patch = activePatch.schema.parse(generated.value);
          const applied = activePatch.apply(
            repairPatchState!.output,
            patch,
            formatRepairIssues,
          );
          assertSafeTree(applied, "output");
          normalized = request.outputContract.canonicalizeOutput
            ? request.outputContract.canonicalizeOutput(applied)
            : applied;
        } else {
          normalized = request.outputContract.canonicalizeOutput
            ? request.outputContract.canonicalizeOutput(generated.value)
            : generated.value;
        }
        outputResult = request.outputContract.schema.safeParse(normalized);
      } catch (error) {
        if (!activePatch && error instanceof z.ZodError) {
          // Canonicalizers may validate references before the full output schema.
          // Keep these failures in the same bounded repair and usage audit path.
          normalized = generated.value;
          outputResult = { success: false, error };
        } else {
          attempts.push(auditAttempt(requestIdentity, "settled", "model-output"));
          if (activePatch) {
            throw new SkillRuntimeError(
              "MODEL_OUTPUT_ERROR",
              "Model repair patch was invalid or exceeded its authority",
              { cause: error },
            );
          }
          throw error;
        }
      }
      if (outputResult.success) {
        attempts.push(auditAttempt(requestIdentity, "settled", null));
        parsedOutput = outputResult;
        break;
      }
      attempts.push(auditAttempt(requestIdentity, "settled", "model-output"));
      const issues = summarizeZodValidationIssues(
        outputResult.error,
        responseFormat,
      );
      this.#logValidationFailure(
        validationAttemptKind(requestIdentity.kind),
        issues,
        responseFormat.format.schema,
      );
      if (!repairAttempted) {
        formatRepairIssues = issues;
        const patchContract = request.outputContract.repairPatch;
        if (patchContract) {
          try {
            if (patchContract.canHandle(normalized, issues)) {
              repairPatchState = Object.freeze({
                contract: patchContract,
                output: deepFreeze(structuredClone(normalized)),
              });
            }
          } catch {
            repairPatchState = null;
          }
        }
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
      estimatedCostMicros: consumedCostMicros,
      estimatedCostUsd: consumedCostMicros / 1_000_000,
      attemptCount,
      attempts,
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
      estimatedCostMicros: record.estimatedCostMicros,
      estimatedCostUsd: record.estimatedCostUsd,
      attemptCount: record.attemptCount,
      inputSummary: summarizeContent(parsedInput.data),
      outputSummary: summarizeContent(parsedOutput.data),
      });
      try {
        this.dependencies.logger?.(logSummary);
      } catch {
        // Observability must not change the provider result or durable usage.
      }
      return { value: parsedOutput.data, record, logSummary };
    } catch (error) {
      attachFailureAudit(error, {
        latestResponseId,
        consumedInputTokens,
        consumedOutputTokens,
        consumedCostMicros,
        durationMs: Math.max(0, this.now() - startedAt),
        attempts,
      });
      throw error;
    }
  }

  assertPreparedContractIdentity<I, O>(
    prepared: PreparedSkillExecution<I, O>,
  ): void {
    if (!this.preparedExecutions.has(prepared)) {
      throw new SkillPreparedExecutionConflictError();
    }
    try {
      const inputDigest = canonicalJsonSha256(
        JSON.parse(JSON.stringify(z.toJSONSchema(prepared.inputContract.schema))),
      );
      const currentResponseFormat = createStructuredResponseFormat(
        prepared.outputContract.responseSchema ?? prepared.outputContract.schema,
        prepared.outputContract.name,
        prepared.outputContract.schemaDefinitions,
      );
      const outputDigest = canonicalJsonSha256(
        currentResponseFormat.format.schema,
      );
      const currentPatchResponseFormat = prepared.outputContract.repairPatch
        ? createStructuredResponseFormat(
            prepared.outputContract.repairPatch.schema,
            prepared.outputContract.repairPatch.name,
          )
        : null;
      if (
        inputDigest !== prepared.inputContract.schemaDigest ||
        outputDigest !== prepared.outputContract.schemaDigest ||
        (prepared.outputContract.repairPatch &&
          currentPatchResponseFormat &&
          canonicalJsonSha256(currentPatchResponseFormat.format.schema) !==
            prepared.outputContract.repairPatch.schemaDigest)
      ) {
        throw new SkillPreparedExecutionConflictError();
      }
    } catch (error) {
      if (error instanceof SkillPreparedExecutionConflictError) throw error;
      throw new SkillPreparedExecutionConflictError();
    }
  }

  private async reserveModelRequest(input: ReserveModelRequestInput | ReserveMarketModelRequestInput) {
    try {
      return 'authority' in input
        ? await this.dependencies.marketBudgetCoordinator!.reserve(input)
        : await this.dependencies.budgetCoordinator.reserve(input);
    } catch (error) {
      if (error instanceof BudgetExceededError) throw error;
      throw budgetCoordinationError(error);
    }
  }

  private async dispatchModelRequest(
    reservationId: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority | MarketModelExecutionAuthority>,
  ) {
    try {
      if (executionAuthority && 'kind' in executionAuthority) {
        return await this.dependencies.marketBudgetCoordinator!.dispatch(reservationId, executionAuthority);
      }
      return await this.dependencies.budgetCoordinator.dispatch(
        reservationId,
        executionAuthority,
      );
    } catch (error) {
      throw budgetCoordinationError(error);
    }
  }

  private async releaseModelRequest(
    reservationId: string,
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority | MarketModelExecutionAuthority>,
  ) {
    try {
      if (executionAuthority && 'kind' in executionAuthority) {
        return await this.dependencies.marketBudgetCoordinator!.release(reservationId, executionAuthority);
      }
      return await this.dependencies.budgetCoordinator.release(
        reservationId,
        executionAuthority,
      );
    } catch (error) {
      if (error instanceof ModelBudgetExecutionAuthorityLostError) return null;
      throw budgetCoordinationError(error);
    }
  }

  private async settleModelUsage(
    reservationId: string,
    usage: ModelProviderUsage,
    pricing: ModelExecutionConfig["pricing"],
    executionAuthority?: Readonly<ModelBudgetExecutionAuthority | MarketModelExecutionAuthority>,
  ) {
    const actual = modelBudgetAmountFromUsage(usage, pricing);
    try {
      if (executionAuthority && 'kind' in executionAuthority) {
        await this.dependencies.marketBudgetCoordinator!.settle(reservationId, actual, usage.responseId, executionAuthority);
      } else await this.dependencies.budgetCoordinator.settle(
        reservationId,
        actual,
        usage.responseId,
        executionAuthority,
      );
    } catch (error) {
      throw budgetCoordinationError(error);
    }
    return actual;
  }

  private async waitBeforeRetry(count: number, signal?: AbortSignal) {
    throwIfExecutionAborted(signal);
    const sleep = this.dependencies.sleep;
    if (sleep) await sleep(100 * 2 ** (count - 1), signal);
  }

  private async generateWithTimeout<T>(
    request: StructuredGenerationRequest<T>,
    settleLateUsage?: (usage: ModelProviderUsage) => Promise<void>,
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
      const operation = this.dependencies.provider.generateStructured({ ...request, signal: controller.signal });
      if (!settleLateUsage) return await Promise.race([operation, timeout, aborted]);
      const observed = operation.then(
        value => ({ kind: "response" as const, value }),
        error => ({ kind: "error" as const, error: error as unknown }),
      );
      let outcome: Awaited<typeof observed>;
      try {
        outcome = await Promise.race([observed, timeout, aborted]);
      } catch (error) {
        // Native reservations retain their original authority for accounting only.
        // This continuation cannot validate/publish output or start another request.
        void observed.then(async late => {
          const usage = late.kind === "response" ? late.value
            : late.error instanceof ModelProviderError ? late.error.usage : undefined;
          if (usage) await settleLateUsage({ responseId: usage.responseId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
        }).catch(() => {
          // Keep the durable projected charge if accounting is unavailable; never
          // replace it with zero or overwrite the already returned terminal result.
        });
        throw error;
      }
      if (outcome.kind === "error") throw outcome.error;
      return outcome.value;
    } finally {
      if (timer) clearTimeout(timer);
      request.signal?.removeEventListener("abort", onExternalAbort);
    }
  }

  #logValidationFailure(
    attemptKind: ModelValidationFailureLog["attemptKind"],
    issues: readonly SafeValidationIssue[],
    declaredJsonSchema: Readonly<Record<string, unknown>>,
  ) {
    try {
      const safeIssues = freezeSafeValidationIssues(issues, declaredJsonSchema);
      this.dependencies.validationLogger?.(Object.freeze({
        event: "model_validation_failed" as const,
        attemptKind,
        issueCount: safeIssues.length,
        issues: safeIssues,
      }));
    } catch {
      // Observability must not affect execution, repair, or budget semantics.
    }
  }

  #resolveRepairGuidance(
    factory: NamedOutputContract<unknown>["repairGuidance"],
    issues: readonly SafeValidationIssue[],
  ): readonly string[] | null {
    if (!factory) return null;
    try {
      return normalizeFormatRepairGuidance(factory(issues));
    } catch {
      return null;
    }
  }
}

function validationAttemptKind(
  kind: ModelRequestAttemptIdentity["kind"],
): ModelValidationFailureLog["attemptKind"] {
  return kind === "format-repair" ? "format-repair" : "initial";
}

function governorAttemptKind(
  kind: ModelRequestAttemptIdentity["kind"],
): GovernedAttemptKind {
  if (kind === "transient-retry") return "retry";
  if (kind === "format-repair") return "repair";
  return "initial";
}

function executionAbortError(signal: AbortSignal | undefined) {
  return trustedExecutionAbortKind(signal) === "run-cancelled"
    ? new SkillRuntimeError("CANCELLED", "Skill execution was cancelled")
    : new SkillRuntimeError(
        "INTERRUPTED",
        "Skill execution was interrupted by infrastructure",
      );
}

function throwIfExecutionAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw executionAbortError(signal);
}
