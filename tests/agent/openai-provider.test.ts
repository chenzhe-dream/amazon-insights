import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from 'node:fs';
import { MarketShapeSuggestionOutputSchema } from '../../shared/market-semantic-contracts';

import OpenAI from "openai";
import { z } from "zod";

import { canonicalJsonSha256 } from "../../server/runtime/model-request-accounting";
import { ModelProviderError } from "../../server/runtime/model-provider";
import {
  OpenAIProvider,
  classifyOpenAIError,
} from "../../server/runtime/openai-provider";
import { createStructuredResponseFormat } from "../../server/runtime/structured-response-format";

const outputSchema = z.object({ summary: z.string() }).strict();
const validationIssueSchema = z
  .object({
    summary: z.string(),
    nested: z.object({ kind: z.literal("allowed") }).strict(),
  })
  .strict();

function completedResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_openai_fake",
    status: "completed",
    error: null,
    incomplete_details: null,
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

type CompletedChatOverrides = {
  id?: unknown;
  choice?: {
    finish_reason?: unknown;
    message?: {
      role?: unknown;
      content?: unknown;
      tool_calls?: unknown;
    };
  };
  usage?: unknown;
};

function completedChat(overrides: CompletedChatOverrides = {}) {
  const choice = overrides.choice ?? {};
  const message = choice.message ?? {};
  return {
    id: Object.hasOwn(overrides, "id") ? overrides.id : "chatcmpl_fake",
    choices: [
      {
        finish_reason: Object.hasOwn(choice, "finish_reason")
          ? choice.finish_reason
          : "stop",
        message: {
          role: Object.hasOwn(message, "role") ? message.role : "assistant",
          content: Object.hasOwn(message, "content")
            ? message.content
            : '{"summary":"structured result"}',
          ...(Object.hasOwn(message, "tool_calls")
            ? { tool_calls: message.tool_calls }
            : {}),
        },
      },
    ],
    usage: Object.hasOwn(overrides, "usage")
      ? overrides.usage
      : { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
  };
}

function request() {
  return {
    model: "configured-model",
    instructions: "Use only the supplied facts.",
    input: { asins: ["B000000001"] },
    outputSchema,
    responseFormat: createStructuredResponseFormat(
      outputSchema,
      "VocPositioningOutput@1.0.0",
    ),
    maxOutputTokens: 500,
    timeoutMs: 2_000,
  };
}

function validationIssueRequest() {
  return {
    ...request(),
    outputSchema: validationIssueSchema,
    responseFormat: createStructuredResponseFormat(
      validationIssueSchema,
      "ValidationIssueOutput@1.0.0",
    ),
  };
}

test('opt-in market output limit enforcement retains actual usage and rejects both transport violations without another request',async()=>{
  for(const transport of ['responses-strict','relay-chat-json'] as const){
    let calls=0;
    const usage={inputTokens:40,outputTokens:8491};
    const invoke=async()=>{calls++;return transport==='responses-strict'
      ? completedResponse({usage:{input_tokens:usage.inputTokens,output_tokens:usage.outputTokens,total_tokens:8531}})
      : completedChat({usage:{prompt_tokens:usage.inputTokens,completion_tokens:usage.outputTokens,total_tokens:8531}});};
    const client={responses:{create:invoke},chat:{completions:{create:invoke}}} as unknown as NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]['client']>;
    const provider=new OpenAIProvider({client,transport,enforceOutputTokenLimit:true});
    await assert.rejects(provider.generateStructured(request()),(error:unknown)=>{
      assert.ok(error instanceof ModelProviderError);assert.equal(error.kind,'permanent');
      assert.equal(error.reasonCode,'OUTPUT_LIMIT_EXCEEDED');assert.equal(error.usage?.outputTokens,8491);return true;
    });
    assert.equal(calls,1);
  }
});

