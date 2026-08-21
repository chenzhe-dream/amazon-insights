# VOC Positioning Skill Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the published VOC positioning Skill from trusted 8.1/8.2 data and persist a schema-valid, invariant-valid, immutable versioned analysis result.

**Architecture:** A VOC domain service reparses deterministic facts, builds a minimal strict model request, delegates generation to `AuditedSkillRunner`, then idempotently publishes through a transactionally fenced report repository. Dynamic Zod semantic validation compares every deterministic echo and evidence relationship to the parsed facts before the generic runner may finalize success.

**Tech Stack:** Node.js 22, TypeScript, Zod 4, SQLite `node:sqlite`, existing SkillRegistry/SkillRunner/AuditedSkillRunner/Worker and Node test runner.

## Global Constraints

- Implement OpenSpec 8.3 only; do not add 8.4 UI, 8.5 E2E, login, PostgreSQL, browser, MCP, Codex, Cursor, or network collection.
- Add no dependencies and do not change `package-lock.json`.
- Do not modify migrations 0001-0005; add no migration unless the existing immutable report table proves insufficient.
- Do not modify the three generated VOC data files.
- Model input is limited to trusted snapshot provenance and public-parser-validated whitelisted facts/evidence.
- Bind snapshot ID/content hash, facts digest, SkillVersion, and model configuration; drift conflicts.
- Replays and restarts must not dispatch the provider twice or create duplicate terminal reports.
- Output passes a closed JSON/Zod schema and business invariants before persistence.
- P0/P1 and safety escalation fail closed; missing metrics are never inferred.
- Logs and persisted errors contain only fixed summaries/classifications, never prompts, full responses, VOC text, secrets, or identities.
- Preserve existing budget, retry, format repair, cancel, claim, lease, and fencing behavior.
- One final atomic commit only; no amend, rebase, push, merge, or stash.

---

### Task 1: Closed VOC positioning contracts and semantic validator

**Files:**
- Create: `server/domain/voc/voc-positioning-contracts.ts`
- Create: `tests/agent/voc-positioning-contracts.test.ts`

**Interfaces:**
- Consumes: `parseVocDeterministicPreprocessingResult(input)` and `VocDeterministicPreprocessingResult` from `preprocess-voc-snapshot.ts`.
- Produces: `VocPositioningInputSchema`, `VocPositioningOutputShapeSchema`, `createVocPositioningOutputSchema(facts)`, `buildVocPositioningInput(facts)`, and inferred input/output types.

- [ ] **Step 1: Write failing structural and valid-fixture tests**

  Define a valid fake-model result builder against real scooter/lighting facts.
  Assert strict rejection of extra keys, malformed output, incomplete identity,
  and success for a closed full result.

- [ ] **Step 2: Run the contract tests and verify RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-positioning-contracts.test.ts`
  Expected: FAIL because the contract module does not exist.

- [ ] **Step 3: Implement the minimal input/output schemas**

  Use only strict objects and closed enums. Include exact identity and coverage
  echoes, conclusion/positioning/theme/action evidence references, checklists,
  next validation items, and a fixed limitations set. Do not include free-form
  request controls, actor/tenant fields, or raw review text.

- [ ] **Step 4: Add isolated failing business-invariant tests**

  Independently mutate: one metric, one source/ASIN, one priority, one safety
  theme, one evidence ID, one evidence dimension, one missing-ASIN set, and one
  all-missing status. Ensure each fixture still has the correct facts digest so
  the asserted failure reaches the intended validator branch.

- [ ] **Step 5: Run the invariant tests and verify RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-positioning-contracts.test.ts`
  Expected: FAIL on the first unimplemented semantic invariant.

- [ ] **Step 6: Implement semantic validation and verify GREEN**

  Index facts by theme/evidence. Require exact deterministic metric equality,
  exact source coverage, evidence uniqueness and closure, theme/dimension/source/
  ASIN membership, no priority downgrade, and evidence for every important
  conclusion and P0/P1 action.

- [ ] **Step 7: Refactor without changing behavior**

  Extract pure index/comparison helpers, freeze returned input/results, rerun the
  focused test, and keep every failure attributable to one invariant.

