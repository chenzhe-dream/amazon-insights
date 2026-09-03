# Manual Alexa VOC ASIN Binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the submitted target ASIN authoritative, allow report-text ASIN differences, and show only a non-blocking primary-ASIN advisory without misclassifying ordinary words such as `brightness`.

**Architecture:** Keep the existing immutable client submission scope and response-ASIN guard. Move report identity to a small client-only advisory helper and remove raw-text mismatch assertions from the server import and LLM render paths.

**Tech Stack:** TypeScript, React, Node test runner, Fastify service layer, ESLint, Next.js production build.

## Global Constraints

- Do not change sync, Sorftime, SIF, image, project hydration, provider configuration, or database schema code.
- Do not make real provider requests or real VOC POSTs.
- Preserve all unrelated dirty worktree files and stage only files owned by this change.
- Run one production build after focused tests pass.

---

### Task 1: Add the report identity advisory

**Files:**
- Modify: `app/alexa-voc-import-validation.ts`
- Modify: `app/alexa-voc-import-panel.tsx`
- Modify: `app/lib/manual-alexa-voc-import-feedback.ts`
- Modify: `app/comparison-layout.css`
- Test: `tests/agent/manual-alexa-voc-import-feedback.test.ts`

**Interfaces:**
- Consumes: selected ASIN and the draft text already scoped by `createAlexaVocImportSubmission`.
- Produces: `manualAlexaVocPrimaryAsinAdvisory(value, targetAsin): string | null`.

- [ ] **Step 1: Write failing advisory tests**

Add assertions that a matching opening title returns `null`, `brightness` returns `null`, and a different parenthesized opening ASIN returns a warning naming both the detected and selected ASINs. Add a source assertion that the panel renders the advisory without disabling the submit button.

- [ ] **Step 2: Run the focused test and confirm RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-import-feedback.test.ts`

Expected: FAIL because `manualAlexaVocPrimaryAsinAdvisory` does not exist.

- [ ] **Step 3: Implement the minimal helper and rendering**

Inspect only the first five non-empty lines. Accept an explicit `ASIN:` token or a parenthesized ten-character token containing at least one digit. Return a Chinese warning only when that primary token differs from the target. Render it with `role="status"` and a compact amber style; do not disable or add a second POST to the button.

- [ ] **Step 4: Re-run the focused test and confirm GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-import-feedback.test.ts`

Expected: PASS.

### Task 2: Make captured target ASIN authoritative on the server

**Files:**
- Modify: `server/services/manual-alexa-voc-service.ts`
- Modify: `server/domain/voc/alexa-voc-normalization-contracts.ts`
- Test: `tests/agent/manual-alexa-voc-service.test.ts`
- Test: `tests/agent/alexa-voc-normalization-contracts.test.ts`

**Interfaces:**
- Consumes: the already authorized and captured `request.asin` / renderer `context.asin`.
- Produces: deterministic and LLM-normalized records whose `asin` is always that captured target.

- [ ] **Step 1: Replace rejection expectations with failing binding expectations**

Change the service mismatch cases to expect `pending`, an encrypted normalization input whose identity uses the selected target, and one dispatch per selected target. Change the renderer mismatch case to expect no throw and `rendered.asin === rendererContext.asin`. Include raw prose containing `brightness`.

- [ ] **Step 2: Run the two focused suites and confirm RED**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/alexa-voc-normalization-contracts.test.ts`

Expected: FAIL with the current typed ASIN mismatch rejection.

- [ ] **Step 3: Remove the two active raw-text mismatch assertions**

Remove the pre-queue assertion and catch from `ManualAlexaVocService.importReport`. Remove the renderer assertion from `canonicalizeAlexaVocNormalizationOutputRecord`. Keep project/run/selected-ASIN authorization and the existing client response-ASIN guard unchanged.

- [ ] **Step 4: Re-run focused suites and confirm GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/manual-alexa-voc-service.test.ts tests/agent/alexa-voc-normalization-contracts.test.ts tests/agent/manual-alexa-voc-import-feedback.test.ts`

Expected: PASS.

### Task 3: Verify and update the local formal build

**Files:**
- Verify only the owned source and test files above.

**Interfaces:**
- Consumes: passing focused suites.
- Produces: one reviewed commit and a healthy local formal artifact.

- [ ] **Step 1: Run changed-file lint and related route/client suites**

Run ESLint on the owned TypeScript/TSX files, then run the Manual Alexa route and worker suites without provider access.

Expected: exit code 0.

- [ ] **Step 2: Run one production build and diff checks**

Run: `npm run build`

Then run `git diff --check` and confirm no unrelated dirty file is staged.

Expected: build and diff checks pass.

- [ ] **Step 3: Commit only owned files**

Commit message: `fix(voc): treat report asin as advisory`

- [ ] **Step 4: Update the local formal artifact and check health**

Use the repository formal-stack build/install path, then verify Web, Agent, PostgreSQL, active job count, and deployed commit. Do not perform a real import.

Expected: all formal health checks pass and active jobs remain zero.