test('market Responses reasoning controls are explicit and opt-in',async()=>{
  let sent:Record<string,unknown>|undefined;
  const client={responses:{create:async(body:Record<string,unknown>)=>{sent=body;return completedResponse();}}} as unknown as NonNullable<ConstructorParameters<typeof OpenAIProvider>[0]['client']>;
  await new OpenAIProvider({client,responsesLowReasoning:true}).generateStructured(request());
  assert.deepEqual(sent?.reasoning,{effort:'low'});
  assert.equal((sent?.text as {verbosity:string}).verbosity,'low');
  await new OpenAIProvider({client}).generateStructured(request());
  assert.equal(sent?.reasoning,undefined);
  assert.equal((sent?.text as {verbosity?:string}).verbosity,undefined);
});

test('format failures expose closed stages without raw response contents', async () => {
  const sentinel='PRIVATE_RAW_RESPONSE';
  for (const transport of ['responses-strict','relay-chat-json'] as const) {
    for (const [text, expected] of [
      [`{${sentinel}`, {stage:'json',code:'invalid_json'}],
      [JSON.stringify({summary:42}), {stage:'schema',code:'contract_mismatch'}],
    ] as const) {
      const invoke=async()=>transport==='responses-strict'
        ? completedResponse({output:[{type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text}]}]})
        : completedChat({choice:{message:{content:text}}});
      const provider=new OpenAIProvider({transport,client:{responses:{create:invoke},chat:{completions:{create:invoke}}} as never});
      await assert.rejects(provider.generateStructured(request()),(error:unknown)=>{
        assert.ok(error instanceof ModelProviderError);
        assert.deepEqual(Reflect.get(error,'validationDiagnostic'),expected);
        assert.equal(error.usage?.outputTokens,10);
        assert.doesNotMatch(JSON.stringify(error),new RegExp(sentinel));return true;
      });
    }
  }
  const provider=new OpenAIProvider({transport:'relay-chat-json',client:{chat:{completions:{create:async()=>completedChat({choice:{finish_reason:'length'}})}}} as never});
  await assert.rejects(provider.generateStructured(request()),(error:unknown)=>{
    assert.ok(error instanceof ModelProviderError);
    assert.deepEqual(Reflect.get(error,'validationDiagnostic'),{stage:'response-envelope',code:'invalid_envelope'});return true;
  });
  const unsafe=new ModelProviderError('invalid_output','safe',{validationDiagnostic:{stage:sentinel,code:sentinel}} as never);
  assert.equal(Reflect.get(unsafe,'validationDiagnostic'),undefined);
  const sdkFailure=classifyOpenAIError(new SyntaxError(sentinel));
  assert.deepEqual(sdkFailure.validationDiagnostic,{stage:'sdk',code:'sdk_parse_failed'});
  assert.doesNotMatch(JSON.stringify(sdkFailure),new RegExp(sentinel));
});

test("Responses and relay retain declared nested validation paths", async () => {
  const rawSentinel = "RAW_NESTED_VALIDATION_VALUE";
  const invalidText = JSON.stringify({
    summary: "structured result",
    nested: { kind: rawSentinel },
  });
  const response = completedResponse({
    output: [{
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: invalidText, annotations: [] }],
    }],
  });
  const chat = completedChat({
    choice: { message: { content: invalidText } },
  });
  const providers = [
    new OpenAIProvider({ client: { responses: { create: async () => response } } as never }),
    new OpenAIProvider({
      apiKey: "test-key",
      transport: "relay-chat-json",
      baseUrl: "https://relay.example.test/v1",
      client: { chat: { completions: { create: async () => chat } } } as never,
    }),
  ];

  for (const provider of providers) {
    await assert.rejects(
      provider.generateStructured(validationIssueRequest()),
      (error: unknown) => {
        assert.ok(error instanceof ModelProviderError);
        assert.deepEqual(error.validationIssues, [
          { path: ["nested", "kind"], code: "invalid_value" },
        ]);
        assert.equal(JSON.stringify(error.validationIssues).includes(rawSentinel), false);
        return true;
      },
    );
  }
});

