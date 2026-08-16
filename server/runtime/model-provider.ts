import type { z } from "zod";

import type { StructuredResponseFormat } from "./structured-response-format";
import type { SafeValidationIssue } from "./safe-validation-issues";
import { freezeSafeValidationIssues } from "./safe-validation-issues";

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

export class ModelProviderError extends Error {
  readonly usage?: Readonly<ModelProviderUsage>;
  readonly validationIssues?: readonly SafeValidationIssue[];

  constructor(
    readonly kind: ModelProviderErrorKind,
    message: string,
    options?: ErrorOptions & {
      usage?: ModelProviderUsage;
      validationIssues?: readonly SafeValidationIssue[];
      validationJsonSchema?: Readonly<Record<string, unknown>>;
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
  }
}
