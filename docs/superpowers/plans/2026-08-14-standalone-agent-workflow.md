# Standalone Amazon Analysis Agent Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use executing-plans to implement this plan task-by-task. Use test-driven-development for every feature or bug fix, verification-before-completion before claiming success, and requesting-code-review before merging each task branch.

**Goal:** Build a standalone, server-deployable analysis-agent workflow from the repository's three ZIP Skills while keeping the existing TypeScript analysis available as a safe fallback.

**Architecture:** Keep vinext as the Web process on port 3001 for UI, login, and a thin same-origin proxy. Add an ordinary Node Agent Service on port 3100 containing the Analysis API, durable worker loop, static TypeScript dependency graph, SQLite/PostgreSQL repositories, OpenAI runtime, Skill registry, and MCP connectors. Agents exchange versioned JSON artifacts; they do not recursively invoke one another or run an open-ended conversation.

**Tech Stack:** TypeScript 5.9, Node.js >=22.13, vinext/React 19, Fastify, Zod, OpenAI JavaScript SDK with Responses API, `node:sqlite` for local development, `pg` for production, Node test runner through `tsx`, and Playwright for browser acceptance tests.

## Global Constraints

- Work from integration branch `feature/agent-runtime-mvp`; each task below gets its own short-lived branch and worktree.
- Never commit directly to `main`; merge reviewed task branches into the integration branch first.
- Preserve the existing deterministic TypeScript calculations and existing report as the default production result until evaluation gates pass.
- Do not execute code from the ZIP files. Expand approved Markdown and references into a reviewable source tree and verify content hashes.
- Do not read `~/.cursor/mcp.json`. Secrets exist only in Agent Service environment variables or production secret storage.
- Send only allowlisted, minimal structured analysis data to OpenAI. Never send connector secrets, cookies, user identity, raw database files, or unrelated records.
- Enforce per-call, per-run, and per-day budgets before making a model request. Retries are finite.
- MVP orchestration is handwritten TypeScript. LangChain and LangGraph are explicitly out of scope; a later spike may reuse the same contracts and evaluation fixtures.
- Approval workflows, an autonomous Amazon browser collector, and dynamic/cyclic multi-agent conversation are separate future OpenSpec changes.

## Target File Map

```text
shared/
  agent-contracts.ts
server/
  app.ts
  index.ts
  config.ts
  auth/
  connectors/
  db/
  orchestrator/
  reports/
  runtime/
  skills/
  snapshots/
skills-src/
  analyze-amazon-competitor-traffic/
  define-amazon-voc-positioning/
  define-amazon-product-from-voc-keywords/
app/
  api/agent/[...path]/route.ts
  lib/agent-service-client.ts
tests/agent/
```

## Shared Interfaces

Create these contracts first and import them from both processes; do not duplicate request or result shapes.

```ts
export type StageName =
  | "traffic-analysis"
  | "voc-positioning"
  | "product-definition";

export type StageStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "succeeded"
  | "failed"
  | "budget-exceeded"
  | "cancelled"
  | "stale";

export interface AnalysisRun {
  id: string;
  projectId: string;
  status: StageStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AnalysisReport<T = unknown> {
  id: string;
  runId: string;
  stage: StageName;
  schemaVersion: string;
  skillVersion: string;
  snapshotIds: string[];
  result: T;
  createdAt: string;
}
```

The first API surface is versioned under `/v1`:

```text
GET    /health
GET    /v1/capabilities
POST   /v1/auth/login
POST   /v1/auth/logout
POST   /v1/projects
GET    /v1/projects/:projectId
POST   /v1/projects/:projectId/runs
GET    /v1/runs/:runId
POST   /v1/runs/:runId/cancel
POST   /v1/runs/:runId/stages/:stage/retry
GET    /v1/runs/:runId/reports
GET    /v1/reports/:reportId
```

## Task 1: Restore the Baseline and Scaffold the Agent Service

**Branch:** `chore/agent-runtime-baseline`

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `server/config.ts`
- Create: `server/app.ts`
- Create: `server/index.ts`
- Create: `tests/agent/health.test.ts`
- Create: `.env.example`
- Modify: `README.md`