test("Responses and relay apply an optional canonicalizer before Zod validation", async () => {
  const response = completedResponse();
  const chat = completedChat();
  const providers = [
    new OpenAIProvider({ client: { responses: { create: async () => response } } as never }),
    new OpenAIProvider({
      apiKey: "test-key",
      transport: "relay-chat-json",
      baseUrl: "https://relay.example.test/v1",
      client: { chat: { completions: { create: async () => chat } } } as never,
    }),
  ];

  for (const provider of providers) {
    let canonicalized = 0;
    const result = await provider.generateStructured({
      ...request(),
      canonicalizeOutput: (candidate: unknown) => {
        canonicalized += 1;
        return { ...(candidate as { summary: string }), summary: "canonical" };
      },
    });
    assert.equal(canonicalized, 1);
    assert.deepEqual(result.value, { summary: "canonical" });
  }
});

test("OpenAI adapter uses Responses structured output without enabling tools", async () => {
  let body: Record<string, unknown> | undefined;
  let options: Record<string, unknown> | undefined;
  const client = {
    responses: {
      create: async (receivedBody: unknown, receivedOptions: unknown) => {
        body = receivedBody as Record<string, unknown>;
        options = receivedOptions as Record<string, unknown>;
        return completedResponse();
      },
    },
  };
  const provider = new OpenAIProvider({ client: client as never });
  const generationRequest = request();

  const result = await provider.generateStructured(generationRequest);

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
  assert.equal("reasoning_effort" in (body ?? {}), false);
  assert.equal("verbosity" in (body ?? {}), false);
  const sentFormat = (body?.text as { format?: unknown })?.format;
  assert.deepEqual(sentFormat, generationRequest.responseFormat.format);
  assert.equal("messages" in (body ?? {}), false);
  assert.equal(
    generationRequest.responseFormat.digest,
    canonicalJsonSha256(sentFormat),
  );
  assert.equal(options?.timeout, 2_000);
  assert.equal(options?.maxRetries, 0);
});

test("relay adapter sends Chat JSON mode and shares validation", async () => {
  let body: Record<string, unknown> | undefined;
  let options: Record<string, unknown> | undefined;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    transport: "relay-chat-json",
    baseUrl: "https://relay.example.test/v1",
    client: {
      responses: { create: async () => assert.fail("Responses must not be called") },
      chat: {
        completions: {
          create: async (receivedBody: unknown, receivedOptions: unknown) => {
            body = receivedBody as Record<string, unknown>;
            options = receivedOptions as Record<string, unknown>;
            return completedChat();
          },
        },
      },
    } as never,
  });

  const generationRequest = {
    ...request(),
    input: {
      asins: ["B000000001"],
      inputOnlySentinel: "relay-user-payload-only",
    },
  };
  const result = await provider.generateStructured(generationRequest);

  assert.deepEqual(result, {
    value: { summary: "structured result" },
    responseId: "chatcmpl_fake",
    inputTokens: 40,
    outputTokens: 10,
  });
  assert.equal(body?.model, "configured-model");
  const messages = body?.messages as Array<{ role: string; content: string }>;
  assert.deepEqual(messages[0], {
    role: "system",
    content: "Use only the supplied facts.",
  });
  assert.deepEqual(messages[2], {
    role: "user",
    content: JSON.stringify(generationRequest.input),
  });
  const relayInstruction = JSON.parse(messages[1]?.content ?? "") as {
    instruction: string;
    schemaName: string;
    schema: Record<string, unknown>;
  };
  assert.equal(
    relayInstruction.instruction,
    "Return only one JSON object that conforms exactly to this schema.",
  );
  assert.equal(
    relayInstruction.schemaName,
    generationRequest.responseFormat.format.name,
  );
  assert.deepEqual(
    relayInstruction.schema,
    generationRequest.responseFormat.format.schema,
  );
  assert.deepEqual(relayInstruction.schema.required, ["summary"]);
  assert.equal(relayInstruction.schema.additionalProperties, false);
  assert.equal(messages[1]?.content.includes("inputOnlySentinel"), false);
  assert.notDeepEqual(messages, [
    { role: "system", content: "Use only the supplied facts." },
    { role: "user", content: JSON.stringify(generationRequest.input) },
  ]);
  const sentFormat = body?.response_format as {
    type?: unknown;
    json_schema?: {
      name?: unknown;
      strict?: unknown;
      schema?: Record<string, unknown>;
    };
  };
  assert.equal(sentFormat?.type, "json_schema");
  assert.equal(
    sentFormat?.json_schema?.name,
    generationRequest.responseFormat.format.name,
  );
  assert.equal(sentFormat?.json_schema?.strict, true);
  assert.equal(
    sentFormat?.json_schema?.schema,
    generationRequest.responseFormat.format.schema,
  );
  assert.deepEqual(sentFormat?.json_schema?.schema?.required, ["summary"]);
  assert.equal(sentFormat?.json_schema?.schema?.additionalProperties, false);
  assert.notDeepEqual(sentFormat, { type: "json_object" });
  assert.equal(body?.max_completion_tokens, 500);
  assert.equal(body?.reasoning_effort, "low");
  assert.equal(body?.verbosity, "low");
  assert.equal(options?.timeout, 2_000);
  assert.equal(options?.maxRetries, 0);
});

