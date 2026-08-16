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
| server/runtime/voc-positioning-runtime.ts | Build OpenAIProvider with resolved transport/base URL and pass its safe providerName to SkillRunner. |
| server/runtime/model-request-accounting.ts | Reuse or add only a small SHA-256 string identity helper. |
| tests/agent/voc-positioning-runtime.test.ts | Runtime config resolution, runtime construction, fixture regression. |
| tests/agent/openai-provider.test.ts | Transport payloads, parse/Zod validation, safe error and usage mapping. |
| tests/agent/model-request-accounting.test.ts | Fingerprint drift assertion for the safe provider identity. |
| tests/agent/skill-runner-persistent-budget.test.ts | Persistent repair and reservation assertions. |

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

**Produces:** selected transport/base URL provider construction and existing
SkillRunner providerName fingerprint binding.

- [ ] **Step 1: Write failing runtime and drift tests**

~~~
function relayRuntimeConfig(): VocPositioningRuntimeConfig {
  return loadVocPositioningRuntimeConfig({
    ...validRuntimeEnv(),
    AGENT_VOC_TRANSPORT: "relay-chat-json",
    OPENAI_BASE_URL: "https://relay.example.test/v1",
  });
}

test("runtime constructs relay provider from resolved config", async () => {
  const runtime = await createVocPositioningRuntime({
    repository,
    config: relayRuntimeConfig(),
    skillsRoot,
  });
  assert.ok(runtime);
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

The runtime test injects a fake SDK/provider and makes no network request. The
fingerprint test uses the exact existing canonical input fixture, so a transport
or base-URL change cannot silently match a prior persistent request identity.

- [ ] **Step 2: Run RED**

Run:

~~~powershell
npx tsx --conditions=react-server --test --test-name-pattern "runtime constructs relay|relay transport identity changes" tests/agent/voc-positioning-runtime.test.ts tests/agent/model-request-accounting.test.ts
~~~

Expected: FAIL because runtime passes only apiKey to OpenAIProvider and no relay
identity is wired into a constructed runtime.

- [ ] **Step 3: Implement minimum runtime wiring**

Replace the default construction in createVocPositioningRuntime:

~~~
const provider = options.provider ?? new OpenAIProvider({
  apiKey: options.config.apiKey,
  transport: options.config.transport,
  baseUrl: options.config.baseUrl,
});
const providerName = options.providerName ?? options.config.providerName;
~~~

Do not change Worker, claim, retry, report, budget, or local-fixture APIs.
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

## Final Slice Verification

- [ ] Re-read docs/superpowers/specs/2026-08-16-relay-chat-completions-json-mode-design.md and map every requirement to Tasks 1-4.
- [ ] Run git diff --check and confirm no changed or staged file is package-lock.json, migrations 0001-0005, generated VOC data, or user WIP.
- [ ] Run the Task 4 focused suite once more and record its exact output.
- [ ] If a real smoke was explicitly approved and succeeded, record only safe run/report identifiers, terminal status, usage/cost summary, and port-release evidence. Do not mark OpenSpec 8.5 unless its separate acceptance checklist is satisfied.
- [ ] Confirm commits are non-amend commits on feat/voc-positioning-skill-execution. Do not push, merge, rebase, or stash.

## Plan Self-Review

- **Spec coverage:** Tasks 1-3 cover explicit selection, default preservation, base-URL identity, Chat JSON payload, shared validation, no fallback, SDK retry zero, budgets, and runtime wiring. Task 4 covers one repair, deterministic fixture regression, capability probe, and bounded real smoke.
- **Placeholder scan:** Every RED/GREEN step gives an exact target, assertion skeleton, command, expected result, and commit command.
- **Type consistency:** VocProviderTransport, transport, baseUrl, providerName, and unchanged generateStructured are defined once and use the same names in every task.
