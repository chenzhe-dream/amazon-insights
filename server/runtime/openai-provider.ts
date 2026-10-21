import { createHash } from "node:crypto";
import OpenAI from "openai";
import { createModelDiagnosticFetch, type ModelNetworkDiagnostic } from './model-network-diagnostics';
import { ZodError } from "zod";

import type { VocProviderTransport } from "../config";
import {
  ResourceGovernorAdmissionError,
  type ResourceGovernor,
} from "../db/concurrency-control-repository";
import type { StrictJsonSchemaResponseFormat } from "./structured-response-format";
import { summarizeZodValidationIssues } from "./safe-validation-issues";
import {
  ModelProviderError,
  type ModelProvider,
  type ModelProviderUsage,
  type StructuredGenerationRequest,
} from "./model-provider";

export interface RelayJsonNormalizationDiagnostic {
  event: "relay_json_compatibility_applied";
  rule: "single-trailing-object-brace-v1";
  originalLength: number;
  normalizedLength: number;
  removedChars: 1;
  originalSha256: string;
  normalizedSha256: string;
  responseIdSha256: string;
  finishReason: "stop";
}

export interface OpenAIProviderOptions {
  /** Explicit relay compatibility; never applied to Responses or valid JSON. */
  allowSingleTrailingObjectBrace?: boolean;
  outputNormalizationLogger?: (entry: Readonly<RelayJsonNormalizationDiagnostic>) => void;
  /** Opt-in safe fetch phases. Injected clients own their transport instrumentation. */
  networkLogger?: (entry: ModelNetworkDiagnostic) => void;
  /** Market-only protocol policy; existing callers retain their current behavior. */
  responsesLowReasoning?: boolean;
  enforceOutputTokenLimit?: boolean;
  /** Only for runners that validate and repair before publishing. */
  deferOutputValidation?: boolean;
  schemaPromptMode?: "native" | "duplicated" | "prompt-and-native";
  /** Market compatibility only: a single whole-response JSON object fence, never prose extraction. */
  allowSingleJsonFence?: boolean;
  apiKey?: string;
  organizationId?: string;
  jobId?: string;
  resourceGovernor?: ResourceGovernor;
  transport?: VocProviderTransport;
  baseUrl?: string | null;
  client?: Pick<OpenAI, "responses" | "chat">;
}

export function classifyOpenAIError(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return new ModelProviderError(
      "invalid_output",
      "OpenAI structured output could not be parsed",
      { cause: error, validationDiagnostic: {stage:"sdk",code:"sdk_parse_failed"} },
    );
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return new ModelProviderError("aborted", "OpenAI request was aborted", {
      cause: error,
    });
  }
  if (
    error instanceof ResourceGovernorAdmissionError ||
    (error instanceof Error && error.name === "ResourceGovernorAdmissionError")
  ) {
    return new ModelProviderError(
      "transient",
      "Model request capacity is temporarily unavailable",
      { cause: error instanceof Error ? error : undefined },
    );
  }
  if (error instanceof OpenAI.APIConnectionTimeoutError) {
    return new ModelProviderError("timeout", "OpenAI request timed out", {
      cause: error,
    });
  }
  if (error instanceof OpenAI.APIConnectionError) {
    return new ModelProviderError(
      "transient",
      "OpenAI connection failed temporarily",
      { cause: error },
    );
  }
  if (error instanceof OpenAI.APIError) {
    const status = error.status;
    const transient =
      status === 408 ||
      status === 409 ||
      status === 429 ||
      (typeof status === "number" && status >= 500);
    return new ModelProviderError(
      transient ? "transient" : "permanent",
      `OpenAI request failed${status ? ` with status ${status}` : ""}`,
      {
        cause: error,
        reasonCode:
          status === 401 || status === 403
            ? "HTTP_AUTHENTICATION"
            : status === 429
              ? "HTTP_RATE_LIMITED"
              : status === 408 ||
                  status === 409 ||
                  (typeof status === "number" && status >= 500)
                ? "HTTP_UPSTREAM_UNAVAILABLE"
                : typeof status === "number" && status >= 400 && status < 500
                  ? "HTTP_REQUEST_REJECTED"
                  : undefined,
      },
    );
  }
  return new ModelProviderError("permanent", "OpenAI provider request failed", {
    cause: error instanceof Error ? error : undefined,
  });
}

