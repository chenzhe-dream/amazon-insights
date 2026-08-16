# Relay Chat Completions JSON Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an explicit, fail-closed relay Chat Completions JSON-mode transport while preserving the official Responses strict JSON Schema default.

**Architecture:** Runtime configuration resolves a closed transport choice plus safe provider identity. The provider dispatches only that selected Responses or Chat request, then both paths use the existing JSON parse and declared Zod output schema. SkillRunner, budgets, Worker fencing, report persistence, and the one-format-repair rule stay shared.

**Tech Stack:** Node.js 24, TypeScript, OpenAI SDK 7.4, Zod, SQLite, Node test runner through tsx.

## Global Constraints

- Work inline in C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution on branch feat/voc-positioning-skill-execution; do not create subagents or another worktree.
- Do not add dependencies or modify package-lock.json, migrations 0001-0005, generated VOC data, user runtime WIP, project JSON, or stash.
- Do not push, merge, rebase, amend, reset, checkout, stash, or run product-data sync.
- AGENT_VOC_TRANSPORT accepts only responses-strict and relay-chat-json; an omitted value resolves to responses-strict.
- Default Responses behavior remains strict json_schema. Relay Chat mode is explicit and never an automatic fallback after schema, provider, timeout, budget, or capability failure.
- relay-chat-json requires an HTTPS OPENAI_BASE_URL without credentials, query, or fragment. Invalid relay config returns the existing fixed safe configuration error.
- Both paths retain timeout, abort, SDK maxRetries: 0, existing budget reservations, and at most one same-transport format-repair request.
- Both paths must JSON-parse and Zod-validate the declared output schema. JSON mode itself is not validation success.
- Include transport and SHA-256 digest of canonical base URL in providerName, which is already part of the execution/request fingerprint. Never store or log the raw base URL.
- Keep AGENT_VOC_LOCAL_FAKE=1 unchanged. Real relay requests are opt-in and bounded; never print key, token, prompt, VOC text, or raw completion.

---

## File Structure and Interfaces

| File | Responsibility |
| --- | --- |
| server/config.ts | Resolve closed transport/base-URL configuration into immutable VOC runtime config. |
| server/runtime/openai-provider.ts | Adapt selected Responses strict or Chat JSON request to ModelProvider.generateStructured. |
| server/runtime/safe-validation-issues.ts | Define the bounded, frozen diagnostics shared by repair instructions and validation-failure telemetry. |
| server/runtime/skill-runner.ts | Execute the one-repair loop and emit only safe validation-failure telemetry. |
| server/runtime/voc-positioning-runtime.ts | Build the default OpenAIProvider with resolved transport/base URL through an injectable production provider factory, then pass its safe providerName to SkillRunner. |
| server/agent-service.ts | Adapt safe SkillRunner validation telemetry to the existing Fastify/Pino logger, with an injectable in-memory test seam. |
| server/runtime/model-request-accounting.ts | Reuse or add only a small SHA-256 string identity helper. |
| tests/agent/voc-positioning-runtime.test.ts | Runtime config resolution, runtime construction, fixture regression. |
| tests/agent/openai-provider.test.ts | Transport payloads, parse/Zod validation, safe error and usage mapping. |
| tests/agent/model-request-accounting.test.ts | Fingerprint drift assertion for the safe provider identity. |
| tests/agent/skill-runner-persistent-budget.test.ts | Persistent repair and reservation assertions. |
| tests/agent/skill-runner.test.ts | One-repair validation telemetry, raw-data exclusion, and best-effort logger behavior. |

Exact introduced interfaces:

~~~
export type VocProviderTransport =
  | "responses-strict"
  | "relay-chat-json";

export interface VocPositioningRuntimeConfig {
  apiKey: string;
  providerName: string;
  transport: VocProviderTransport;
  baseUrl: string | null;
  model: ModelExecutionConfig;
  budgetLimits: ModelBudgetLimits;
  worker: {
    ownerId: string;
    leaseDurationMs: number;
    heartbeatIntervalMs: number;
    pollIntervalMs: number;
    stopTimeoutMs: number;
    retryPolicy: {
      maxAttempts: number;
      initialDelayMs: number;
      maxDelayMs: number;
      jitterRatio: number;
    };
  };
}

export interface OpenAIProviderOptions {
  apiKey?: string;
  transport?: VocProviderTransport;
  baseUrl?: string | null;
  client?: Pick<OpenAI, "responses" | "chat">;
}

export interface VocPositioningRuntimeOptions {
  repository: SqliteAgentRepository;
  config: VocPositioningRuntimeConfig;
  provider?: ModelProvider;
  providerFactory?: (options: OpenAIProviderOptions) => ModelProvider;
  providerName?: string;
  skillsRoot?: string;
  clock?: () => Date;
  workerClock?: WorkerClock;
  logger?: WorkerLogger;
  validationLogger?: ModelValidationLogger;
}

export interface ModelValidationFailureLog {
  readonly event: "model_validation_failed";
  readonly attemptKind: "initial" | "format-repair";
  readonly issueCount: number;
  readonly issues: readonly SafeValidationIssue[];
}

export type ModelValidationLogger =
  (entry: Readonly<ModelValidationFailureLog>) => void;
~~~

The existing signature remains unchanged:

~~~
generateStructured<T>(
  request: StructuredGenerationRequest<T>,
): Promise<StructuredGenerationResult<T>>
~~~

providerName is openai:responses-strict for the default and
openai:relay-chat-json:<64-hex-digest> for relay mode.

## Implementation Preflight Guard

Run these commands before Task 1. They prove that implementation starts in the
approved linked worktree without staging or normalizing the pre-existing runtime
WIP:

