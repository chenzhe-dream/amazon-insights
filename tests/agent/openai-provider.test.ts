import assert from "node:assert/strict";
import test from "node:test";

import OpenAI from "openai";
import { z } from "zod";

import { ModelProviderError } from "../../server/runtime/model-provider";
import {
  OpenAIProvider,
  classifyOpenAIError,
} from "../../server/runtime/openai-provider";

const outputSchema = z.object({ summary: z.string() }).strict();

function completedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_openai_fake",
    status: "completed",
    error: null,
    incomplete_details: null,
    output_parsed: { summary: "structured result" },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: '{"summary":"structured result"}',
            annotations: [],
            parsed: { summary: "structured result" },
          },
        ],
      },
    ],
    usage: {
      input_tokens: 40,
      output_tokens: 10,
      total_tokens: 50,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
    ...overrides,
  };
}

function request() {
  return {
    model: "configured-model",
    instructions: "Use only the supplied facts.",
    input: { asins: ["B000000001"] },
    outputSchema,
    outputSchemaName: "VocPositioningOutput_1_0_0",
    maxOutputTokens: 500,
    timeoutMs: 2_000,
  };
}

test("OpenAI adapter uses Responses structured output without enabling tools", async () => {
  let body: Record<string, unknown> | undefined;
  let options: Record<string, unknown> | undefined;
  const client = {
    responses: {
      parse: async (receivedBody: unknown, receivedOptions: unknown) => {
        body = receivedBody as Record<string, unknown>;
        options = receivedOptions as Record<string, unknown>;
        return completedResponse();
      },
    },
  };
  const provider = new OpenAIProvider({ client: client as never });

  const result = await provider.generateStructured(request());

  assert.deepEqual(result, {
    value: { summary: "structured result" },
    responseId: "resp_openai_fake",
    inputTokens: 40,
    outputTokens: 10,
  });
  assert.equal(body?.model, "configured-model");
  assert.equal(body?.instructions, "Use only the supplied facts.");
  assert.equal(body?.max_output_tokens, 500);
  assert.equal(body?.store, false);
  assert.equal("tools" in (body ?? {}), false);
  assert.equal("tool_choice" in (body ?? {}), false);
  assert.equal(typeof (body?.text as { format?: unknown })?.format, "object");
  assert.equal(options?.timeout, 2_000);
  assert.equal(options?.maxRetries, 0);
});

test("OpenAI adapter requires an explicit API key when no client is injected", () => {
  assert.throws(
    () => new OpenAIProvider({ apiKey: "" }),
    /OpenAI API key is not configured/i,
  );
});

test("OpenAI adapter rejects incomplete, refusal, empty, and failed responses", async () => {
  const cases = [
    {
      response: completedResponse({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output_parsed: null,
      }),
      kind: "incomplete",
    },
    {
      response: completedResponse({
        output_parsed: null,
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "cannot comply" }],
          },
        ],
      }),
      kind: "refusal",
    },
    {
      response: completedResponse({ output_parsed: null, output: [] }),
      kind: "empty",
    },
    {
      response: completedResponse({
        status: "failed",
        error: { code: "invalid_prompt", message: "generation failed" },
        output_parsed: null,
      }),
      kind: "permanent",
    },
  ] as const;

  for (const { response, kind } of cases) {
    const provider = new OpenAIProvider({
      client: {
        responses: { parse: async () => response },
      } as never,
    });
    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError && error.kind === kind,
    );
  }
});

test("failed Responses classify documented temporary codes as transient", async () => {
  for (const code of [
    "server_error",
    "rate_limit_exceeded",
    "vector_store_timeout",
  ]) {
    const provider = new OpenAIProvider({
      client: {
        responses: {
          parse: async () =>
            completedResponse({
              status: "failed",
              error: { code, message: "temporary response failure" },
              output_parsed: null,
            }),
        },
      } as never,
    });

    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.kind === "transient" &&
        error.usage?.responseId === "resp_openai_fake" &&
        error.usage.inputTokens === 40 &&
        error.usage.outputTokens === 10,
    );
  }
});

test("OpenAI adapter revalidates parsed output with the runtime Zod schema", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        parse: async () => completedResponse({ output_parsed: { wrong: true } }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError && error.kind === "invalid_output",
  );
});

test("OpenAI adapter rejects missing usage instead of fabricating provenance", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        parse: async () => completedResponse({ usage: undefined }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError && error.kind === "empty",
  );
});

test("OpenAI adapter rejects unexpected tool-call output even though tools are disabled", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        parse: async () =>
          completedResponse({
            output: [
              {
                type: "function_call",
                name: "undeclared_tool",
                arguments: "{}",
              },
            ],
          }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError && error.kind === "permanent",
  );
});

test("OpenAI SDK errors are classified for finite runtime retry", () => {
  const rateLimit = new OpenAI.APIError(429, undefined, "limited", undefined);
  const serverError = new OpenAI.APIError(503, undefined, "unavailable", undefined);
  const badRequest = new OpenAI.APIError(400, undefined, "bad request", undefined);

  assert.equal(classifyOpenAIError(rateLimit).kind, "transient");
  assert.equal(classifyOpenAIError(serverError).kind, "transient");
  assert.equal(classifyOpenAIError(badRequest).kind, "permanent");
});

test(
  "live OpenAI Responses smoke test is opt-in",
  { skip: process.env.OPENAI_LIVE_TEST !== "1" },
  async () => {
    const provider = new OpenAIProvider({ apiKey: process.env.OPENAI_API_KEY });
    const result = await provider.generateStructured({
      ...request(),
      model: process.env.OPENAI_MODEL ?? request().model,
      input: { instruction: "Return the word ok in the summary field." },
    });
    assert.equal(typeof result.value.summary, "string");
  },
);