const TRANSIENT_RESPONSE_ERROR_CODES = new Set([
  "server_error",
  "rate_limit_exceeded",
  "vector_store_timeout",
]);

const RESPONSE_ERROR_CODES = new Set([
  "server_error",
  "rate_limit_exceeded",
  "invalid_prompt",
  "data_residency_mismatch",
  "bio_policy",
  "vector_store_timeout",
  "invalid_image",
  "invalid_image_format",
  "invalid_base64_image",
  "invalid_image_url",
  "image_too_large",
  "image_too_small",
  "image_parse_error",
  "image_content_policy_violation",
  "invalid_image_mode",
  "image_file_too_large",
  "unsupported_image_media_type",
  "empty_image_file",
  "failed_to_download_image",
  "image_file_not_found",
]);

function safeResponseErrorCode(code: unknown) {
  return typeof code === "string" && RESPONSE_ERROR_CODES.has(code)
    ? code
    : undefined;
}

function safeIncompleteReason(reason: unknown) {
  return reason === "max_output_tokens" || reason === "content_filter"
    ? reason
    : undefined;
}

function validatedResponseUsage(response: {
  id?: unknown;
  usage?: unknown;
}): ModelProviderUsage {
  if (
    typeof response.id !== "string" ||
    response.id.trim().length === 0
  ) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid identity metadata",
    );
  }
  if (!response.usage || typeof response.usage !== "object") {
    throw new ModelProviderError(
      "empty",
      "OpenAI response contained no usage metadata",
    );
  }
  const usage = response.usage as Record<string, unknown>;
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;
  const reportedTotalTokens = usage.total_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid usage metadata",
    );
  }
  const totalTokens = inputTokens + outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(totalTokens) ||
    typeof reportedTotalTokens !== "number" ||
    !Number.isSafeInteger(reportedTotalTokens) ||
    reportedTotalTokens < 0 ||
    reportedTotalTokens !== totalTokens
  ) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid usage metadata",
    );
  }
  return { responseId: response.id, inputTokens, outputTokens };
}

function validatedChatUsage(completion: {
  id?: unknown;
  usage?: unknown;
}): ModelProviderUsage {
  if (
    typeof completion.id !== "string" ||
    completion.id.trim().length === 0
  ) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid identity metadata",
    );
  }
  if (!completion.usage || typeof completion.usage !== "object") {
    throw new ModelProviderError(
      "empty",
      "OpenAI response contained no usage metadata",
    );
  }
  const usage = completion.usage as Record<string, unknown>;
  const inputTokens = usage.prompt_tokens;
  const outputTokens = usage.completion_tokens;
  const reportedTotalTokens = usage.total_tokens;
  const totalTokens =
    typeof inputTokens === "number" && typeof outputTokens === "number"
      ? inputTokens + outputTokens
      : Number.NaN;
  if (
    typeof inputTokens !== "number" ||
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    typeof outputTokens !== "number" ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(totalTokens) ||
    typeof reportedTotalTokens !== "number" ||
    !Number.isSafeInteger(reportedTotalTokens) ||
    reportedTotalTokens < 0 ||
    reportedTotalTokens !== totalTokens
  ) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid usage metadata",
    );
  }
  return { responseId: completion.id, inputTokens, outputTokens };
}

function extractCompletedOutputText(
  output: unknown,
  usage: ModelProviderUsage,
) {
  if (!Array.isArray(output)) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained an unexpected output structure",
      { usage },
    );
  }
  const texts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== "object") {
      throw new ModelProviderError(
        "permanent",
        "OpenAI response contained an unexpected output structure",
        { usage },
      );
    }
    const outputItem = item as Record<string, unknown>;
    if (outputItem.type === "reasoning") continue;
    if (
      outputItem.type !== "message" ||
      outputItem.role !== "assistant" ||
      outputItem.status !== "completed" ||
      !Array.isArray(outputItem.content)
    ) {
      throw new ModelProviderError(
        "permanent",
        "OpenAI response contained an unexpected tool or control output item",
        { usage },
      );
    }
    for (const part of outputItem.content) {
      if (!part || typeof part !== "object") {
        throw new ModelProviderError(
          "permanent",
          "OpenAI response contained an unexpected output structure",
          { usage },
        );
      }
      const content = part as Record<string, unknown>;
      if (content.type === "refusal") {
        throw new ModelProviderError(
          "refusal",
          "OpenAI model refused the request",
          { usage },
        );
      }
      if (content.type !== "output_text" || typeof content.text !== "string") {
        throw new ModelProviderError(
          "permanent",
          "OpenAI response contained an unexpected output structure",
          { usage },
        );
      }
      texts.push(content.text);
    }
  }
  const text = texts.join("");
  if (text.length === 0) {
    throw new ModelProviderError(
      "empty",
      "OpenAI response contained no structured output",
      { usage },
    );
  }
  return text;
}

