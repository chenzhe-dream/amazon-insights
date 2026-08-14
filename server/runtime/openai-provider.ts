import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";

import {
  ModelProviderError,
  type ModelProvider,
  type StructuredGenerationRequest,
} from "./model-provider";

interface OpenAIProviderOptions {
  apiKey?: string;
  client?: Pick<OpenAI, "responses">;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown OpenAI provider error";
}

export function classifyOpenAIError(error: unknown): ModelProviderError {
  if (error instanceof ModelProviderError) return error;
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
  return new ModelProviderError("permanent", errorMessage(error), {
    cause: error instanceof Error ? error : undefined,
  });
}

function findRefusal(output: unknown): string | undefined {
  if (!Array.isArray(output)) return undefined;
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
        const refusal = (part as { refusal?: unknown }).refusal;
        return typeof refusal === "string" ? refusal : "Model refused the request";
      }
    }
  }
  return undefined;
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
        throw new ModelProviderError(
          "incomplete",
          `OpenAI response was incomplete${response.incomplete_details?.reason ? `: ${response.incomplete_details.reason}` : ""}`,
        );
      }
      if (response.status !== "completed" || response.error) {
        const kind = TRANSIENT_RESPONSE_ERROR_CODES.has(
          response.error?.code ?? "",
        )
          ? "transient"
          : "permanent";
        throw new ModelProviderError(
          kind,
          `OpenAI response failed${response.error?.message ? `: ${response.error.message}` : ""}`,
          response.usage
            ? {
                usage: {
                  responseId: response.id,
                  inputTokens: response.usage.input_tokens,
                  outputTokens: response.usage.output_tokens,
                },
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
      const refusal = findRefusal(response.output);
      if (refusal) {
        throw new ModelProviderError("refusal", `OpenAI model refusal: ${refusal}`);
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
      const parsed = request.outputSchema.safeParse(response.output_parsed);
      if (!parsed.success) {
        throw new ModelProviderError(
          "invalid_output",
          "OpenAI parsed output failed runtime Zod validation",
          {
            cause: parsed.error,
            usage: {
              responseId: response.id,
              inputTokens: response.usage.input_tokens,
              outputTokens: response.usage.output_tokens,
            },
          },
        );
      }

      return {
        value: parsed.data,
        responseId: response.id,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      };
    } catch (error) {
      throw classifyOpenAIError(error);
    }
  }
}