**Steps:**

- [ ] Stop repository dev processes, capture the current lockfile diff, and identify which changes predate this task.
- [ ] Run `npm install` once from the repository root so `package-lock.json` matches `package.json`; do not manually edit dependency resolutions.
- [ ] Run `npm run build`, `npm test`, and `npm run lint`. Record genuine pre-existing failures in the PR description.
- [ ] Add `fastify`, `zod`, `openai`, `pg`, `tsx`, and required type packages using npm.
- [ ] Add scripts: `agent:dev`, `agent:start`, `test:agent`, and `test:agent:watch`.
- [ ] Write `health.test.ts` first. It starts `buildAgentApp()` in memory and expects `{ status: "ok", service: "agent-service" }` from `GET /health`.
- [ ] Run `npm run test:agent -- tests/agent/health.test.ts` and confirm the test fails because the service does not exist.
- [ ] Implement config validation, `buildAgentApp()`, request IDs, structured errors, and graceful shutdown; bind to `127.0.0.1:3100` by default.
- [ ] Re-run the focused test, then `npm run test:agent`.
- [ ] Update `.env.example` and README with separate Web and Agent Service startup commands.
- [ ] Commit with `chore(agent): scaffold standalone node service`.

## Task 1A: Repair the Existing Repository Gates

**Branch:** `fix/development-baseline`

**Files:**

- Modify: `tests/rendered-html.test.mjs`
- Modify only when required by a reported ESLint error: `app/asin-sync-funnel.tsx`
- Modify only when required by a reported ESLint error: `app/keyword-demand-section.tsx`
- Modify only when required by a reported ESLint error: `app/launch-checklist-section.tsx`
- Modify only when required by a reported ESLint error: `app/page.tsx`
- Modify only when required by a reported ESLint error: `app/project-library-panel.tsx`
- Modify only when required by a reported ESLint error: `app/variant-analysis-conclusion.ts`
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Steps:**

- [ ] Reproduce `npm test` and preserve the two stale starter-preview failures as the diagnostic baseline.
- [ ] Replace assertions for `codex-preview`, `Your site is taking shape`, and deleted `_sites-preview` files with stable server-rendered contracts for the current Amazon application: HTTP 200, HTML content type, current title/description, Amazon brand shell, and primary navigation labels.
- [ ] Run the rendered HTML test twice to prove deterministic green output without changing application behavior.
- [ ] Reproduce the 13 ESLint errors and group them by rule and component before editing.
- [ ] Fix each error with the smallest behavior-preserving code change. Do not disable React Compiler rules, add blanket ESLint suppressions, relax the ESLint configuration, or convert errors into warnings.
- [ ] For state/effect refactors, preserve request timing, cancellation, loading, and retry behavior; add a focused regression test when an existing test seam is available, otherwise document the missing seam in the review report.
- [ ] Verify `npm test`, `npm run lint`, `npm run test:agent`, `npm run build`, `openspec validate build-standalone-agent-workflow --strict`, and `git diff --check`.
- [ ] Mark OpenSpec task 1.4 complete only after both repository gates exit zero.
- [ ] Commit with `fix: restore repository test and lint baseline`.

## Task 2: Define Contracts and the vinext Proxy

**Branch:** `feat/agent-service-contracts`

**Files:**

- Create: `shared/agent-contracts.ts`
- Create: `server/routes/capabilities.ts`
- Create: `app/lib/agent-service-client.ts`
- Create: `app/api/agent/[...path]/route.ts`
- Create: `tests/agent/contracts.test.ts`
- Create: `tests/agent/proxy.test.ts`

**Steps:**