~~~powershell
$expected = [System.IO.Path]::GetFullPath((Resolve-Path "C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution").Path)
$actual = [System.IO.Path]::GetFullPath((Resolve-Path ((git rev-parse --show-toplevel).Trim())).Path)
if (-not [string]::Equals($actual, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "wrong worktree: $actual"
}
if (-not (Test-Path .git -PathType Leaf)) { throw "expected linked worktree .git file" }
if ((git branch --show-current).Trim() -ne "feat/voc-positioning-skill-execution") { throw "wrong branch" }
git worktree list --porcelain
git submodule status --recursive
git status --short
~~~

Expected: the target is a linked worktree on
`feat/voc-positioning-skill-execution`; any listed submodules remain at their
recorded commits; `git status` may show only the known user runtime WIP and
project JSON, which must not be staged or changed.

Run the focused baseline before adding Task 1 tests:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts tests/agent/skill-runner-persistent-budget.test.ts
~~~

Expected: PASS. If this baseline fails, record the exact existing failure and
stop before implementation; do not attribute an unrelated pre-existing failure
to the relay slice.

### Task 1: Resolve explicit fail-closed transport configuration

**Files:**

- Modify: server/config.ts:40-130, 220-335
- Modify: server/runtime/model-request-accounting.ts
- Modify: tests/agent/voc-positioning-runtime.test.ts:1-235

**Consumes:** loadVocPositioningRuntimeConfig(env) and resolveVocPositioningRuntimeConfig(env).

**Produces:** VocProviderTransport plus frozen transport, baseUrl, and providerName fields on VocPositioningRuntimeConfig.

- [ ] **Step 1: Write the failing configuration tests**

Add these cases beside the existing config tests. Use the existing complete
validRuntimeEnv() helper.

~~~
test("VOC transport defaults to Responses strict", () => {
  const config = loadVocPositioningRuntimeConfig(validRuntimeEnv());
  assert.equal(config.transport, "responses-strict");
  assert.equal(config.providerName, "openai:responses-strict");
  assert.equal(config.baseUrl, null);
});

test("relay transport requires and canonicalizes HTTPS base URL", () => {
  const config = loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_TRANSPORT: "relay-chat-json",
    OPENAI_BASE_URL: "https://relay.example.test/v1/",
  });
  assert.equal(config.transport, "relay-chat-json");
  assert.equal(config.baseUrl, "https://relay.example.test/v1");
  assert.match(config.providerName, /^openai:relay-chat-json:[a-f0-9]{64}$/);
});

for (const invalid of [
  { AGENT_VOC_TRANSPORT: "unknown" },
  { AGENT_VOC_TRANSPORT: "relay-chat-json" },
  { AGENT_VOC_TRANSPORT: "relay-chat-json", OPENAI_BASE_URL: "http://relay.example.test/v1" },
  { AGENT_VOC_TRANSPORT: "relay-chat-json", OPENAI_BASE_URL: "https://user:pass@relay.example.test/v1" },
]) {
  test("invalid relay config fails closed", () => {
    assert.throws(
      () => loadVocPositioningRuntimeConfig({ ...validRuntimeEnv(), ...invalid }),
      /VOC positioning runtime configuration/i,
    );
  });
}
~~~

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "VOC transport defaults|relay transport requires|invalid relay config" tests/agent/voc-positioning-runtime.test.ts
~~~

Expected: FAIL because transport, baseUrl, providerName, and relay validation do not exist.

- [ ] **Step 3: Implement minimal configuration resolution**

In server/config.ts add a closed resolver and include its result in the frozen config:

~~~
export type VocProviderTransport =
  | "responses-strict"
  | "relay-chat-json";

function resolveVocProviderTransport(env: AgentEnvironment): {
  transport: VocProviderTransport;
  baseUrl: string | null;
  providerName: string;
} {
  const transport = env.AGENT_VOC_TRANSPORT ?? "responses-strict";
  if (transport === "responses-strict") {
    return {
      transport,
      baseUrl: null,
      providerName: "openai:responses-strict",
    };
  }
  if (transport !== "relay-chat-json") {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const url = new URL(requiredRuntimeText(env.OPENAI_BASE_URL));
  if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash) {
    throw new Error(VOC_RUNTIME_CONFIGURATION_ERROR);
  }
  const baseUrl = url.toString().replace(/\/$/, "");
  return {
    transport,
    baseUrl,
    providerName: "openai:relay-chat-json:" + sha256Hex(baseUrl),
  };
}
~~~

Use the existing canonical SHA-256 implementation if it accepts a string; otherwise
add only sha256Hex(value: string): string in model-request-accounting.ts. Do not
alter numeric, budget, worker, or local-fake parsing.

- [ ] **Step 4: Run GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/voc-positioning-runtime.test.ts
~~~

Expected: PASS, including existing runtime config boundary tests.

- [ ] **Step 5: Commit Task 1**

~~~powershell
git add server/config.ts server/runtime/model-request-accounting.ts tests/agent/voc-positioning-runtime.test.ts
git commit -m "feat(voc): configure explicit relay transport"
~~~

Expected: only listed changed files are committed; .env.local and user WIP are not staged.

### Task 2: Add selected Chat JSON transport behind OpenAIProvider

**Files:**

- Modify: server/runtime/openai-provider.ts:10-322
- Modify: tests/agent/openai-provider.test.ts:1-500

**Consumes:** Task 1 VocProviderTransport/baseUrl and unchanged StructuredGenerationRequest<T>.

**Produces:** unchanged StructuredGenerationResult<T> after shared JSON parse and Zod validation.

- [ ] **Step 1: Write failing provider tests**

Add a completedChat helper with one assistant choice, matching safe usage, and no
raw data output. Its only overrides are explicit nested choice/message and usage
fields, so malformed values always reach `choices[0]` or `usage` rather than
being silently added to the top-level completion object. Add:

~~~
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
    choices: [{
      finish_reason: Object.hasOwn(choice, "finish_reason")
        ? choice.finish_reason
        : "stop",
      message: {
        role: Object.hasOwn(message, "role") ? message.role : "assistant",
        content: Object.hasOwn(message, "content")
          ? message.content
          : "{\"summary\":\"structured result\"}",
        ...(Object.hasOwn(message, "tool_calls")
          ? { tool_calls: message.tool_calls }
          : {}),
      },
    }],
    usage: Object.hasOwn(overrides, "usage")
      ? overrides.usage
      : { prompt_tokens: 40, completion_tokens: 10, total_tokens: 50 },
  };
}

function makeRelay(response: unknown): OpenAIProvider {
  return new OpenAIProvider({
    apiKey: "test-key",
    transport: "relay-chat-json",
    baseUrl: "https://relay.example.test/v1",
    client: { chat: { completions: { create: async () => response } } } as never,
  });
}

test("relay adapter sends Chat JSON mode and shares validation", async () => {
  let body: Record<string, unknown> | undefined;
  const provider = new OpenAIProvider({
    apiKey: "test-key",
    transport: "relay-chat-json",
    baseUrl: "https://relay.example.test/v1",
    client: {
      responses: { create: async () => assert.fail("Responses must not be called") },
      chat: { completions: { create: async (received: unknown) => {
        body = received as Record<string, unknown>;
        return completedChat({
          choice: { message: { content: "{\"summary\":\"structured result\"}" } },
        });
      } } },
    } as never,
  });

  const result = await provider.generateStructured(request());
  assert.deepEqual(result.value, { summary: "structured result" });
  assert.deepEqual(body?.response_format, { type: "json_object" });
  assert.equal(body?.max_completion_tokens, 500);
});

