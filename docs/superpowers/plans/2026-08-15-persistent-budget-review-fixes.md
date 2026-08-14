# Persistent Budget Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve actual OpenAI usage on every received response and bind persistent request idempotency to the exact JSON Schema sent to the provider.

**Architecture:** A single response-format helper converts the runtime Zod contract into an immutable strict JSON Schema format and a canonical SHA-256 digest. SkillRunner fingerprints and dispatches that same format, while OpenAIProvider uses non-streaming `responses.create`, validates response identity and usage before interpreting status/output, and performs local JSON and Zod parsing so every post-response error carries actual usage.

**Tech Stack:** TypeScript, Node test runner, Zod 4, OpenAI JavaScript SDK 7.4, SQLite model-budget ledger.

## Global Constraints

- Work only on `feat/integrate-persistent-budget` in the existing linked worktree.
- Do not amend, rebase, push, merge, or touch stash.
- Keep OpenSpec 6.4 unchecked until every required verification passes; keep 7.3 unchecked throughout.
- Do not add tools, streaming, output persistence, UI, authentication, PostgreSQL, or VOC work.
- Every production change requires a failing regression test first.

---

### Task 1: Preserve Usage From Raw OpenAI Responses

**Files:**
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `server/runtime/openai-provider.ts`
- Modify: `tests/agent/skill-runner-persistent-budget.test.ts`

**Interfaces:**
- Consumes: `StructuredGenerationRequest<T>`, `ModelProviderError`, non-streaming `responses.create`.
- Produces: locally parsed structured output and usage-bearing post-response failures.

- [ ] Add provider tests proving `responses.create` receives strict JSON Schema format, no tools, `store: false`, and that incomplete/failed/tool/refusal/empty/JSON/Zod failures retain validated usage.
- [ ] Run the focused provider tests and record the expected RED caused by the existing `responses.parse` path or missing usage.
- [ ] Replace `responses.parse` with raw non-streaming `responses.create`; validate response ID and usage first; extract only completed assistant message `output_text`; locally run `JSON.parse` then Zod validation; attach usage to every subsequent error.
- [ ] Run provider tests GREEN.
- [ ] Add a real SkillRunner + OpenAIProvider + SQLite test where invalid JSON usage exceeds projection and is settled before a repair reservation can be admitted.
- [ ] Run the integration test RED, implement only any missing runner/provider behavior, then run GREEN.
- [ ] Commit without amend.

### Task 2: Bind Fingerprints to the Sent JSON Schema

**Files:**
- Create: `server/runtime/structured-response-format.ts`
- Modify: `server/runtime/model-provider.ts`
- Modify: `server/runtime/model-request-accounting.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `tests/agent/model-request-accounting.test.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `tests/agent/skill-runner-persistent-budget.test.ts`
- Modify: existing SkillRunner test fixtures as required by the request interface.

**Interfaces:**
- Produces: `createStructuredResponseFormat(schema, contractName)` returning an immutable `{ format, digest }` where `format` contains only `type`, normalized `name`, `strict`, and pure JSON `schema`.
- `StructuredGenerationRequest<T>` carries that exact response format and digest.
- `ModelRequestFingerprintInput` includes the response schema digest in addition to the contract name.

- [ ] Add helper/accounting tests proving digest stability, same-name schema sensitivity, immutability, and that format fields/digest come from the same pure JSON object.
- [ ] Run focused tests and record RED for the missing helper/digest.
- [ ] Implement the helper by explicitly copying enumerable JSON Schema semantics from `zodTextFormat` and hashing only the pure strict format fields.
- [ ] Thread the helper result through SkillRunner, request fingerprinting, and OpenAIProvider; remove duplicate schema conversion.
- [ ] Add SQLite idempotency-conflict coverage for same run/job/ordinal and contract name with a changed schema; prove same schema remains stable.
- [ ] Run focused accounting/provider/runner tests GREEN.

### Task 3: Full Verification and OpenSpec Gate

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

- [ ] Run focused budget, OpenAI provider, SkillRunner, and WorkerLoop tests.
- [ ] Run `npm run test:agent` and `npm run skills:validate`.
- [ ] Run `npm run lint`, `openspec validate build-standalone-agent-workflow --strict`, and `npm test`.
- [ ] Compare `npx tsc --noEmit --incremental false` diagnostics with the exact integration baseline and require zero normalized diagnostic difference.
- [ ] Run `git diff --check`, confirm 7.3 remains unchecked, restore 6.4 to checked only now, and rerun the relevant final gates.
- [ ] Create a new non-amended verification commit and report commit SHAs plus clean branch/worktree status.