function extractCompletedChatOutputText(
  completion: { choices?: unknown },
  usage: ModelProviderUsage,
) {
  if (!Array.isArray(completion.choices) || completion.choices.length !== 1) {
    throw new ModelProviderError(
      "invalid_output",
      "OpenAI response contained an unexpected output structure",
      { usage, validationDiagnostic: {stage:"response-envelope",code:"invalid_envelope"} },
    );
  }
  const choice = completion.choices[0];
  if (!choice || typeof choice !== "object") {
    throw new ModelProviderError(
      "invalid_output",
      "OpenAI response contained an unexpected output structure",
      { usage, validationDiagnostic: {stage:"response-envelope",code:"invalid_envelope"} },
    );
  }
  const choiceRecord = choice as Record<string, unknown>;
  const message = choiceRecord.message;
  if (
    choiceRecord.finish_reason !== "stop" ||
    !message ||
    typeof message !== "object"
  ) {
    throw new ModelProviderError(
      "invalid_output",
      "OpenAI response contained an unexpected output structure",
      { usage, validationDiagnostic: {stage:"response-envelope",code:"invalid_envelope"} },
    );
  }
  const messageRecord = message as Record<string, unknown>;
  if (
    messageRecord.role !== "assistant" ||
    typeof messageRecord.content !== "string" ||
    messageRecord.content.length === 0 ||
    Object.hasOwn(messageRecord, "tool_calls")
  ) {
    throw new ModelProviderError(
      "invalid_output",
      "OpenAI response contained an unexpected output structure",
      { usage, validationDiagnostic: {stage:"response-envelope",code:"invalid_envelope"} },
    );
  }
  return messageRecord.content;
}