test("relay adapter rejects malformed completed Chat output", async () => {
  for (const response of [
    completedChat({ choice: { message: { content: "not json" } } }),
    completedChat({ choice: { message: { content: "{\"other\":true}" } } }),
    completedChat({ choice: { message: { tool_calls: [{ id: "call_1" }] } } }),
    completedChat({ choice: { finish_reason: "length" } }),
    completedChat({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 99 } }),
  ]) {
    await assert.rejects(
      makeRelay(response).generateStructured(request()),
      (error: unknown) => error instanceof ModelProviderError &&
        error.kind === "invalid_output",
    );
  }
});
~~~

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "relay adapter" tests/agent/openai-provider.test.ts
~~~

Expected: FAIL because OpenAIProviderOptions lacks transport/baseUrl and has no Chat implementation.

- [ ] **Step 3: Implement the minimal selected transport**

Keep the current Responses method intact. Choose exactly one path by
options.transport ?? "responses-strict". Construct SDK client explicitly:

~~~
new OpenAI({
  apiKey: options.apiKey,
  baseURL: options.baseUrl ?? undefined,
  maxRetries: 0,
});
~~~

The relay branch is:

~~~
const completion = await this.client.chat.completions.create(
  {
    model: request.model,
    messages: [
      { role: "system", content: request.instructions },
      { role: "user", content: JSON.stringify(request.input) },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: request.maxOutputTokens,
  },
  {
    timeout: request.timeoutMs,
    signal: request.signal,
    maxRetries: 0,
  },
);
return parseChatStructuredCompletion(completion, request.outputSchema);
~~~

parseChatStructuredCompletion must require a nonempty completion id; exactly one
choice with finish_reason "stop"; assistant role; nonempty string content; no
tool_calls; safe nonnegative prompt_tokens/completion_tokens/total_tokens whose
total is their sum. It must JSON.parse content and schema.safeParse exactly as
the Responses path does. JSON, schema, missing-content, tool-call, and
non-stop-choice failures are ModelProviderError("invalid_output", ...).
Malformed identity/usage is permanent. Never expose raw content in errors.

- [ ] **Step 4: Run GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts
~~~

Expected: PASS. Existing strict Responses tests prove default preservation;
new tests prove JSON mode, no default fallback, maxRetries zero, safe usage, and
shared fail-closed validation.

- [ ] **Step 5: Commit Task 2**

~~~powershell
git add server/runtime/openai-provider.ts tests/agent/openai-provider.test.ts
git commit -m "feat(voc): add relay chat json provider"
~~~

Expected: only the provider and its focused tests are committed.

### Task 3: Wire relay identity through runtime and persistent budget tests

**Files:**

- Modify: server/runtime/voc-positioning-runtime.ts:35-65
- Modify: tests/agent/voc-positioning-runtime.test.ts
- Modify: tests/agent/model-request-accounting.test.ts

**Consumes:** Task 1 resolved config and Task 2 OpenAIProviderOptions.

**Produces:** a production `providerFactory` seam for observable selected
transport/base-URL provider construction and existing SkillRunner providerName
fingerprint binding.

In `tests/agent/voc-positioning-runtime.test.ts`, extend the existing imports
with `type VocPositioningRuntimeConfig` from `server/config`, `type
OpenAIProviderOptions` from `server/runtime/openai-provider`, and
`createVocPositioningRuntime` from `server/runtime/voc-positioning-runtime`.
The test already imports `ModelProvider`, `mkdtempSync`, `rmSync`, `join`, and
`openSqliteAgentRepository`.

- [ ] **Step 1: Write failing runtime and drift tests**

~~~
function relayRuntimeConfig(): VocPositioningRuntimeConfig {
  return loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_TRANSPORT: "relay-chat-json",
    OPENAI_BASE_URL: "https://relay.example.test/v1",
  });
}

test("runtime passes resolved relay options to its provider factory", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "amazon-voc-relay-runtime-"));
  const repository = openSqliteAgentRepository({
    path: join(directory, "agent.sqlite"),
    busyTimeoutMs: 5_000,
  });
  t.after(() => {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const config = relayRuntimeConfig();
  let captured: OpenAIProviderOptions | undefined;
  const runtime = await createVocPositioningRuntime({
    repository,
    config,
    providerFactory: (options) => {
      captured = options;
      return {
        generateStructured: async () => {
          throw new Error("provider must not execute while constructing runtime");
        },
      } as ModelProvider;
    },
  });
  assert.equal(Boolean(captured?.apiKey?.trim()), true);
  assert.equal(captured?.transport, "relay-chat-json");
  assert.equal(captured?.baseUrl, "https://relay.example.test/v1");
  assert.match(config.providerName, /^openai:relay-chat-json:[a-f0-9]{64}$/);
  await runtime.stop();
});

test("relay transport identity changes the persistent request fingerprint", () => {
  const shared = identity();
  const relay = createModelRequestFingerprint({
    ...shared,
    provider: "openai:relay-chat-json:" + "a".repeat(64),
  });
  const strict = createModelRequestFingerprint({
    ...shared,
    provider: "openai:responses-strict",
  });
  assert.notEqual(relay, strict);
});
~~~

The runtime test captures the actual production-construction options without
printing the API key or making a network request. The factory exists for normal
runtime composition (custom provider construction), while an explicit
`provider` still has precedence. The fingerprint test uses the exact existing
canonical input fixture, so a transport or base-URL change cannot silently match
a prior persistent request identity.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "runtime passes resolved relay|relay transport identity changes" tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: FAIL because VocPositioningRuntimeOptions does not yet accept or call
providerFactory, so `captured` remains unavailable. The fingerprint test is
already a regression guard for safe relay provider identity.

- [ ] **Step 3: Implement minimum runtime wiring**

Add the production composition seam, preserving explicit provider precedence:

~~~
const providerFactory = options.providerFactory ?? ((providerOptions) =>
  new OpenAIProvider(providerOptions));
const provider = options.provider ?? providerFactory({
  apiKey: options.config.apiKey,
  transport: options.config.transport,
  baseUrl: options.config.baseUrl,
});
const providerName = options.providerName ?? options.config.providerName;
~~~

