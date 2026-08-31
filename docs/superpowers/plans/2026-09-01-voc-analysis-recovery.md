# VOC Analysis Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repair Manual Alexa report binding, long-running VOC observation, and safe model-provider failure diagnostics so a valid three-ASIN VOC analysis can reach and display a truthful terminal result.

**Architecture:** Keep the selected ASIN and PostgreSQL run state authoritative. Extend only the deterministic import boundary, the existing GET-only browser observer, and the provider error classification path; preserve the current worker, budget, retry, and report contracts.

**Tech Stack:** TypeScript 5.9, React 19, Fastify 5, Zod 4, OpenAI JavaScript SDK, Node test runner through `tsx`.

## Global Constraints

- Require complete Manual Alexa records for all 3-10 ASINs before VOC submission.
- Do not accept arbitrary prose without at least three valid dimensions.
- Do not make real Provider requests during implementation tests.
- Do not auto-submit, auto-retry, or create replacement jobs/runs/stages.
- Do not stage the 15 generated `app/*.ts` files or the current project JSON WIP.

---

### Task 1: Bind Reports Without Embedded ASIN to the Selected Scope

**Files:**
- Modify: `scripts/lib/alexa-voc-processing.mjs`
- Modify: `tests/agent/manual-alexa-voc-service.test.ts`

**Interfaces:**
- Consumes: `processAlexaVocText(rawText, asin, options)` and `ManualAlexaVocService.importReport`.
- Produces: `reportAsin` equal to the explicit report ASIN when present, otherwise the selected ASIN hint.

- [ ] **Step 1: Write RED tests**

Add one valid report fixture with its ASIN line removed and assert import succeeds for the selected ASIN. Retain the existing explicit-mismatch rejection and assert zero transaction/encryption calls.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="without an embedded ASIN|validates report ASIN" tests/agent/manual-alexa-voc-service.test.ts`

Expected: the no-embedded-ASIN import rejects as incomplete while the mismatch case passes.

- [ ] **Step 3: Implement GREEN**

Pass the selected ASIN as the existing parser hint:

```js
const parsed = parseAlexaVocReport(rawText, asin);
```

The parser already prefers an explicit ASIN over the hint, so explicit mismatch remains rejected.

- [ ] **Step 4: Verify GREEN**

Run the focused command, then `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/alexa-voc-import-validation.test.ts`.

Expected: all selected tests pass.

### Task 2: Observe Long VOC Runs to a Truthful Terminal State

**Files:**
- Modify: `app/lib/voc-run-browser.ts`
- Modify: `tests/agent/voc-run-browser.test.ts`

**Interfaces:**
- Consumes: `waitForVocRun(runId, options)`.
- Produces: the same `VocRunObservation`, with default polling covering a 15-minute bounded execution window at one-second intervals.

- [ ] **Step 1: Write RED test**

Inject a fake clock and 62 active observations followed by a failed observation. Call `waitForVocRun` without overriding attempts/interval and assert it reaches `failed`, publishes 63 observations, performs GET only, and sleeps at least 62 times.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="longer than the legacy fifteen-second window" tests/agent/voc-run-browser.test.ts`

Expected: current default stops at observation 60 with kind `active`.

- [ ] **Step 3: Implement GREEN**

Set the defaults to `attempts = 900` and `intervalMs = 1000`. Do not change URL identity, POST helpers, terminal classification, or injected overrides.

- [ ] **Step 4: Verify GREEN**

Run the focused test and the full `tests/agent/voc-run-browser.test.ts` file.

Expected: all tests pass with zero business POST in the new case.

### Task 3: Persist Bounded Provider Failure Reasons

**Files:**
- Modify: `server/runtime/model-provider.ts`
- Modify: `server/runtime/openai-provider.ts`
- Modify: `server/runtime/skill-runner.ts`
- Modify: `tests/agent/openai-provider.test.ts`
- Modify: `tests/agent/skill-runner.test.ts`

**Interfaces:**
- Produces: `ModelProviderError.reasonCode?: "HTTP_REQUEST_REJECTED" | "HTTP_AUTHENTICATION" | "HTTP_RATE_LIMITED" | "HTTP_UPSTREAM_UNAVAILABLE"`.
- Produces: persisted fixed API codes without provider body/header/message leakage.

- [ ] **Step 1: Write RED tests**

Construct SDK `APIError` fixtures for 400, 401, 403, 429, and 503. Assert `classifyOpenAIError` returns only the fixed reason code. Run a SkillRunner fixture and assert the terminal error contains the fixed reason while serialized output excludes the supplied body, header, URL, and secret sentinels.

- [ ] **Step 2: Verify RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="bounded HTTP reason|fixed provider reason" tests/agent/openai-provider.test.ts tests/agent/skill-runner.test.ts`

Expected: `reasonCode` is absent.

- [ ] **Step 3: Implement GREEN**

Add the closed optional field to `ModelProviderError`, map only HTTP status classes in `classifyOpenAIError`, and carry that closed code into the safe Skill runtime message. Never serialize the cause.

- [ ] **Step 4: Verify GREEN**

Run the focused command, then the complete OpenAI provider and SkillRunner test files.

Expected: all selected tests pass and sentinel leakage assertions remain false.

### Task 4: Regression Verification

**Files:**
- Do not stage protected generated WIP.

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: a reviewed deployment candidate; no live Provider request.

- [ ] **Step 1: Run affected tests**

```powershell
npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/alexa-voc-import-validation.test.ts tests/agent/voc-run-browser.test.ts tests/agent/voc-readiness.test.ts tests/agent/openai-provider.test.ts tests/agent/skill-runner.test.ts
```

- [ ] **Step 2: Run static gates**

```powershell
npx eslint scripts/lib/alexa-voc-processing.mjs app/lib/voc-run-browser.ts server/runtime/model-provider.ts server/runtime/openai-provider.ts server/runtime/skill-runner.ts
npm run build
git diff --check
```

- [ ] **Step 3: Review and handoff**

Require Critical/direct blockers equal zero. Deployment and the eventual single real three-ASIN VOC run remain separate controlled actions.