test("relay adapter rejects malformed completed Chat output", async () => {
  for (const response of [
    completedChat({ choice: { message: { content: "not json" } } }),
    completedChat({ choice: { message: { content: '{"other":true}' } } }),
    completedChat({ choice: { message: { tool_calls: [{ id: "call_1" }] } } }),
    completedChat({ choice: { finish_reason: "length" } }),
  ]) {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      transport: "relay-chat-json",
      baseUrl: "https://relay.example.test/v1",
      client: {
        chat: { completions: { create: async () => response } },
      } as never,
    });
    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.kind === "invalid_output" &&
        error.usage?.responseId === "chatcmpl_fake" &&
        error.usage.inputTokens === 40 &&
        error.usage.outputTokens === 10,
    );
  }

  const malformedUsageProvider = new OpenAIProvider({
    apiKey: "test-key",
    transport: "relay-chat-json",
    baseUrl: "https://relay.example.test/v1",
    client: {
      chat: {
        completions: {
          create: async () =>
            completedChat({
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 },
            }),
        },
      },
    } as never,
  });
  await assert.rejects(
    malformedUsageProvider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "permanent" &&
      error.usage === undefined,
  );
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
      }),
      kind: "incomplete",
    },
    {
      response: completedResponse({
        output: [
          {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "refusal", refusal: "cannot comply" }],
          },
        ],
      }),
      kind: "refusal",
    },
    {
      response: completedResponse({ output: [] }),
      kind: "empty",
    },
    {
      response: completedResponse({
        status: "failed",
        error: { code: "invalid_prompt", message: "generation failed" },
      }),
      kind: "permanent",
    },
  ] as const;

  for (const { response, kind } of cases) {
    const provider = new OpenAIProvider({
      client: {
        responses: { create: async () => response },
      } as never,
    });
    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.kind === kind &&
        error.usage?.responseId === "resp_openai_fake" &&
        error.usage.inputTokens === 40 &&
        error.usage.outputTokens === 10,
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
          create: async () =>
            completedResponse({
              status: "failed",
              error: { code, message: "temporary response failure" },
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

test("OpenAI adapter parses raw JSON and revalidates it with the runtime Zod schema", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () =>
          completedResponse({
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: '{"wrong":true}',
                    annotations: [],
                  },
                ],
              },
            ],
          }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "invalid_output" &&
      error.usage?.inputTokens === 40 &&
      error.usage.outputTokens === 10,
  );
});