Do not change Worker, claim, retry, report, budget, or local-fixture APIs. The
factory is a legitimate runtime composition dependency, not a test-only branch;
it is never called when an explicit provider is supplied.
SkillRunner already sends providerName to createModelRequestFingerprint, so the
Task 1 digest binds transport/base URL without retaining the raw URL.

- [ ] **Step 4: Run GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS, including existing fake-provider, claim/lease, retry, and
persistent-budget regression tests.

- [ ] **Step 5: Commit Task 3**

~~~powershell
git add server/runtime/voc-positioning-runtime.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
git commit -m "feat(voc): bind relay transport to execution identity"
~~~

Expected: only runtime wiring and focused test files are committed.

### Task 4: Prove one repair, fixture regression, and bounded relay smoke

**Files:**

- Modify: tests/agent/skill-runner-persistent-budget.test.ts
- Modify: tests/agent/openai-provider.test.ts only if an assertion required by this task is absent.
- Do not modify production files unless a RED test proves a direct Task 1–3 defect.

**Consumes:** Tasks 1–3 and existing SkillRunner/budget fixture helpers.

**Produces:** deterministic proof of one same-transport repair and a safe,
one-run real smoke procedure.

- [ ] **Step 1: Write failing one-repair/no-fallback test**

~~~
test("relay identity invalid output makes one repair then fails", async () => {
  const provider = new FakeProvider(async () => ({
    value: { wrong: true },
    responseId: "resp_invalid",
    inputTokens: 10,
    outputTokens: 5,
  }));
  const skillRunner = await runner(repository, provider);
  await assert.rejects(
    skillRunner.run(request(), context(subject)),
    /MODEL_OUTPUT_ERROR|invalid structured output/i,
  );
  assert.equal(provider.requests.length, 2);
});
~~~

Also add a valid-first-response case asserting exactly one call and a schema-valid
immutable fixture result. Inspect model_budget_reservations with the existing
DatabaseSync pattern and assert exactly two rows: initial with format_repair 0,
then format-repair with format_repair 1. Assert no transient-retry row. Task 2
already proves the relay provider never calls Responses.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "relay identity invalid output|relay valid output" tests/agent/skill-runner-persistent-budget.test.ts
~~~

Expected: FAIL because the relay provider-name fixture and two-row repair
assertion do not yet exist.

- [ ] **Step 3: Implement only the test seam**

Extend the persistent test runner helper, not production routing, with an
optional providerName and pass it in the RED test as
runner(repository, provider, limits(), { providerName: "openai:relay-chat-json:" + "a".repeat(64) }):

~~~
async function runner(repository, provider, configuredLimits = limits(), options = {}) {
  const runner = new SkillRunner({
  registry,
  provider,
  providerName: options.providerName ?? "fake",
  budgetCoordinator,
  });
  return runner;
}
~~~

Use persisted model_budget_reservations attempt_kind to observe initial then
format-repair. Do not add a runtime fallback switch: the current loop already
permits one format-repair only after invalid_output.

- [ ] **Step 4: Run GREEN deterministic fixture suite**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS with no service process and no relay network traffic.

- [ ] **Step 5: Run one compatibility probe after focused tests and explicit cost approval**

Use ignored .env.local with AGENT_VOC_TRANSPORT=relay-chat-json. Run one project
SDK Chat Completions request through node --use-env-proxy --env-file=.env.local:

~~~
{
  model: process.env.AGENT_VOC_MODEL,
  messages: [
    { role: "system", content: "Return only a JSON object." },
    { role: "user", content: "Return {\"ok\":true}." },
  ],
  response_format: { type: "json_object" },
  max_completion_tokens: 16,
}
~~~

Set timeout to 60000 and maxRetries to 0. Record only SDK/HTTP status, request
ID, elapsed time, and usage. Require exactly one assistant choice with string
content, then assert `JSON.parse(content)` deep-equals `{ ok: true }`. If the
request, response shape, or parse assertion fails, stop and do not start Agent.

- [ ] **Step 6: Run one real relay smoke only after probe success and explicit cost approval**

Start one hidden Agent with AGENT_VOC_LOCAL_FAKE=0 and
AGENT_VOC_RETRY_MAX_ATTEMPTS=1:

~~~powershell
node --use-env-proxy --env-file=.env.local --import tsx server/index.ts
~~~

Submit exactly one existing-data VOC request for
B07VY9Q95Q,B0BPXRVWYK,B07DYG1C9B. Poll only its returned runId and read reports
once after terminal status. Assert one physical Worker attempt, at most initial
plus format-repair provider calls, and one immutable report or a persisted fixed
safe error. Stop the captured Agent PID and verify port 31901 is free. Never
create a replacement run or automatic retry.

- [ ] **Step 7: Commit Task 4**

~~~powershell
git add tests/agent/skill-runner-persistent-budget.test.ts tests/agent/openai-provider.test.ts
git commit -m "test(voc): cover relay repair boundary"
~~~

Expected: only focused test files are committed. .env.local, logs, SQLite runtime
data, and smoke artifacts remain ignored/uncommitted.

### Task 5: Give the relay its declared response contract

**Files:**

- Modify: `server/runtime/openai-provider.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-relay-chat-completions-json-mode.md`

**Consumes:** The immutable `request.responseFormat.format` already built by
`createStructuredResponseFormat`; its `name` and `schema` are the sole schema
artifact used by both transports.

**Produces:** `createRelayJsonSchemaInstruction(format: StrictJsonSchemaResponseFormat): string`, a deterministic JSON-only system-message body.  It serializes a fixed envelope with `instruction`, `schemaName`, and `schema`; it does not receive or serialize `request.input`.

- [ ] **Step 1: Write the failing transport-boundary test**

In `tests/agent/openai-provider.test.ts`, make the relay test use an input
containing a unique `inputOnlySentinel`, capture `body.messages`, and assert:

~~~ts
const messages = body?.messages as Array<{ role: string; content: string }>;
assert.deepEqual(messages[0], {
  role: "system",
  content: "Use only the supplied facts.",
});
assert.deepEqual(messages[2], {
  role: "user",
  content: JSON.stringify(generationRequest.input),
});
const relayInstruction = JSON.parse(messages[1].content) as {
  instruction: string;
  schemaName: string;
  schema: Record<string, unknown>;
};
assert.equal(relayInstruction.instruction, "Return only one JSON object that conforms exactly to this schema.");
assert.equal(relayInstruction.schemaName, generationRequest.responseFormat.format.name);
assert.deepEqual(relayInstruction.schema, generationRequest.responseFormat.format.schema);
assert.deepEqual(relayInstruction.schema.required, ["summary"]);
assert.equal(relayInstruction.schema.additionalProperties, false);
assert.equal(messages[1].content.includes("inputOnlySentinel"), false);
~~~