---

### Task 2: Immutable analysis report repository

**Files:**
- Create: `server/db/analysis-report-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Create: `tests/agent/analysis-report-repository.test.ts`

**Interfaces:**
- Consumes: a validated VOC output, AgentRun ID, snapshot/facts identity, Skill/model provenance, actor/tenant/run/project/stage/job and lease authority.
- Produces: `AnalysisReportRepository.publishVocPositioningReport(input): Promise<{ report; created }>` and `listAnalysisReports(input)`.

- [ ] **Step 1: Write failing persistence and replay tests**

  Seed a real project/run/stage/job/snapshot/AgentRun, publish once, replay the
  same AgentRun, and assert one report row/version and identical return value.

- [ ] **Step 2: Run repository tests and verify RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/analysis-report-repository.test.ts`
  Expected: FAIL because the repository interface/methods do not exist.

- [ ] **Step 3: Implement minimal transactional publication**

  In the repository's immediate transaction, validate exact input, reload the
  actor/project/run/stage/job/AgentRun/SkillVersion/snapshot rows, recompute 8.2
  facts from stored snapshot payload, verify active lease and persisted claim
  owner/generation, return an exact existing AgentRun report, otherwise allocate
  `MAX(version)+1`, insert, remap through `AnalysisReportSchema`, and return it.

- [ ] **Step 4: Add failing immutability/history/security race tests**

  Cover update/delete trigger rejection, a second terminal AgentRun creating
  version 2 while version 1 remains unchanged, tenant/actor mismatch, expired or
  replaced lease, claim mismatch, Skill/model/snapshot/facts drift, concurrent
  identical publication, and malformed stored rows.

- [ ] **Step 5: Run repository tests and verify RED for each missing guard**

  Run the same focused command and confirm each new case fails at its intended
  guard rather than at a digest or foreign-key precondition.

- [ ] **Step 6: Implement guards and verify GREEN**

  Add fixed conflict/not-found/data error types, exact idempotency comparison,
  deterministic ordering, and concurrent-safe version allocation. Do not alter
  migrations because existing constraints and triggers are sufficient.

---

### Task 3: VOC execution service through the audited runtime

**Files:**
- Create: `server/services/voc-positioning-execution-service.ts`
- Create: `tests/agent/voc-positioning-execution-service.test.ts`

**Interfaces:**
- Consumes: `DataSnapshotRepository`, `AnalysisReportRepository`,
  `AuditedSkillRunner`, trusted snapshot ID, supplied 8.2 facts, configured model,
  signal, and actor/tenant/lease execution context.
- Produces: `VocPositioningExecutionService.execute(request, context)` returning `{ report, agentRun, replayed }` and fixed domain errors for missing or conflicting input.

- [ ] **Step 1: Write failing full and partial vertical-slice tests**

  Use real scooter and lighting snapshots, the Node Skill loader, real
  SkillRunner/AuditedSkillRunner/budget coordinator/SQLite repository, and a
  legal fake provider response. Assert Skill content was loaded, provider input
  contains only allowed top-level fields, report status/identity/version are
  correct, and the persisted report equals the returned report.