test("OpenAI adapter attaches usage to local JSON and Zod parse failures", async () => {
  for (const text of ['{"summary":', '{"wrong":true}']) {
    const provider = new OpenAIProvider({
      client: {
        responses: {
          create: async () =>
            completedResponse({
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [{ type: "output_text", text, annotations: [] }],
                },
              ],
            }),
        },
      } as never,
    });

    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.kind === "invalid_output" &&
        error.usage?.responseId === "resp_openai_fake" &&
        error.usage.inputTokens === 40 &&
        error.usage.outputTokens === 10 &&
        (error.cause instanceof SyntaxError || error.cause instanceof z.ZodError),
    );
  }
});

test("Responses and relay share bounded safe validation issues", async () => {
  const rawSentinel = "RAW_VOC_SENTINEL_DO_NOT_LOG";
  const invalidOutput = JSON.stringify({
    summary: 9,
    nested: { kind: rawSentinel },
  });
  const providers = [
    new OpenAIProvider({
      client: {
        responses: {
          create: async () =>
            completedResponse({
              output: [
                {
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: invalidOutput, annotations: [] },
                  ],
                },
              ],
            }),
        },
      } as never,
    }),
    new OpenAIProvider({
      apiKey: "test-key",
      transport: "relay-chat-json",
      baseUrl: "https://relay.example.test/v1",
      client: {
        chat: {
          completions: {
            create: async () =>
              completedChat({ choice: { message: { content: invalidOutput } } }),
          },
        },
      } as never,
    }),
  ];
  const issues: unknown[] = [];

  for (const provider of providers) {
    await assert.rejects(
      provider.generateStructured(validationIssueRequest()),
      (error: unknown) => {
        assert.ok(error instanceof ModelProviderError);
        assert.equal(error.kind, "invalid_output");
        const metadata = (error as ModelProviderError & {
          validationIssues?: unknown;
        }).validationIssues;
        assert.deepEqual(metadata, [
          { path: ["summary"], code: "invalid_type", expected: "string" },
          { path: ["nested", "kind"], code: "invalid_value" },
        ]);
        assert.equal(JSON.stringify(metadata).includes(rawSentinel), false);
        assert.equal(Object.isFrozen(metadata), true);
        issues.push(metadata);
        return true;
      },
    );
  }

  assert.deepEqual(issues[0], issues[1]);
});

test("malformed JSON has no validation issues", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () =>
          completedResponse({
            output: [
              {
                type: "message",
                role: "assistant",
                status: "completed",
                content: [
                  { type: "output_text", text: '{"summary":', annotations: [] },
                ],
              },
            ],
          }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "invalid_output" &&
      (error as ModelProviderError & { validationIssues?: unknown })
        .validationIssues === undefined,
  );
});

test("OpenAI adapter rejects missing usage instead of fabricating provenance", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () => completedResponse({ usage: undefined }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "empty" &&
      error.usage === undefined,
  );
});

test("OpenAI adapter rejects unsafe or inconsistent token usage", async () => {
  for (const usage of [
    { input_tokens: 1.5, output_tokens: 10, total_tokens: 11.5 },
    {
      input_tokens: Number.MAX_SAFE_INTEGER + 1,
      output_tokens: 0,
      total_tokens: Number.MAX_SAFE_INTEGER + 1,
    },
    { input_tokens: 40, output_tokens: 10, total_tokens: 49 },
  ]) {
    const provider = new OpenAIProvider({
      client: {
        responses: {
          create: async () => completedResponse({ usage }),
        },
      } as never,
    });

    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        error.kind === "permanent" &&
        error.message === "OpenAI response contained invalid usage metadata" &&
        error.usage === undefined,
    );
  }
});