Keep the existing default Responses test and add the explicit invariant:

~~~ts
assert.deepEqual(body?.text, { format: generationRequest.responseFormat.format });
assert.equal("messages" in (body ?? {}), false);
~~~

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "relay adapter sends Chat JSON mode|uses Responses structured output" tests/agent/openai-provider.test.ts
~~~

Expected: FAIL because relay currently sends only the original system prompt and
the user JSON, so `messages[1]` is the user message rather than the declared
schema instruction.

- [ ] **Step 3: Implement the deterministic, shared-artifact helper**

In `server/runtime/openai-provider.ts`, import `StrictJsonSchemaResponseFormat`
as a type and add:

~~~ts
function createRelayJsonSchemaInstruction(
  format: StrictJsonSchemaResponseFormat,
) {
  return JSON.stringify({
    instruction: "Return only one JSON object that conforms exactly to this schema.",
    schemaName: format.name,
    schema: format.schema,
  });
}
~~~

Use it only in the selected relay message list:

~~~ts
messages: [
  { role: "system", content: request.instructions },
  { role: "system", content: createRelayJsonSchemaInstruction(request.responseFormat.format) },
  { role: "user", content: input },
],
~~~

Do not alter the default Responses payload, `parseStructuredOutput`, Zod
validation, request timeout, `maxRetries: 0`, or repair/fallback semantics.

- [ ] **Step 4: Run GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts
~~~

Expected: PASS. The relay test proves the exact schema artifact, name,
`required`, and `additionalProperties` arrive in a JSON-only system message
without raw input; the default test proves strict Responses payload stability.

- [ ] **Step 5: Run the focused relay suite and commit**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS with no service process and no network traffic. Then commit only:

~~~powershell
git add server/runtime/openai-provider.ts tests/agent/openai-provider.test.ts
git commit -m "feat(voc): guide relay with declared schema"
~~~

The plan-document update must be committed first, before the RED test or
production change, as a separate non-amend commit.

- [ ] **Step 6: Make one nested-schema capability probe and one bounded smoke**

After Task 5 tests pass, use the ignored `.env.local` relay configuration to
make one Chat Completions request with a representative nested JSON Schema in
the same second system-message envelope. Require exactly one stopped assistant
choice with string content; JSON-parse it and assert the nested object, required
key, and `additionalProperties: false` contract. Use `maxRetries: 0` and a
60-second timeout. Record only safe HTTP/status/request-id/latency/usage facts.

Only if that probe succeeds, start one hidden real-mode Agent with physical
retry 1, submit exactly one new existing-data VOC run, poll that run only, and
read its reports once at terminal state. If output remains invalid, stop and
read at most ten safe Zod path/type issues from existing telemetry; do not retry
or broaden the schema. On either terminal path stop the captured process and
verify port 31901 is free.

### Task 6: Bound relay reasoning and response verbosity

**Files:**

- Modify: `server/runtime/openai-provider.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-relay-chat-completions-json-mode.md`

**Consumes:** The explicit `relay-chat-json` transport selected in Task 1 and
the successful one-off relay capability probe for `gpt-5.5` with
`reasoning_effort: "low"` and `verbosity: "low"`.

**Produces:** A relay-only Chat request that explicitly limits model reasoning
and output verbosity. The default Responses strict request remains byte-for-byte
equivalent in its body fields.

- [ ] **Step 1: Write the failing transport-boundary assertions**

In the existing relay provider test, add:

~~~ts
assert.equal(body?.reasoning_effort, "low");
assert.equal(body?.verbosity, "low");
~~~

In the default Responses test, add:

~~~ts
assert.equal("reasoning_effort" in (body ?? {}), false);
assert.equal("verbosity" in (body ?? {}), false);
~~~

The tests must inspect the captured public SDK request payload, not a private
provider field.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "relay adapter sends Chat JSON mode|uses Responses structured output" tests/agent/openai-provider.test.ts
~~~

Expected: FAIL because the relay payload currently omits both properties.

- [ ] **Step 3: Implement the minimum selected-transport payload**

Add only these two fields in the existing `relay-chat-json` call:

~~~ts
reasoning_effort: "low",
verbosity: "low",
~~~

Do not add environment variables, alter the official Responses body, change
the schema instruction, increase timeout, relax Zod, or introduce a fallback.

- [ ] **Step 4: Run GREEN and focused suite**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS. The first command proves the exact relay/default payload
boundary; the second proves shared repair, budget, and runtime behavior remain
unchanged without network traffic.

- [ ] **Step 5: Commit the implementation**

Commit only the provider and its test:

~~~powershell
git add server/runtime/openai-provider.ts tests/agent/openai-provider.test.ts
git commit -m "feat(voc): bound relay reasoning effort"
~~~

The plan-document extension is committed first as its own non-amend commit.

- [ ] **Step 6: Run one bounded full relay smoke**

Start one hidden real-mode Agent with `AGENT_VOC_RETRY_MAX_ATTEMPTS=1`, submit
exactly one new existing-data VOC run, then only poll that returned run and read
its reports once at terminal state. Keep the existing 300-second timeout. If it
again reaches the same timeout with a valid key, stop the Agent, release port
31901, and report the timeout plus the two next alternatives: a larger timeout
or approved trusted-input compaction. Do not retry or submit another run.

### Task 7: Use proven strict JSON Schema mode for relay Chat

**Files:**