- [ ] Define Zod schemas for users, projects, snapshots, runs, stages, attempts, reports, API errors, and every `/v1` request/response.
- [ ] Write contract tests that reject unknown status values, absent schema versions, invalid ASINs, and report results without provenance.
- [ ] Add `GET /v1/capabilities` with explicit states for storage, OpenAI, SIF, Sorftime, SellerSprite, and manual VOC import.
- [ ] Write proxy tests proving a browser request receives the Agent Service response while the internal base URL and proxy token never appear in the response body or headers.
- [ ] Implement a server-only client with timeout, response-size limit, request ID forwarding, and normalized errors.
- [ ] Implement the same-origin vinext catch-all proxy; allowlist methods and paths instead of forwarding arbitrary URLs.
- [ ] Verify `npm run test:agent -- tests/agent/contracts.test.ts tests/agent/proxy.test.ts`.
- [ ] Commit with `feat(agent): define web service contracts`.

## Task 2A: Complete the Agent Service Reproduction Foundation

**Branch:** `feat/agent-service-foundation`

**Files:**

- Modify: `server/app.ts`
- Modify: `server/config.ts`
- Modify: `server/index.ts`
- Modify: `server/routes/capabilities.ts`
- Modify: `app/lib/agent-service-client.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Create: `tests/agent/service-security.test.ts`

**Steps:**

- [ ] Write failing tests for request-body limits, request deadlines, trusted origins, internal proxy authentication, and log redaction.
- [ ] Complete graceful shutdown and health/capability behavior for Agent Service offline, missing configuration, and unavailable connectors.
- [ ] Document the local two-process startup flow without requiring Codex or Cursor.
- [ ] Verify direct unauthenticated `/v1` requests fail while the vinext proxy succeeds.
- [ ] Verify focused tests, the full Agent suite, build, lint, and OpenSpec strict validation.
- [ ] Commit with `feat(agent): complete standalone service foundation`.

## Task 3: Add SQLite Persistence and Leases

**Branch:** `feat/agent-persistence`

**Files:**

- Create: `server/db/schema.ts`
- Create: `server/db/migrations/0001_agent_runtime.sql`
- Create: `server/db/sqlite-repository.ts`
- Create: `server/db/repository.ts`
- Create: `server/routes/projects.ts`
- Create: `tests/agent/repository.test.ts`

**Steps:**

- [ ] Write repository tests for WAL mode, foreign keys, unique idempotency keys, immutable reports, atomic job claiming, lease expiry, and restart recovery.
- [ ] Create migrations for `users`, `sessions`, `projects`, `analysis_runs`, `run_stages`, `job_attempts`, `data_snapshots`, `skill_versions`, `agent_runs`, `analysis_reports`, `connector_status`, and `audit_events`.
- [ ] Define a storage-neutral `AgentRepository` interface. No route or orchestrator may issue SQL directly.
- [ ] Implement SQLite transactions and compare-and-set lease acquisition using `node:sqlite`.
- [ ] Verify the focused tests, then the full Agent Service suite.
- [ ] Commit with `feat(agent): add durable SQLite storage`.

Internal authentication is intentionally deferred until the reproduction vertical slice and legacy-comparison gate pass. The repository contracts must keep ownership fields so authentication can be added later without rewriting analysis data.

## Task 4: Expand and Validate the Three Skills

**Branch:** `feat/versioned-skill-registry`

**Files:**

- Create: `skills-src/analyze-amazon-competitor-traffic/`
- Create: `skills-src/define-amazon-voc-positioning/`
- Create: `skills-src/define-amazon-product-from-voc-keywords/`
- Create: `server/skills/manifest.ts`
- Create: `server/skills/registry.ts`
- Create: `scripts/validate-agent-skills.ts`
- Create: `tests/agent/skill-registry.test.ts`

**Steps:**

- [ ] Expand the three ZIP archives into named reviewable directories, preserving the ZIP files as source evidence.
- [ ] Add one manifest per Skill containing semantic version, content hash, entry Markdown, allowed references, input schema name, output schema name, and evaluation fixture names.
- [ ] Write failing tests for an absent entry file, path traversal, an undeclared reference, duplicate ID/version, and hash mismatch.
- [ ] Implement a registry that reads only declared Markdown/reference files and never evaluates scripts from an archive.
- [ ] Add `npm run skills:validate` and make it print stable Skill ID, version, and hash values.
- [ ] Verify `npm run skills:validate` and the registry tests.
- [ ] Commit with `feat(agent): register versioned analysis skills`.

## Task 5: Implement the Durable Worker and Static Orchestrator

**Branch:** `feat/static-analysis-orchestrator`

**Files:**

- Create: `server/orchestrator/analysis-orchestrator.ts`
- Create: `server/orchestrator/stage-definitions.ts`
- Create: `server/runtime/worker-loop.ts`
- Create: `server/runtime/retry-policy.ts`
- Create: `server/routes/runs.ts`
- Create: `tests/agent/orchestrator.test.ts`
- Create: `tests/agent/worker-loop.test.ts`

**Dependency graph:**

```text
traffic-analysis --------------------------> report
voc-positioning ---------------------------> report
voc-positioning + keyword-analysis --------> product-definition
```

**Steps:**

- [ ] Write orchestration tests proving traffic and VOC may run independently, product definition waits for both dependencies, failed independent stages preserve successful reports, retry targets one stage, and changed upstream snapshots mark downstream reports stale.
- [ ] Write worker tests for one claimant per lease, heartbeat renewal, expired lease recovery, graceful shutdown, finite backoff, cancellation, `waiting-input`, and `budget-exceeded`.
- [ ] Implement pure functions `findRunnableStages(run)` and `markDownstreamStale(stage)` before adding database effects.
- [ ] Implement run creation with an idempotency key and transactional stage/job creation.
- [ ] Implement the polling worker loop around repository leases. Do not use in-memory queues as the source of truth.
- [ ] Add run status, cancel, and stage retry routes with role checks.
- [ ] Verify worker/orchestrator tests including two concurrent worker instances.
- [ ] Commit with `feat(agent): add durable static orchestration`.

## Task 6: Implement the OpenAI Responses Runtime

**Branch:** `feat/openai-skill-runtime`

**Files:**

- Create: `server/runtime/model-provider.ts`
- Create: `server/runtime/openai-provider.ts`
- Create: `server/runtime/skill-runner.ts`
- Create: `server/runtime/budget-policy.ts`
- Create: `server/runtime/redaction.ts`
- Create: `tests/agent/openai-provider.test.ts`
- Create: `tests/agent/skill-runner.test.ts`

**Provider interface:**

```ts
export interface StructuredGenerationRequest<T> {
  model: string;
  instructions: string;
  input: unknown;
  outputSchema: z.ZodType<T>;
  maxOutputTokens: number;
  timeoutMs: number;
}