test("OpenAI adapter rejects unexpected tool-call output even though tools are disabled", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () =>
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
      error instanceof ModelProviderError &&
      error.kind === "permanent" &&
      error.usage?.inputTokens === 40 &&
      error.usage.outputTokens === 10,
  );
});

test("OpenAI adapter rejects non-completed message output with actual usage", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () =>
          completedResponse({
            output: [
              {
                type: "message",
                role: "assistant",
                status: "incomplete",
                content: [
                  {
                    type: "output_text",
                    text: '{"summary":"partial"}',
                    annotations: [],
                  },
                ],
              },
            ],
          }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "permanent" &&
      error.usage?.responseId === "resp_openai_fake",
  );
});

test("transport failures before a Response never fabricate usage", async () => {
  const transportError = new OpenAI.APIConnectionError({
    message: "connection failed before a response",
  });
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () => {
          throw transportError;
        },
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "transient" &&
      error.usage === undefined,
  );
});

test("invalid Response identity never borrows otherwise valid usage", async () => {
  const provider = new OpenAIProvider({
    client: {
      responses: {
        create: async () => completedResponse({ id: "" }),
      },
    } as never,
  });

  await assert.rejects(
    provider.generateStructured(request()),
    (error: unknown) =>
      error instanceof ModelProviderError &&
      error.kind === "permanent" &&
      error.message === "OpenAI response contained invalid identity metadata" &&
      error.usage === undefined,
  );
});

test("OpenAI SDK errors expose only a bounded HTTP reason", () => {
  const rateLimit = new OpenAI.APIError(429, undefined, "limited", undefined);
  const serverError = new OpenAI.APIError(503, undefined, "unavailable", undefined);
  const badRequest = new OpenAI.APIError(400, undefined, "bad request", undefined);
  const unauthenticated = new OpenAI.APIError(401, undefined, "secret auth body", undefined);
  const forbidden = new OpenAI.APIError(403, undefined, "secret forbidden body", undefined);

  const classified = [
    [classifyOpenAIError(rateLimit), "transient", "HTTP_RATE_LIMITED"],
    [classifyOpenAIError(serverError), "transient", "HTTP_UPSTREAM_UNAVAILABLE"],
    [classifyOpenAIError(badRequest), "permanent", "HTTP_REQUEST_REJECTED"],
    [classifyOpenAIError(unauthenticated), "permanent", "HTTP_AUTHENTICATION"],
    [classifyOpenAIError(forbidden), "permanent", "HTTP_AUTHENTICATION"],
  ] as const;

  for (const [error, kind, reasonCode] of classified) {
    assert.equal(error.kind, kind);
    assert.equal(Reflect.get(error, "reasonCode"), reasonCode);
    assert.doesNotMatch(JSON.stringify(error), /secret auth body|secret forbidden body/);
  }
});

test("OpenAI adapter never exposes upstream error, response, or refusal text", async () => {
  const secret = "sk-secret-echo-from-input";
  const rawError = new Error(secret);
  const classified = classifyOpenAIError(rawError);
  assert.equal(classified.message, "OpenAI provider request failed");
  assert.equal(classified.cause, rawError);
  assert.doesNotMatch(classified.message, new RegExp(secret));

  const responses = [
    completedResponse({
      status: "failed",
      error: { code: "invalid_prompt", message: secret },
    }),
    completedResponse({
      output: [
        {
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "refusal", refusal: secret }],
        },
      ],
    }),
  ];

  for (const response of responses) {
    const provider = new OpenAIProvider({
      client: {
        responses: { create: async () => response },
      } as never,
    });
    await assert.rejects(
      provider.generateStructured(request()),
      (error: unknown) =>
        error instanceof ModelProviderError &&
        !error.message.includes(secret),
    );
  }
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