- Modify: `server/runtime/openai-provider.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `docs/superpowers/plans/2026-08-16-relay-chat-completions-json-mode.md`

**Consumes:** The immutable `request.responseFormat.format` produced from the
declared output contract, and the successful relay capability probe for Chat
`response_format.type = "json_schema"` with `strict: true`.

**Produces:** A relay-only Chat response format containing the exact same
`name`, `strict`, and `schema` object used by the default Responses request.
The relay schema system message, `reasoning_effort: "low"`, `verbosity: "low"`,
local JSON.parse plus Zod validation, one repair, `maxRetries: 0`, and no
fallback remain in force.

- [ ] **Step 1: Write failing payload-identity tests**

Replace the relay test assertion for JSON object mode with:

~~~ts
const sentFormat = body?.response_format as {
  type?: unknown;
  json_schema?: {
    name?: unknown;
    strict?: unknown;
    schema?: unknown;
  };
};
assert.equal(sentFormat?.type, "json_schema");
assert.equal(sentFormat?.json_schema?.name, generationRequest.responseFormat.format.name);
assert.equal(sentFormat?.json_schema?.strict, true);
assert.equal(sentFormat?.json_schema?.schema, generationRequest.responseFormat.format.schema);
assert.deepEqual(sentFormat?.json_schema?.schema.required, ["summary"]);
assert.equal(sentFormat?.json_schema?.schema.additionalProperties, false);
assert.notDeepEqual(sentFormat, { type: "json_object" });
~~~

Keep the existing default Responses regression assertion that its
`body.text.format` is the exact `generationRequest.responseFormat.format` and
that it contains no relay messages/reasoning/verbosity fields.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "relay adapter sends Chat JSON mode|uses Responses structured output" tests/agent/openai-provider.test.ts
~~~

Expected: FAIL because relay currently sends `{ type: "json_object" }`.

- [ ] **Step 3: Replace only the relay response format**

In the selected `relay-chat-json` branch, derive the Chat wrapper from the
existing immutable artifact without regenerating a Zod schema:

~~~ts
const { name, strict, schema } = request.responseFormat.format;
// inside the relay request body
response_format: {
  type: "json_schema",
  json_schema: { name, strict, schema },
},
~~~

Keep the existing schema system message. Do not alter the default Responses
body, model timeout, retry controls, repair loop, parse/Zod boundary, or
provider identity.

- [ ] **Step 4: Run GREEN and the focused suite**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS with no network traffic. The payload test proves same-object
schema identity for relay and unchanged strict Responses behavior.

- [ ] **Step 5: Commit the implementation**

Commit only the provider and focused test:

~~~powershell
git add server/runtime/openai-provider.ts tests/agent/openai-provider.test.ts
git commit -m "feat(voc): use strict schema relay format"
~~~

The Task 7 plan extension is committed first, separately and without amend.

- [ ] **Step 6: Run one bounded strict-relay smoke**

Start one hidden real-mode Agent with physical retry 1 and the existing
300-second timeout. Submit exactly one new existing-data VOC run, poll only
that run, and read reports once at terminal state. If it succeeds, retain the
safe run/report/version evidence for the separate 8.5 acceptance checklist. If
it fails, stop the Agent and classify only durable telemetry; do not submit a
second run in this task.

### Task 8: Carry bounded safe Zod diagnostics into the one repair

**Files:**

- Create: `server/runtime/safe-validation-issues.ts`
- Modify: `server/runtime/model-provider.ts`
- Modify: `server/runtime/openai-provider.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `tests/agent/skill-runner.test.ts`

**Consumes:** `ZodError.issues`, the immutable
`StructuredGenerationRequest.responseFormat`, and the existing
`repairAttempted` / `nextRequestKind = "format-repair"` loop.

**Produces:**

~~~ts
export interface SafeValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly expected?: string;
}

export function summarizeZodValidationIssues(
  error: z.ZodError,
  responseFormat: StructuredResponseFormat,
): readonly SafeValidationIssue[];

export function createFormatRepairInstruction(
  instructions: string,
  issues: readonly SafeValidationIssue[],
): string;
~~~

`ModelProviderError` gains an optional frozen `validationIssues` field. It is
in-process metadata only: `AgentRun.error_json`, `SkillRunFailureAudit`, report
records, and HTTP errors remain unchanged fixed safe summaries.

- [ ] **Step 1: Write failing shared-transport provider tests**

In `tests/agent/openai-provider.test.ts`, use a nested strict Zod output schema
and an output containing both a wrong typed declared field and a raw sentinel
string. Run the existing Responses mock and the relay Chat mock through
`generateStructured`. Assert each rejects with `ModelProviderError` of kind
`invalid_output` and exactly the same frozen safe metadata:

~~~ts
assert.deepEqual(error.validationIssues, [
  { path: ["summary"], code: "invalid_type", expected: "string" },
]);
assert.equal(JSON.stringify(error.validationIssues).includes(rawSentinel), false);
assert.equal(Object.isFrozen(error.validationIssues), true);
~~~

Also assert malformed JSON produces `invalid_output` with
`validationIssues === undefined`, not an empty or synthetic issue list.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "validation issues|malformed completed" tests/agent/openai-provider.test.ts
~~~

Expected: FAIL because `ModelProviderError` has no `validationIssues` field and
the shared parser does not summarize Zod failures.

- [ ] **Step 3: Implement safe diagnostic extraction and provider transport**

Create `server/runtime/safe-validation-issues.ts`. It takes only a `ZodError`
and the already-declared response-format schema, returning at most ten frozen
entries. A diagnostic includes only a path of safe integers and declared schema
property names (replace any other string segment with `"<field>"`), a code from
a fixed Zod-code allowlist (otherwise `"validation"`), and `expected` only when
it is a short ASCII token from a fixed expected-type allowlist.

Never copy `message`, `input`, `received`, `values`, unrecognized-key lists,
custom refinement text, raw model output, or request input. Serialize the
repair hint with `JSON.stringify(issues)` only.

In `server/runtime/model-provider.ts`, extend the constructor options and
instance field with `readonly validationIssues?: readonly SafeValidationIssue[]`,
cloning and freezing every path and issue object. In `parseStructuredOutput` in
`server/runtime/openai-provider.ts`, set it only on the
`request.outputSchema.safeParse` failure. Keep the JSON.parse catch unchanged;
both provider transports continue through that helper.

- [ ] **Step 4: Run provider GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts
~~~

Expected: PASS. Default Responses and explicit relay yield the same bounded
diagnostics, while malformed JSON remains diagnostics-free.

- [ ] **Step 5: Write failing one-repair runner tests**

In `tests/agent/skill-runner.test.ts`, add separate cases for a fake provider
throwing `ModelProviderError("invalid_output", ...)` with one safe issue, and a
fake provider returning a contract-invalid object on its first call. Capture
`provider.requests`. Each second request must contain the serialized safe issue
and `FORMAT REPAIR`; neither request may contain a raw-output sentinel. A second
invalid response still makes exactly two calls and yields `MODEL_OUTPUT_ERROR`;
`getSkillRunFailureAudit` contains no validation diagnostics.

- [ ] **Step 6: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "safe validation repair|second invalid structured output" tests/agent/skill-runner.test.ts
~~~

