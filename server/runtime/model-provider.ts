import type { z } from "zod";

import type { StructuredResponseFormat } from "./structured-response-format";
import type { SafeValidationIssue } from "./safe-validation-issues";
import { freezeSafeValidationIssues } from "./safe-validation-issues";
import type { GovernedAttemptKind } from "../db/concurrency-control-repository";
import type { ModelProviderReasonCode } from "../../shared/agent-contracts";

export interface StructuredGenerationRequest<T> {
  model: string;
  instructions: string;
  input: unknown;
  outputSchema: z.ZodType<T>;
  canonicalizeOutput?: (candidate: unknown) => unknown;
  responseFormat: StructuredResponseFormat;
  maxOutputTokens: number;
  timeoutMs: number;
  signal?: AbortSignal;
  governorScope?: Readonly<{
    organizationId: string;
    jobId: string;
    attemptKind: GovernedAttemptKind;
  }>;
}

export interface StructuredGenerationResult<T> {
  value: T;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
}

export type ModelProviderUsage = Omit<
  StructuredGenerationResult<unknown>,
  "value"
>;

export interface ModelProvider {
  generateStructured<T>(
    request: StructuredGenerationRequest<T>,
  ): Promise<StructuredGenerationResult<T>>;
}

export type ModelProviderErrorKind =
  | "transient"
  | "permanent"
  | "timeout"
  | "aborted"
  | "refusal"
  | "incomplete"
  | "empty"
  | "invalid_output";

export type ModelValidationDiagnostic = Readonly<
  | { stage: 'response-envelope'; code: 'invalid_envelope' }
  | { stage: 'json'; code: 'invalid_json'; contentLength?: number; startsWithFence?: boolean; parseError?: 'unexpected-end' | 'unexpected-token' | 'invalid-syntax'; position?: number; finishReason?: 'stop' | 'completed' }
  | { stage: 'schema'; code: 'contract_mismatch' }
  | { stage: 'semantic'; code: 'evidence_mismatch' }
  | { stage: 'sdk'; code: 'sdk_parse_failed' }
>;

export function safeModelValidationDiagnostic(value: unknown): ModelValidationDiagnostic | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const {stage,code}=value as Record<string,unknown>;
  if (stage === 'json' && code === 'invalid_json') {
    const raw=value as Record<string,unknown>;
    const contentLength=typeof raw.contentLength==='number' && Number.isSafeInteger(raw.contentLength) && raw.contentLength>=0 ? raw.contentLength : undefined;
    const position=typeof raw.position==='number' && Number.isSafeInteger(raw.position) && raw.position>=0 && contentLength!==undefined && raw.position<=contentLength ? raw.position : undefined;
    return Object.freeze({stage,code,
      ...(contentLength!==undefined?{contentLength}:{}),
      ...(typeof raw.startsWithFence==='boolean'?{startsWithFence:raw.startsWithFence}:{}),
      ...(typeof raw.parseError==='string' && ['unexpected-end','unexpected-token','invalid-syntax'].includes(raw.parseError)?{parseError:raw.parseError as 'unexpected-end'|'unexpected-token'|'invalid-syntax'}:{}),
      ...(position!==undefined?{position}:{}),
      ...(raw.finishReason==='stop'||raw.finishReason==='completed'?{finishReason:raw.finishReason}:{}),
    });
  }
  if ((stage==='response-envelope' && code==='invalid_envelope') ||
      (stage==='json' && code==='invalid_json') ||
      (stage==='schema' && code==='contract_mismatch') ||
      (stage==='semantic' && code==='evidence_mismatch') ||
      (stage==='sdk' && code==='sdk_parse_failed')) {
    return Object.freeze({stage,code}) as ModelValidationDiagnostic;
  }
  return undefined;
}

export class ModelProviderError extends Error {
  readonly usage?: Readonly<ModelProviderUsage>;
  readonly validationIssues?: readonly SafeValidationIssue[];
  readonly reasonCode?: ModelProviderReasonCode;
  readonly validationDiagnostic?: ModelValidationDiagnostic;

  constructor(
    readonly kind: ModelProviderErrorKind,
    message: string,
    options?: ErrorOptions & {
      usage?: ModelProviderUsage;
      validationIssues?: readonly SafeValidationIssue[];
      validationJsonSchema?: Readonly<Record<string, unknown>>;
      reasonCode?: ModelProviderReasonCode;
      validationDiagnostic?: ModelValidationDiagnostic;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ModelProviderError";
    this.usage = options?.usage
      ? Object.freeze({ ...options.usage })
      : undefined;
    this.validationIssues = options?.validationIssues
      ? freezeSafeValidationIssues(
        options.validationIssues,
        options.validationJsonSchema ?? {},
      )
      : undefined;
    this.reasonCode = options?.reasonCode;
    this.validationDiagnostic = safeModelValidationDiagnostic(options?.validationDiagnostic);
  }
}