test("native schema mode sends the schema once and still validates output",async()=>{
 let body: {messages:unknown[];response_format:{json_schema:{schema:unknown}}};
 const provider=new OpenAIProvider({transport:'relay-chat-json',schemaPromptMode:'native',client:{chat:{completions:{create:async(b:unknown)=>{body=b as typeof body;return completedChat();}}}} as never});
 const r=await provider.generateStructured(request());assert.equal(r.value.summary,'structured result');assert.equal(body!.messages.length,2);assert.deepEqual(body!.response_format.json_schema.schema,request().responseFormat.format.schema);
});

test('market prompt-and-native mode sends the exact schema in Responses instructions while preserving legacy modes', async () => {
  const shapeRequest = { ...request(), outputSchema: MarketShapeSuggestionOutputSchema,
    responseFormat: createStructuredResponseFormat(MarketShapeSuggestionOutputSchema, 'MarketShapeSuggestionOutput@1.0.0') };
  for (const mode of ['prompt-and-native', 'native', 'duplicated'] as const) {
    let body: Record<string, unknown> = {};
    const provider = new OpenAIProvider({ schemaPromptMode: mode, deferOutputValidation: true,
      client: { responses: { create: async (value: unknown) => { body = value as typeof body; return completedResponse(); } } } as never });
    await provider.generateStructured(shapeRequest);
    assert.deepEqual((body.text as { format: unknown }).format, shapeRequest.responseFormat.format);
    if (mode === 'prompt-and-native') {
      const instructions = body.instructions as string;
      assert.ok(instructions.startsWith(`${shapeRequest.instructions}\n\n`));
      const appendix = JSON.parse(instructions.slice(shapeRequest.instructions.length + 2));
      assert.deepEqual(appendix.schema, shapeRequest.responseFormat.format.schema);
      assert.ok(appendix.schema.properties.products);
    } else assert.equal(body.instructions, shapeRequest.instructions);
  }
});

test('market single-fence opt-in accepts only an entire fenced JSON object and retains schema validation', async () => {
  const invoke = async (text: string, allowSingleJsonFence: boolean) => {
    const response = completedResponse(); response.output[0].content[0].text = text;
    return new OpenAIProvider({ allowSingleJsonFence, client: { responses: { create: async () => response } } as never }).generateStructured(request());
  };
  for (const text of ['```json\n{"summary":"ok"}\n```', ' \n```\n{"summary":"ok"}\n```\n ']) {
    assert.equal((await invoke(text, true)).value.summary, 'ok');
    await assert.rejects(invoke(text, false), ModelProviderError);
  }
  for (const text of ['Here:\n```json\n{"summary":"ok"}\n```', '```json\n{"summary":"ok"}\n```\nDone',
    '```json\n{"summary":"ok"}\n```\n```json\n{}\n```', '```json\n[]\n```', '```json\nnull\n```',
    '```javascript\n{"summary":"ok"}\n```', '```json\n{"wrong":"ok"}\n```']) {
    await assert.rejects(invoke(text, true), ModelProviderError);
  }
});

test('saved real relay result remains invalid after fence unwrap; never map results to products', async () => {
  const fixture = JSON.parse(readFileSync('tests/fixtures/market-shape-relay-wrong-schema-20260917.json', 'utf8')) as { outputText: string };
  const response = completedResponse(); response.output[0].content[0].text = fixture.outputText;
  const provider = new OpenAIProvider({ allowSingleJsonFence: true, client: { responses: { create: async () => response } } as never });
  await assert.rejects(provider.generateStructured({ ...request(), outputSchema: MarketShapeSuggestionOutputSchema,
    responseFormat: createStructuredResponseFormat(MarketShapeSuggestionOutputSchema, 'MarketShapeSuggestionOutput@1.0.0') }), error => {
      assert.ok(error instanceof ModelProviderError);
      assert.equal(error.kind, 'invalid_output');
      assert.ok(error.validationIssues?.some(issue => issue.path?.[0] === 'products' && issue.code === 'invalid_type'));
      return true;
    });
});
