# Relay Chat Completions JSON Mode Design

**Date:** 2026-08-16

**Scope:** Explicit OpenAI-compatible relay support for the existing VOC
positioning provider. This is a design-only change; it does not alter the
published OpenSpec acceptance state.

**Status:** Approved for planning

## Goal

Keep the existing official OpenAI Responses path as the secure default while
allowing a deliberately configured relay to use Chat Completions JSON mode.
Both transports must produce the same fail-closed, parsed-and-Zod-validated
value for the existing Skill runner. A relay is never an automatic fallback
from the official path.

## Evidence and constraints

- The current provider sends `responses.create` with strict
  `text.format: { type: "json_schema", strict: true }`, then independently
  parses JSON and validates the existing output Zod schema.
- The relay's small Models and Responses probes succeed, but the real strict
  VOC request produced two settled `model-output` failures. Its reported
  output-token counts also exceeded the configured `4000` cap. It is therefore
  not accepted as a strict Responses JSON Schema transport.
- Existing runner semantics already reserve/settle every provider call, use
  SDK `maxRetries: 0`, and allow at most one format-repair request. Those
  semantics remain authoritative.
- No raw model output, prompt, token, key, or relay credential may be written
  to durable audit rows or ordinary logs.

## Alternatives considered

1. **Explicit relay Chat JSON mode (chosen).** The official path remains
   unchanged. A relay is selected only by a complete explicit configuration,
   uses `chat.completions.create` with JSON-object mode, and still goes through
   the existing JSON parse and Zod validation boundary.
2. **Relax the Responses strict schema path.** This would make official and
   relay behavior ambiguous and would weaken the existing contract. Rejected.
3. **Automatically retry Responses through Chat after an invalid response.**
   This would conceal transport drift, create an unbudgeted-looking fallback,
   and blur audit identity. Rejected.

## Configuration and selection

Add one runtime transport setting with an intentionally narrow closed set:

```text
AGENT_VOC_TRANSPORT=responses-strict | relay-chat-json
```

- Omitted `AGENT_VOC_TRANSPORT` means `responses-strict`.
- `responses-strict` is the only mode allowed for the normal official setup.
  It continues to use the existing Responses strict JSON Schema request.
- `relay-chat-json` requires a non-empty absolute HTTPS `OPENAI_BASE_URL` and
  treats that endpoint as an explicitly chosen OpenAI-compatible relay.
- Any blank, unknown, malformed, or incomplete relay configuration makes the
  VOC runtime unavailable with the existing fixed configuration error. It does
  not select another transport.
- `OPENAI_BASE_URL` alone does not switch behavior. It supplies a client base
  URL only after the transport selection is valid.

The resolved transport name and canonical base-URL identity are included in
the provider/model execution identity, request fingerprint, and audit-safe
configuration digest. This prevents a run prepared for one transport or relay
from being replayed by another. The raw URL need not be logged.

## Provider boundary

`OpenAIProvider` becomes a small transport adapter behind the existing
`ModelProvider.generateStructured` interface. The runner, Worker, budget
coordinator, report publisher, and output contracts do not gain alternate
execution paths.

### Responses strict transport

This path is unchanged:

1. Call `responses.create` with the generated strict JSON Schema format.
2. Require a completed response, valid response identity, valid usage, and
   only completed assistant `output_text` parts.
3. Parse the returned text as JSON and validate it with the declared output
   Zod schema.

### Relay Chat JSON transport

This path sends one Chat Completions request with:

- the same configured model, timeout, cancellation signal, and `maxRetries: 0`;
- the Skill instructions as the system/developer message and the canonical
  prepared input JSON as the user message;
- `response_format: { type: "json_object" }`;
- the configured output-token limit using the relay's capability-confirmed Chat
  completion limit field.

The adapter accepts exactly one completed assistant text content string. Tool
calls, refusals, missing content, non-string content, malformed usage, and
non-completed choices are rejected. It then uses the same JSON parse and the
same declared output Zod schema as the Responses transport. JSON object mode is
only a transport instruction; it never replaces application validation.

Before a real relay smoke, a bounded capability probe must confirm that the
configured endpoint accepts both the selected Chat completion limit field and
`response_format: { type: "json_object" }`. Probe failure leaves the runtime
unavailable; it does not fall back to Responses or remove the output limit.

## Failure, retry, and accounting semantics

- Missing relay capability/configuration is a fail-closed configuration error.
- Authentication, invalid model, unsupported JSON mode, malformed Chat envelope,
  and invalid usage are classified with the existing permanent/provider error
  policy; transient transport and 5xx/rate-limit conditions retain the existing
  transient policy.
- A completed assistant response that cannot be parsed as JSON or fails the
  declared Zod schema is `invalid_output` / `model-output`.
- The runner may make one, and only one, format-repair call for
  `invalid_output`. The repair uses the same selected transport, model,
  identity, timeout, and budget rules. It cannot switch transport.
- SDK retries remain disabled for both transports. There are no hidden SDK
  retries and no Chat-to-Responses or Responses-to-Chat fallback.
- Each initial or repair call keeps its own existing budget reservation,
  dispatch, settlement/release, usage, and fencing behavior. Chat usage is
  normalized only when prompt/completion/total token integers are present and
  internally consistent; reasoning detail, when supplied, is audit-safe
  metadata only and does not replace the existing total budget accounting.
- Timeouts, cancellation, Worker claims, leases, report publication, and
  immutable result persistence are unchanged.

## Test matrix

Implementation is TDD and begins with focused provider/config tests.

1. **Default preservation:** an omitted transport selects Responses strict and
   emits the current `responses.create` strict JSON Schema request; it never
   calls Chat Completions.
2. **Relay selection:** an explicit, complete `relay-chat-json` configuration
   sends Chat Completions JSON-object mode with the correct messages, timeout,
   cancellation signal, output limit, and `maxRetries: 0`.
3. **Fail closed:** unknown transport, missing/invalid relay base URL, rejected
   capability probe, and unsupported JSON mode make runtime configuration fail;
   none silently invokes the other transport.
4. **Shared validation:** valid Chat JSON reaches the existing Zod schema;
   malformed JSON, schema-invalid JSON, missing content, tool/refusal content,
   incomplete choice, and malformed/mismatched usage each fail without
   persisting raw output.
5. **Repair and budget:** an invalid initial output permits exactly one same-mode
   repair, with two explicit budget reservations at most; a second invalid
   output fails as `model-output`. Assert no SDK retry and no transport switch.
6. **Identity and fencing:** transport/base-URL configuration drift conflicts
   rather than replaying a prior AgentRun; the existing claim, cancellation,
   timeout, and report-persistence tests remain green.
7. **Smoke:** run one deterministic fixture through the selected relay adapter
   fake, then one user-authorized real relay smoke only after the capability
   probe passes. The real smoke has one submission, physical retry one, report
   readback, and no automatic retry. It records only safe run/report/usage
   metadata.

## Non-goals

- Changing OpenSpec 8.3, 8.4, or 8.5 acceptance state.
- Relaxing strict JSON Schema on the default Responses path.
- Supporting arbitrary OpenAI-compatible dialects, tool calling, streaming,
  browser execution, login, PostgreSQL, Cloudflare, or external data sync.
- Persisting prompts, complete VOC text, raw completions, API keys, or relay
  responses for debugging.
- Modifying `package-lock.json`, migrations `0001` through `0005`, or generated
  VOC data.

## Self-review

The transport selector, no-fallback policy, single-repair limit, shared output
validation, capability gate, and accounting identity are explicit. The document
contains no placeholders, deferred choices, or behavior that conflicts with
the existing fail-closed runner.