export interface ModelProvider {
  generateStructured<T>(request: StructuredGenerationRequest<T>): Promise<{
    value: T;
    responseId: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}
```

**Steps:**

- [ ] Use a fake provider to write tests for allowlisted input, secret-field rejection, output validation, one schema-repair attempt, at most two transient retries, timeout, and no retry for permanent failures.
- [ ] Write budget tests proving that per-call, per-run, or daily exhaustion prevents provider invocation.
- [ ] Implement the provider using the official OpenAI SDK and Responses API structured output; keep model selection in admin configuration, not Skill content.
- [ ] Persist response ID, model, token counts, duration, estimated cost, Skill version, and snapshot IDs; redact ordinary logs.
- [ ] Reject requested tools, recursive agent calls, and undeclared inputs.
- [ ] Verify all tests with the fake provider; keep the live smoke test opt-in through `OPENAI_LIVE_TEST=1`.
- [ ] Commit with `feat(agent): execute skills through openai responses`.

## Task 7: Deliver the VOC Vertical Slice from Existing Data

**Branch:** `feat/voc-agent-slice`

**Files:**

- Create: `server/snapshots/existing-voc-snapshot.ts`
- Create: `server/reports/voc-report.ts`
- Create: `server/agents/voc-positioning-agent.ts`
- Modify: `app/voc-positioning.ts`
- Modify: the current VOC page component identified by `rg -n "voc-positioning|VOC" app`
- Create: `tests/agent/voc-agent.test.ts`
- Create: `tests/agent/voc-slice.e2e.ts`

**Steps:**

- [ ] Locate current generated VOC/review inputs and write a snapshot builder that records source path, source type, checksum, capture/import time, marketplace, and ASIN scope without modifying source files.
- [ ] Extract deterministic theme totals, percentages, evidence indexes, and P0 safety classification into reusable pure functions covered against legacy fixtures.
- [ ] Define a versioned VOC result schema containing findings, evidence references, uncertainties, safety constraints, and provenance.
- [ ] Write the Agent test with a fake model response, including missing-data and malformed-output cases.
- [ ] Implement Skill execution and immutable report persistence.
- [ ] Add Web UI actions to create a run, poll stage state, show retry/waiting-input errors, display the agent result beside the legacy result, and reopen historical versions.
- [ ] Add an E2E test for `existing data -> Skill -> fake OpenAI -> SQLite -> page -> browser refresh`.
- [ ] Verify focused tests, `npm run build`, and the browser test.
- [ ] Commit with `feat(voc): add standalone agent vertical slice`.

## Task 8: Build the New-versus-Legacy Evaluation Gate

**Branch:** `test/agent-evaluation-gate`

**Files:**

- Create: `tests/fixtures/agent-eval/scooter-complete.json`
- Create: `tests/fixtures/agent-eval/lighting-complete.json`
- Create: `tests/fixtures/agent-eval/missing-input.json`
- Create: `tests/fixtures/agent-eval/conflicting-scope.json`
- Create: `tests/fixtures/agent-eval/safety-p0.json`
- Create: `server/evaluation/evaluate-report.ts`
- Create: `server/evaluation/human-rubric.ts`
- Create: `tests/agent/evaluation.test.ts`
- Create: `server/feature-flags.ts`

**Steps:**

- [ ] Freeze the five de-identified fixtures and deterministic expected values before changing which output is primary.
- [ ] Check schema validity, numeric invariants, evidence existence, scope boundaries, unsupported claims, safety downgrade, missing-data behavior, historical immutability, and fallback.
- [ ] Store human rubric scores for usefulness, evidence traceability, conservatism, and actionability with evaluator and timestamp.
- [ ] Add module-level flags `off`, `shadow`, and `primary`; default VOC to `shadow` and the other modules to `off`.
- [ ] Prove disabling a flag immediately restores the legacy primary result without deleting agent reports.
- [ ] Commit with `test(agent): add legacy comparison release gate`.

## Task 9: Add Traffic and Product-definition Agents

**Branch:** `feat/remaining-analysis-agents`

**Files:**

- Create: `server/agents/traffic-analysis-agent.ts`
- Create: `server/agents/product-definition-agent.ts`
- Create: `server/reports/traffic-report.ts`
- Create: `server/reports/product-definition-report.ts`
- Modify: `app/traffic-analysis-conclusion.ts`
- Modify: `app/final-product-definition.ts`
- Create: `tests/agent/traffic-agent.test.ts`
- Create: `tests/agent/product-definition-agent.test.ts`

**Steps:**

- [ ] Reuse existing deterministic traffic aggregation; test that traffic opportunity is never labelled as profitability evidence.
- [ ] Execute the traffic Skill against immutable snapshots and persist a versioned report.
- [ ] Keep traffic and VOC independent in orchestration and error presentation.
- [ ] Make product definition depend on successful VOC and keyword-analysis snapshots; enter `waiting-input` when either is absent.
- [ ] Preserve current project-approval boundaries: the generated product definition is analysis material, not an approval decision.
- [ ] Display and export all three modules through the same saved report protocol.
- [ ] Run the five-fixture gate for every agent before moving any flag from `off` to `shadow`.
- [ ] Commit with `feat(agent): add traffic and product definition agents`.

## Task 10: Remove Cursor Fallbacks and Add Governed Connectors

**Branch:** `refactor/server-connectors`

**Files:**

- Create: `server/connectors/connector.ts`
- Create: `server/connectors/sif.ts`
- Create: `server/connectors/sorftime.ts`
- Create: `server/connectors/sellersprite.ts`
- Create: `server/snapshots/manual-voc-import.ts`
- Modify: existing connector scripts found by `rg -n "cursor/mcp|SIF_MCP_SECRET|SORFTIME_MCP_KEY|SELLERSPRITE_SECRET_KEY" scripts app`
- Create: `tests/agent/connectors.test.ts`
- Create: `tests/agent/manual-voc-import.test.ts`

**Steps:**

- [ ] Write connector-contract tests for timeout, rate limit, finite retry, malformed MCP response, credential absence, redacted errors, and provenance metadata.
- [ ] Read credentials only from Agent Service configuration: `SIF_MCP_SECRET`, `SORFTIME_MCP_KEY`, and `SELLERSPRITE_SECRET_KEY`.
- [ ] Remove all Cursor configuration lookup and user-facing instructions that require Cursor.
- [ ] Wrap existing acquisition steps as snapshot-producing jobs; stop treating generated page TypeScript as a production publishing mechanism.
- [ ] Keep Amazon/Alexa text paste and file import. Validate size, encoding, ASIN/project scope, and content type; resume `waiting-input` stages after a valid import.
- [ ] Add admin-only connector health and audit endpoints without revealing credentials.
- [ ] Verify `rg -n "\.cursor|cursor/mcp" app server scripts` returns no runtime dependency.
- [ ] Commit with `refactor(agent): centralize governed data connectors`.

## Task 11: Add PostgreSQL and Complete Release Verification

**Branch:** `feat/agent-production-readiness`

**Files:**

- Create: `server/db/postgres-repository.ts`
- Create: `server/db/migrations/postgres/0001_agent_runtime.sql`
- Create: `tests/agent/postgres-repository.test.ts`
- Create: `tests/agent/security.test.ts`
- Create: `tests/agent/restart-recovery.test.ts`
- Modify: `README.md`
- Modify: `.env.example`
- Modify: deployment/service configuration selected by the repository owner

**Steps:**

- [ ] Run the same repository contract suite against PostgreSQL, including atomic claims, transactions, idempotency, lease recovery, and immutable report history.
- [ ] Add production configuration validation for PostgreSQL URL, proxy authentication, cookie security, trusted origins, request limits, and secret presence.
- [ ] Verify Web restart does not lose work and Agent Service restart reclaims expired leases without duplicating completed stages.
- [ ] Run security tests for member/admin access, secret redaction, input minimization, request-size limits, session revocation, connector isolation, and budget bypass attempts.
- [ ] Run `npm run test:agent`, `npm run build`, `npm test`, and `npm run lint`.
- [ ] Run Playwright acceptance for login, existing-data VOC run, progress recovery after refresh, stage retry, historical version reading, legacy fallback, and Agent Service offline messaging.
- [ ] Run `openspec validate build-standalone-agent-workflow --strict`.
- [ ] Review `git diff --check` and confirm `package-lock.json` contains only approved dependency changes.
- [ ] Commit with `feat(agent): complete production runtime hardening`.

## Integration and Review Order

Merge into `feature/agent-runtime-mvp` only in this order:

1. Task 1 baseline
2. Task 2 contracts
3. Task 2A Agent Service reproduction foundation
4. Task 4 Skill registry
5. Task 6 OpenAI runtime with a fake provider
6. Task 3 SQLite persistence without authentication
7. Task 5 orchestrator
8. Task 7 VOC vertical slice
9. Task 8 evaluation gate
10. Task 9 remaining agents
11. Task 10 connectors
12. OpenSpec task 4.3 internal authentication
13. Task 11 PostgreSQL and production readiness

After each merge, run `npm run test:agent` and `npm run build`. Before proposing integration into `main`, run the entire Task 11 verification set and obtain human rubric sign-off on all five fixtures.

## Optional Learning Spike: LangGraph, Not Part of MVP

After the MVP gate passes, create branch `spike/langgraph-orchestration`. Reimplement only the static orchestration adapter behind the same `AnalysisOrchestrator` interface, run the identical worker/restart/evaluation tests, and compare code size, observability, recovery behavior, and maintenance cost. Do not merge unless it produces a measurable advantage; this keeps the exercise technically useful without making the production path framework-driven.