Expected: FAIL because the current repair text is fixed and contains no issue
JSON, regardless of whether failure originated in the provider or runner check.

- [ ] **Step 7: Implement the one-repair wiring**

In `server/runtime/skill-runner.ts`, retain a local
`formatRepairIssues: readonly SafeValidationIssue[] = []`. On the first caught
provider `invalid_output`, copy `error.validationIssues ?? []` before changing
`repairAttempted`. On the first local output-contract `safeParse` failure,
summarize its `ZodError` using the same response format before changing
`repairAttempted`. Build the second request through
`createFormatRepairInstruction(instructions, formatRepairIssues)`.

Do not alter reservation identity, `attemptCount`, `nextRequestKind`, transient
retry, SDK retry, timeout, logging, or AgentRun persistence. The second invalid
provider or contract result retains the existing `MODEL_OUTPUT_ERROR` path, with
no third call or fallback.

- [ ] **Step 8: Run runner GREEN and focused suite**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/skill-runner.test.ts
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS. The second request alone contains bounded safe diagnostics; the
durable audit and fixed API error contract have no new raw or diagnostic field.

- [ ] **Step 9: Commit Task 8**

~~~powershell
git add server/runtime/safe-validation-issues.ts server/runtime/model-provider.ts server/runtime/openai-provider.ts server/runtime/skill-runner.ts tests/agent/openai-provider.test.ts tests/agent/skill-runner.test.ts
git commit -m "feat(voc): guide repair with safe validation issues"
~~~

Expected: only Task 8 production and focused test files are committed; the plan
extension is already a separate non-amend commit.

- [ ] **Step 10: Run one bounded strict-relay smoke**

After the focused suite passes, start one hidden real-mode Agent with the
existing ignored relay configuration, 300-second timeout, and physical retry
one. Submit exactly one new existing-data VOC run, poll that run only, and GET
reports once on terminal state. If it fails, stop the Agent and report only the
durable classification plus safe identifiers; do not submit a second run. If it
succeeds, retain run/report/version evidence for the separate OpenSpec 8.5
acceptance decision.

### Task 9: Emit bounded validation-failure telemetry without persisting model data

**Files:**

- Modify: `server/runtime/skill-runner.ts:26-31, 261-269, 787-1030`
- Modify: `server/runtime/voc-positioning-runtime.ts:25-81`
- Modify: `server/agent-service.ts:24-34, 108-126`
- Modify: `tests/agent/skill-runner.test.ts:213-230, 398-434, 771-846, 1179-1214`
- Modify: `tests/agent/voc-positioning-runtime.test.ts:430-560`
- Modify: `docs/superpowers/plans/2026-08-16-relay-chat-completions-json-mode.md`

**Consumes:** the already bounded and frozen `SafeValidationIssue` values from
`server/runtime/safe-validation-issues.ts`, the current one-format-repair
state machine, and Fastify's existing Pino `app.log.warn(metadata, message)`.

**Produces:** an in-process, best-effort `ModelValidationLogger` event on each
invalid-output attempt. It is not added to `AgentRun`, HTTP errors, reports,
worker summaries, or durable telemetry.

~~~ts
export interface ModelValidationFailureLog {
  readonly event: "model_validation_failed";
  readonly attemptKind: "initial" | "format-repair";
  readonly issueCount: number;
  readonly issues: readonly SafeValidationIssue[];
}

export type ModelValidationLogger =
  (entry: Readonly<ModelValidationFailureLog>) => void;
~~~

- [ ] **Step 1: Write the failing SkillRunner telemetry tests**

In `tests/agent/skill-runner.test.ts`, extend `createRunnerWithOptions` with
`validationLogger?: ModelValidationLogger`. Add an in-memory array and a fake
provider which returns contract-invalid output twice:

~~~ts
const rawSentinel = "RAW_VALIDATION_VALUE_MUST_NOT_LOG";
const logged: unknown[] = [];
const provider = new FakeProvider(async (_request, attempt) => ({
  value: { summary: attempt === 1 ? 9 : rawSentinel },
  responseId: `resp_invalid_${attempt}`,
  inputTokens: 10,
  outputTokens: 5,
}));
const runner = await createRunnerWithOptions(
  provider,
  { validationLogger: (entry) => logged.push(entry) },
);

await assert.rejects(runSkill(runner, executionRequest()), /MODEL_OUTPUT_ERROR/);
assert.equal(provider.requests.length, 2);
assert.deepEqual(logged.map((entry) => (entry as { attemptKind: string }).attemptKind), [
  "initial", "format-repair",
]);
assert.doesNotMatch(JSON.stringify(logged), new RegExp(rawSentinel));
~~~

Add a provider-origin variant using `ModelProviderError("invalid_output", rawSentinel,
{ validationIssues: [...] })`. It must record the frozen sanitised issue only;
the serialized entry must contain neither the raw error message nor a malicious
path/code/expected value. Add a throwing `validationLogger` case which still
ends with `MODEL_OUTPUT_ERROR` and exactly two provider calls.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "validation telemetry|second invalid structured output" tests/agent/skill-runner.test.ts
~~~

Expected: FAIL because `SkillRunnerDependencies` has no `validationLogger` and
no `model_validation_failed` event is emitted.

- [ ] **Step 3: Add the independent safe logger type and emit at the two invalid-output boundaries**

In `server/runtime/skill-runner.ts`, export `ModelValidationFailureLog` and
`ModelValidationLogger`; add optional `validationLogger` to
`SkillRunnerDependencies`, and import `freezeSafeValidationIssues` beside the
existing safe-validation helpers. Add a private best-effort helper:

~~~ts
#logValidationFailure(
  attemptKind: "initial" | "format-repair",
  issues: readonly SafeValidationIssue[],
) {
  try {
    const safeIssues = freezeSafeValidationIssues(issues);
    this.dependencies.validationLogger?.(Object.freeze({
      event: "model_validation_failed" as const,
      attemptKind,
      issueCount: safeIssues.length,
      issues: safeIssues,
    }));
  } catch {
    // Observability must not alter repair, budget, or durable failure semantics.
  }
}
~~~

Call it exactly once before changing repair state in each of the two existing
invalid-output paths:

~~~ts
// caught ModelProviderError("invalid_output")
this.#logValidationFailure(
  requestIdentity.kind === "format-repair" ? "format-repair" : "initial",
  error.validationIssues ?? [],
);