function parseStructuredOutput<T>(
  outputText: string,
  request: StructuredGenerationRequest<T>,
  usage: ModelProviderUsage,
  deferOutputValidation = false,
  allowSingleJsonFence = false,
  finishReason?: "stop" | "completed",
  trailingBrace?: { enabled: boolean; logger?: OpenAIProviderOptions["outputNormalizationLogger"] },
) {
  let outputValue: unknown;
  try {
    const fence = allowSingleJsonFence
      ? /^\s*```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```\s*$/.exec(outputText)
      : null;
    if (fence) {
      if (fence[1].includes('```')) throw new SyntaxError('Multiple code fences are not supported');
      outputValue = JSON.parse(fence[1]);
      if (outputValue === null || typeof outputValue !== 'object' || Array.isArray(outputValue)) {
        throw new SyntaxError('Fenced output must be an object');
      }
    } else outputValue = JSON.parse(outputText);
  } catch (error) {
    let recovered = false;
    if (trailingBrace?.enabled && finishReason === "stop") {
      const trimmed = outputText.trimEnd();
      if (trimmed.endsWith("}")) {
        const normalizedText = trimmed.slice(0, -1);
        try {
          const candidate = JSON.parse(normalizedText);
          if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) {
            outputValue = candidate;
            recovered = true;
            const hash = (text: string) => createHash("sha256").update(text).digest("hex");
            try {
              trailingBrace.logger?.(Object.freeze({event:"relay_json_compatibility_applied",rule:"single-trailing-object-brace-v1",
                originalLength:outputText.length,normalizedLength:normalizedText.length,removedChars:1,
                originalSha256:hash(outputText),normalizedSha256:hash(normalizedText),responseIdSha256:hash(usage.responseId),finishReason:"stop"}));
            } catch { /* Observability cannot change parsing or validation. */ }
          }
        } catch { /* Do not infer or repair any other malformed JSON. */ }
      }
    }
    if (!recovered) throw new ModelProviderError(
      "invalid_output",
      "OpenAI structured output was not valid JSON",
      {
        validationDiagnostic: {
          stage:"json",code:"invalid_json",contentLength:outputText.length,
          startsWithFence:/^\s*```/.test(outputText),
          parseError:error instanceof SyntaxError && /(?:unexpected end|unterminated)/i.test(error.message) ? "unexpected-end"
            : error instanceof SyntaxError && /unexpected token/i.test(error.message) ? "unexpected-token" : "invalid-syntax",
          ...(error instanceof SyntaxError && /position (\d+)/.test(error.message)
            ? {position:Number(/position (\d+)/.exec(error.message)![1])} : {}),
          ...(finishReason ? {finishReason} : {}),
        },
        cause: error instanceof Error ? error : undefined,
        usage,
      },
    );
  }
  if (deferOutputValidation) return { value: outputValue as T, ...usage };
  let normalized: unknown;
  try {
    normalized = request.canonicalizeOutput ? request.canonicalizeOutput(outputValue) : outputValue;
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    const issues = summarizeZodValidationIssues(error, request.responseFormat);
    throw new ModelProviderError("invalid_output", "OpenAI structured output failed runtime canonicalization", {
      usage, cause: error, validationIssues: issues,
      validationJsonSchema: request.responseFormat.format.schema,
      validationDiagnostic: issues.some(issue => issue.ruleId)
        ? { stage: "semantic", code: "evidence_mismatch" }
        : { stage: "schema", code: "contract_mismatch" },
    });
  }
  const parsed = request.outputSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new ModelProviderError(
      "invalid_output",
      "OpenAI structured output failed runtime Zod validation",
      {
        validationDiagnostic: {stage:"schema",code:"contract_mismatch"},
        cause: parsed.error,
        usage,
        validationIssues: summarizeZodValidationIssues(
          parsed.error,
          request.responseFormat,
        ),
        validationJsonSchema: request.responseFormat.format.schema,
      },
    );
  }
  return { value: parsed.data, ...usage };
}

export function createRelayJsonSchemaInstruction(
  format: StrictJsonSchemaResponseFormat,
) {
  return JSON.stringify({
    instruction: "Return only one JSON object that conforms exactly to this schema.",
    schemaName: format.name,
    schema: format.schema,
  });
}

export class OpenAIProvider implements ModelProvider {
  private readonly responsesLowReasoning: boolean;
  private readonly enforceOutputTokenLimit: boolean;
  private readonly deferOutputValidation: boolean;
  private readonly schemaPromptMode: "native" | "duplicated" | "prompt-and-native";
  private readonly allowSingleJsonFence: boolean;
  private readonly allowSingleTrailingObjectBrace: boolean;
  private readonly outputNormalizationLogger: OpenAIProviderOptions["outputNormalizationLogger"];
  private readonly client: Pick<OpenAI, "responses" | "chat">;
  private readonly transport: VocProviderTransport;
  private readonly organizationId: string | undefined;
  private readonly jobId: string | undefined;
  private readonly resourceGovernor: ResourceGovernor | undefined;

  constructor(options: OpenAIProviderOptions) {
    this.responsesLowReasoning = options.responsesLowReasoning ?? false;
    this.enforceOutputTokenLimit = options.enforceOutputTokenLimit ?? false;
    this.deferOutputValidation = options.deferOutputValidation ?? false;
    this.schemaPromptMode = options.schemaPromptMode ?? "duplicated";
    this.allowSingleJsonFence = options.allowSingleJsonFence ?? false;
    this.allowSingleTrailingObjectBrace = options.allowSingleTrailingObjectBrace ?? false;
    this.outputNormalizationLogger = options.outputNormalizationLogger;
    this.transport = options.transport ?? "responses-strict";
    this.organizationId = options.organizationId;
    this.jobId = options.jobId;
    this.resourceGovernor = options.resourceGovernor;
    if (options.client) {
      this.client = options.client;
      return;
    }
    if (!options.apiKey?.trim()) {
      throw new ModelProviderError(
        "permanent",
        "OpenAI API key is not configured",
      );
    }
    this.client = new OpenAI({
      apiKey: options.apiKey,
      baseURL: options.baseUrl ?? undefined,
      maxRetries: 0,
      ...(options.networkLogger ? { fetch: createModelDiagnosticFetch(globalThis.fetch, options.networkLogger) } : {}),
    });
  }

  async generateStructured<T>(request: StructuredGenerationRequest<T>) {
    let input: string;
    try {
      input = JSON.stringify(request.input);
    } catch (error) {
      throw new ModelProviderError(
        "permanent",
        "OpenAI input is not JSON serializable",
        { cause: error instanceof Error ? error : undefined },
      );
    }

    try {
      if (this.transport === "relay-chat-json") {
        const { name, strict, schema } = request.responseFormat.format;
        const completion = await this.runGovernedModelAttempt(request, () =>
          this.client.chat.completions.create(
          {
            model: request.model,
            messages: [
              { role: "system", content: request.instructions },
              ...(this.schemaPromptMode === "native" ? [] : [{
                role: "system" as const,
                content: createRelayJsonSchemaInstruction(request.responseFormat.format),
              }]),
              { role: "user", content: input },
            ],
            response_format: {
              type: "json_schema",
              json_schema: { name, strict, schema },
            },
            reasoning_effort: "low",
            verbosity: "low",
            max_completion_tokens: request.maxOutputTokens,
          },
          {
            timeout: request.timeoutMs,
            signal: request.signal,
            maxRetries: 0,
          },
        ));
        const usage = validatedChatUsage(completion);
        this.assertOutputLimit(request, usage);
        const outputText = extractCompletedChatOutputText(completion, usage);
        return parseStructuredOutput(outputText, request, usage, this.deferOutputValidation, this.allowSingleJsonFence, "stop", {enabled:this.allowSingleTrailingObjectBrace,logger:this.outputNormalizationLogger});
      }
      const response = await this.runGovernedModelAttempt(request, () =>
        this.client.responses.create(
        {
          model: request.model,
          instructions: this.schemaPromptMode === 'prompt-and-native'
            ? `${request.instructions}\n\n${createRelayJsonSchemaInstruction(request.responseFormat.format)}`
            : request.instructions,
          input,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          ...(this.responsesLowReasoning ? { reasoning: { effort: 'low' as const } } : {}),
          text: {
            format: request.responseFormat.format,
            ...(this.responsesLowReasoning ? { verbosity: 'low' as const } : {}),
          },
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
          maxRetries: 0,
        },
      ));
      const usage = validatedResponseUsage(response);
      this.assertOutputLimit(request, usage);

      if (response.status === "incomplete") {
        const reason = safeIncompleteReason(response.incomplete_details?.reason);
        throw new ModelProviderError(
          "incomplete",
          `OpenAI response was incomplete${reason ? `: ${reason}` : ""}`,
          { usage },
        );
      }
      if (response.status !== "completed" || response.error) {
        const code = safeResponseErrorCode(response.error?.code);
        const kind = TRANSIENT_RESPONSE_ERROR_CODES.has(code ?? "")
          ? "transient"
          : "permanent";
        throw new ModelProviderError(
          kind,
          `OpenAI response failed${code ? ` with code ${code}` : ""}`,
          { usage },
        );
      }
      const outputText = extractCompletedOutputText(response.output, usage);
      return parseStructuredOutput(outputText, request, usage, this.deferOutputValidation, this.allowSingleJsonFence, "completed");
    } catch (error) {
      throw classifyOpenAIError(error);
    }
  }

  private assertOutputLimit(request: StructuredGenerationRequest<unknown>, usage: ModelProviderUsage): void {
    if (this.enforceOutputTokenLimit && usage.outputTokens > request.maxOutputTokens) {
      // Preserve actual charges for settlement. A provider ignoring the cap is a
      // permanent protocol failure, never a reason to spend again on format repair.
      throw new ModelProviderError('permanent', 'Model provider exceeded the requested output token limit',
        { usage, reasonCode: 'OUTPUT_LIMIT_EXCEEDED' });
    }
  }

  private async runGovernedModelAttempt<T>(
    request: StructuredGenerationRequest<unknown>,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.resourceGovernor) return await operation();
    const scope = request.governorScope ??
      (this.organizationId && this.jobId
        ? {
            organizationId: this.organizationId,
            jobId: this.jobId,
            attemptKind: "initial" as const,
          }
        : null);
    if (!scope) {
      throw new ResourceGovernorAdmissionError();
    }
    return await this.resourceGovernor.run({
      organizationId: scope.organizationId,
      resource: "model",
      jobId: scope.jobId,
      attemptKind: scope.attemptKind,
      operation,
    });
  }
}
