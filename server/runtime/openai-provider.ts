import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { ZodError } from "zod";

import {
  ModelProviderError,
  type ModelProvider,
  type ModelProviderUsage,
  type StructuredGenerationRequest,
} from "./model-provider";

interface OpenAIProviderOptions {
  apiKey?: string;
  client?: Pick<OpenAI, "responses">;
}

export function classifyOpenAIError(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
  if (error instanceof SyntaxError || error instanceof ZodError) {
    return new ModelProviderError(
      "invalid_output",
      "OpenAI structured output could not be parsed",
      { cause: error },
    );
  }
  if (error instanceof OpenAI.APIUserAbortError) {
    return new ModelProviderError("aborted", "OpenAI request was aborted", {
      cause: error,
    });
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
      { cause: error },
    );
  }
  return new ModelProviderError("permanent", "OpenAI provider request failed", {
    cause: error instanceof Error ? error : undefined,
  });
}

function hasRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) return false;
  for (const item of output) {
    if (!item || typeof item !== "object") continue;
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (
        part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "refusal"
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasUnexpectedOutputItem(output: unknown) {
  if (!Array.isArray(output)) return true;
  return output.some((item) => {
    if (!item || typeof item !== "object") return true;
    const type = (item as { type?: unknown }).type;
    return type !== "message" && type !== "reasoning";
  });
}

function formatName(value: string) {
  const normalized = value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  return normalized || "structured_output";
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

function validatedUsage(
  responseId: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  },
): ModelProviderUsage {
  const { input_tokens: inputTokens, output_tokens: outputTokens } = usage;
  const totalTokens = inputTokens + outputTokens;
  if (
    !Number.isSafeInteger(inputTokens) ||
    inputTokens < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    outputTokens < 0 ||
    !Number.isSafeInteger(totalTokens) ||
    !Number.isSafeInteger(usage.total_tokens) ||
    usage.total_tokens < 0 ||
    usage.total_tokens !== totalTokens
  ) {
    throw new ModelProviderError(
      "permanent",
      "OpenAI response contained invalid usage metadata",
    );
  }
  return { responseId, inputTokens, outputTokens };
}

export class OpenAIProvider implements ModelProvider {
  private readonly client: Pick<OpenAI, "responses">;

  constructor(options: OpenAIProviderOptions) {
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
    this.client = new OpenAI({ apiKey: options.apiKey, maxRetries: 0 });
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
      const response = await this.client.responses.parse(
        {
          model: request.model,
          instructions: request.instructions,
          input,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: zodTextFormat(
              request.outputSchema,
              formatName(request.outputSchemaName),
            ),
          },
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
          maxRetries: 0,
        },
      );

      if (response.status === "incomplete") {
        const reason = safeIncompleteReason(response.incomplete_details?.reason);
        throw new ModelProviderError(
          "incomplete",
          `OpenAI response was incomplete${reason ? `: ${reason}` : ""}`,
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
          response.usage
            ? {
                usage: validatedUsage(response.id, response.usage),
              }
            : undefined,
        );
      }
      if (hasUnexpectedOutputItem(response.output)) {
        throw new ModelProviderError(
          "permanent",
          "OpenAI response contained an unexpected tool or control output item",
        );
      }
      if (hasRefusal(response.output)) {
        throw new ModelProviderError("refusal", "OpenAI model refused the request");
      }
      if (response.output_parsed === null) {
        throw new ModelProviderError("empty", "OpenAI response contained no parsed output");
      }
      if (!response.usage) {
        throw new ModelProviderError(
          "empty",
          "OpenAI response contained no usage metadata",
        );
      }
      const usage = validatedUsage(response.id, response.usage);
      const parsed = request.outputSchema.safeParse(response.output_parsed);
      if (!parsed.success) {
        throw new ModelProviderError(
          "invalid_output",
          "OpenAI parsed output failed runtime Zod validation",
          {
            cause: parsed.error,
            usage,
          },
        );
      }

      return {
        value: parsed.data,
        ...usage,
      };
    } catch (error) {
      throw classifyOpenAIError(error);
    }
  }
}