// local outputContract.schema.safeParse failure
const issues = summarizeZodValidationIssues(outputResult.error, responseFormat);
this.#logValidationFailure(
  requestIdentity.kind === "format-repair" ? "format-repair" : "initial",
  issues,
);
~~~

Use those same `issues` for the existing initial repair instruction. Do not add
the event to `SkillRunFailureAudit`, `AgentRunLogSummary`, repository writes,
HTTP route payloads, or error objects. Do not change `repairAttempted`, request
identity, retry counters, timeout, SDK retries, or fallback behavior.

- [ ] **Step 4: Run SkillRunner GREEN**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/skill-runner.test.ts
~~~

Expected: PASS. The initial and format-repair failures each produce one safe
event, the provider receives two requests only, raw sentinels are absent, and a
throwing logger cannot alter the terminal error.

- [ ] **Step 5: Write the failing runtime-to-Agent-Service wiring test**

In `tests/agent/voc-positioning-runtime.test.ts`, add a service integration
fixture with a provider that returns contract-invalid output on both calls and:

~~~ts
const validationEvents: ModelValidationFailureLog[] = [];
const agentService = await createAgentService({
  repository,
  env: {
    ...validRuntimeEnv(),
    AGENT_SQLITE_PATH: databasePath,
    AGENT_SERVICE_PROXY_TOKEN: "runtime-proxy-token",
    AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:3001",
    AGENT_EXECUTION_ACTOR_ID: actorId,
    AGENT_EXECUTION_ORGANIZATION_ID: organizationId,
  },
  provider: invalidProvider,
  providerName: "fake",
  validationLogger: (entry) => validationEvents.push(entry),
});

await agentService.start({ host: "127.0.0.1", port: 0 });
await waitFor(async () => (await repository.findRunStage(stageId))?.status === "failed");
assert.deepEqual(validationEvents.map((entry) => entry.attemptKind), [
  "initial", "format-repair"]);
assert.equal(invalidProviderCalls, 2);
~~~

The fixture must assert that its serialized events omit a raw output sentinel
and that no report is created. It must stop the service and close its temporary
SQLite repository in `t.after`.

- [ ] **Step 6: Run runtime RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "validation logger runtime wiring" tests/agent/voc-positioning-runtime.test.ts
~~~

Expected: FAIL because `CreateAgentServiceOptions` cannot accept
`validationLogger` and it is not forwarded to the runtime.

- [ ] **Step 7: Wire the event to runtime and Pino safely**

In `server/runtime/voc-positioning-runtime.ts`, import `ModelValidationLogger`,
add `validationLogger?: ModelValidationLogger` to
`VocPositioningRuntimeOptions`, and pass it to `new SkillRunner` only when
provided. In `server/agent-service.ts`, add the same optional field to
`CreateAgentServiceOptions`; pass the injected logger when present, otherwise
adapt the already-created Pino logger:

~~~ts
validationLogger: options.validationLogger ??
  ((entry) => app.log.warn(entry, entry.event)),
~~~

The adapter receives an already frozen closed object. Do not pass a provider
error, request, completion, input, base URL, key, or model output to Pino.

- [ ] **Step 8: Run runtime GREEN and focused suite**

Run:

~~~powershell
npx tsx --conditions=react-server --test tests/agent/voc-positioning-runtime.test.ts
npx tsx --conditions=react-server --test tests/agent/openai-provider.test.ts tests/agent/skill-runner.test.ts tests/agent/skill-runner-persistent-budget.test.ts tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: PASS with no network or service process leak. The injected test logger
observes both events; production uses only the safe Pino metadata adapter.

- [ ] **Step 9: Commit Task 9**

Commit the production and focused test files only after all Task 9 commands
pass:

~~~powershell
git add server/runtime/skill-runner.ts server/runtime/voc-positioning-runtime.ts server/agent-service.ts tests/agent/skill-runner.test.ts tests/agent/voc-positioning-runtime.test.ts
git commit -m "feat(voc): log safe model validation failures"
~~~

Expected: a non-amend commit containing only these five files. The Task 9 plan
extension is committed first, separately; `.env.local`, user runtime WIP,
project JSON, package-lock, migrations 0001-0005, generated VOC, and stash are
untouched.

- [ ] **Step 10: Run one bounded strict-relay smoke and stop**

Start one hidden real-mode Agent with `AGENT_VOC_RETRY_MAX_ATTEMPTS=1` and the
existing ignored 300-second relay configuration. Submit exactly one new
existing-data VOC run, poll only its returned run ID, and GET reports once at
terminal state. Capture only the event name, attempt kind, issue count, and
safe issue tuples. If it succeeds, retain the safe run/report/version evidence
for the OpenSpec 8.5 checklist. If it fails, read no more than ten
`path/code/expected` tuples, stop the Agent, release port 31901, and do not
submit another run.

## Final Slice Verification

- [ ] Re-read docs/superpowers/specs/2026-08-16-relay-chat-completions-json-mode-design.md and map every requirement to Tasks 1-9.
- [ ] Run git diff --check and confirm no changed or staged file is package-lock.json, migrations 0001-0005, generated VOC data, or user WIP.
- [ ] Run the Task 9 focused suite once more and record its exact output.
- [ ] If a real smoke was explicitly approved and succeeded, record only safe run/report identifiers, terminal status, usage/cost summary, and port-release evidence. Do not mark OpenSpec 8.5 unless its separate acceptance checklist is satisfied.
- [ ] Confirm commits are non-amend commits on feat/voc-positioning-skill-execution. Do not push, merge, rebase, or stash.

## Plan Self-Review

- **Spec coverage:** Tasks 1-3 cover explicit selection, default preservation, base-URL identity, Chat JSON payload, shared validation, no fallback, SDK retry zero, budgets, and runtime wiring. Task 4 covers one repair and deterministic fixture regression. Task 5 adds the declared shared JSON Schema to relay-only instructions. Task 6 applies the proven low reasoning/verbosity pair only to relay. Task 7 uses the same declared schema artifact in relay Chat strict JSON Schema mode. Task 8 carries only bounded schema-derived diagnostics into the already-single repair while leaving durable errors fixed and raw content absent. Task 9 emits only those existing safe diagnostics to injected logging or Pino without changing persistence, HTTP contracts, repair count, or provider retries.
- **Placeholder scan:** Every RED/GREEN step gives an exact target, assertion skeleton, command, expected result, and commit command.
- **Type consistency:** VocProviderTransport, transport, baseUrl, providerName, ModelValidationFailureLog, ModelValidationLogger, and unchanged generateStructured are defined once and use the same names in every task.