- [ ] **Step 2: Run service tests and verify RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-positioning-execution-service.test.ts`
  Expected: FAIL because the service does not exist.

- [ ] **Step 3: Implement the minimal service**

  Tenant-scope the snapshot load, assert snapshot integrity, parse the supplied
  facts with the public parser, compare run/snapshot/content hash/cutoff, reject
  all-missing before provider dispatch, call the published Skill through
  `AuditedSkillRunner`, then publish the validated report.

- [ ] **Step 4: Add failing identity/replay/failure-path tests**

  Cover same-identity replay and simulated restart without a second provider
  call; crash after AgentRun finalization followed by report completion; facts,
  content hash, Skill and model drift conflicts; malformed JSON/closed schema;
  semantic format repair; transient provider retry; budget exhaustion; cancel;
  and claim/lease loss before report publication.

- [ ] **Step 5: Run service tests and verify RED**

  Confirm failures are caused by missing service behavior, not stale hashes,
  test setup, or the existing generic runtime.

- [ ] **Step 6: Complete service error mapping and verify GREEN**

  Preserve generic runtime errors for Worker classification. Use only fixed
  domain messages, never attach model bodies or facts to exceptions/log entries.

---

### Task 4: Worker and ordinary Node compatibility

**Files:**
- Modify: `tests/agent/voc-positioning-execution-service.test.ts`
- Modify only if required: `server/runtime/worker-loop.ts`

**Interfaces:**
- Consumes: the service execution method as the existing Worker handler body.
- Produces: current Worker outcomes without a second queue/runner abstraction.

- [ ] **Step 1: Add failing Worker integration tests**

  Exercise provider retry/repair success, waiting-input for all-missing facts,
  budget-exceeded, cancellation, and lease takeover. Assert an old owner cannot
  persist a report or settle the stage as successful.

- [ ] **Step 2: Run focused Worker/service tests and verify RED**

  Run: `npx tsx --conditions=react-server --test tests/agent/voc-positioning-execution-service.test.ts tests/agent/worker-loop.test.ts`
  Expected: only genuinely missing adapter behavior fails.

- [ ] **Step 3: Add the smallest adapter/error mapping if needed**

  Keep the existing `JobAttemptWorkerLoop`; translate all-missing to its existing
  `waiting-input` outcome and allow other runtime/budget/cancel/fence errors to
  follow existing paths. If tests show no production change is needed, retain
  tests only.

- [ ] **Step 4: Verify ordinary Node import/execute**

  Run a child `node --import tsx` process without React conditions that imports
  the contract/service modules, loads the Skill, and executes against the fake
  provider. Expected: exit 0 and one persisted report.

---

### Task 5: OpenSpec and complete verification

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md` (only checkbox 8.3)
- Modify: implementation/design/test files from Tasks 1-4 as required by review.

**Interfaces:**
- Consumes: all 8.3 requirements and repository protection list.
- Produces: one reviewable atomic commit on `feat/voc-positioning-skill-execution`.

- [ ] **Step 1: Self-review against every 8.3 invariant**

  Inspect `git diff`, schemas, service, repository, and tests. Confirm no UI,
  external collection, credential flow, old migration, generated data, or
  dependency changes entered scope.

- [ ] **Step 2: Run focused new tests**

  Run all new VOC contracts/repository/service test files and capture exact
  pass/fail counts.

- [ ] **Step 3: Run mandatory gates**

  Run `npm run test:agent`, `npm run skills:validate`, `npm run lint`, the
  repository's actual strict OpenSpec validation command, `npm test`, and
  `git diff --check`. Lint must have 0 errors; known 26 warnings are allowed.

- [ ] **Step 4: Compare TypeScript diagnostics with a plain baseline clone**

  Create an ordinary temporary clone at baseline
  `b0fca9d49ca12d428b86a017af422e5d466f13c3`, run
  `npx tsc --noEmit --incremental false` in baseline and feature, normalize each
  diagnostic to `(file,line,column,TS code)`, and require no feature-only entry.
  Remove only the explicitly verified temporary clone after comparison.

- [ ] **Step 5: Verify protected paths**

  Require zero diff for `package-lock.json`, migrations 0001-0005, and the three
  generated VOC data files. Confirm only OpenSpec 8.3 changed from unchecked to
  checked.

- [ ] **Step 6: Mark only 8.3 complete and commit once**

  Update only the 8.3 checkbox after all gates pass. Stage the exact reviewed
  files and create one atomic commit such as
  `feat(agent): execute VOC positioning skill`. Do not amend/rebase/push/merge.

- [ ] **Step 7: Verify final clean state**

  Run `git status --short --branch`, `git show --stat --oneline HEAD`, and record
  the commit hash plus raw gate summaries and any remaining risk for the main
  window's two read-only reviews.

## Plan self-review

- Every OpenSpec 8.3 and delegated safety invariant maps to Tasks 1-5.
- No placeholder or deferred implementation remains.
- Contract/service/repository type names are consistent across tasks.
- The plan deliberately uses inline execution because the delegating user made
  this window responsible for implementation and prohibited further approval
  questions; no subagent work is required.
