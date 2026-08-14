import type { z } from "zod";

export interface StructuredGenerationRequest<T> {
  model: string;
  instructions: string;
  input: unknown;
  outputSchema: z.ZodType<T>;
  outputSchemaName: string;
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

  constructor(
    readonly kind: ModelProviderErrorKind,
    message: string,
    options?: ErrorOptions & { usage?: ModelProviderUsage },
  ) {
    super(message, { cause: options?.cause });
    this.name = "ModelProviderError";
    this.usage = options?.usage
      ? Object.freeze({ ...options.usage })
      : undefined;
  }
}
