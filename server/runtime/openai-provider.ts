import OpenAI from "openai";
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
      const response = await this.client.responses.create(
        {
          model: request.model,
          instructions: request.instructions,
          input,
          max_output_tokens: request.maxOutputTokens,
          store: false,
          text: {
            format: request.responseFormat.format,
          },
        },
        {
          timeout: request.timeoutMs,
          signal: request.signal,
          maxRetries: 0,
        },
      );
      const usage = validatedResponseUsage(response);

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
      let outputValue: unknown;
      try {
        outputValue = JSON.parse(outputText);
      } catch (error) {
        throw new ModelProviderError(
          "invalid_output",
          "OpenAI structured output was not valid JSON",
          {
            cause: error instanceof Error ? error : undefined,
            usage,
          },
        );
      }
      const parsed = request.outputSchema.safeParse(outputValue);
      if (!parsed.success) {
        throw new ModelProviderError(
          "invalid_output",
          "OpenAI structured output failed runtime Zod validation",
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
