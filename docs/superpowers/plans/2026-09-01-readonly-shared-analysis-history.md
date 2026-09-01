# Read-Only Shared Analysis History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a primary-admin-only PostgreSQL-backed history list and detail page that exposes every formal analysis run without relying on worktree-local project JSON.

**Architecture:** Port the strict read-only portions of `codex/shared-analysis-history-contract`, `codex/shared-analysis-history-backend`, and `codex/shared-analysis-history-web` onto the current integration base. Keep list/detail as an independent SQL read model and omit archive, restore, delete, cancel, and retry mutations in this fast integration.

**Tech Stack:** TypeScript, React, Fastify, Zod, PostgreSQL/SQLite repositories, Node test runner, CSS Modules.

## Global Constraints

- The integration base is exact commit `f3a40342a03f4f08d4eaef21842dff39d53458a0`.
- Primary administrator requires an active repository user with `role === "admin"` and normalized email exactly `admin@example.com`.
- History authority is existing project, analysis run, stage, attempt, snapshot, and report data; legacy `data/projects/*.json` is not the authority.
- This slice is read-only: no archive, restore, permanent delete, cancel, retry, Provider call, project creation, job creation, or run creation.
- Unknown fields and malformed cursor/query/response data fail closed.
- Do not modify VOC, keyword, sync, Provider, or generated analysis data behavior.
- Do not push, deploy, invoke Provider, or write live business data.

---

### Task 1: Port Strict Read-Only History Contracts and Repository

**Files:**
- Create: `server/db/analysis-history-repository.ts`
- Create: `server/domain/analysis-history.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `server/db/repository.ts`
- Modify: `server/db/postgres-repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Test: `tests/agent/analysis-history-contract.test.ts`
- Test: existing PostgreSQL and SQLite repository tests selected by the implementer.

**Interfaces:**
- Produces: `listAnalysisHistory(input): Promise<{records, hasMore}>` and `findAnalysisHistoryDetail(input): Promise<AnalysisHistoryDetailRecord | null>`.
- Produces strict `GET /v1/analyses` and `GET /v1/analyses/:runId` response schemas; no mutation contracts.

- [ ] **Step 1: Write RED contract/repository tests.** Require fixed 20-item keyset pagination, `updatedAt DESC, runId DESC`, project/ASIN/creator search, exact status mapping, stage-derived progress, detail stage/attempt/report summaries, organization scoping, and malformed cursor rejection.

```ts
assert.equal(ListAnalysisHistoryResponseSchema.parse(payload).analyses.length, 1);
assert.equal(payload.analyses[0].project.asins[0], "B0TEST0001");
assert.equal(payload.analyses[0].progress.percent, 100);
assert.equal(await repository.findAnalysisHistoryDetail({ actorOrganizationId: otherOrg, runId }), null);
```

- [ ] **Step 2: Verify RED.** Run the focused contract and repository tests. Expected: missing schemas/repository methods.
- [ ] **Step 3: Port the minimum read-only implementation.** Use the three existing shared-history branches as references, but copy only list/detail domain types, strict schemas, cursor helpers, SQL/SQLite queries, bounded attempts and report summaries. Do not port migrations or mutation methods.
- [ ] **Step 4: Verify GREEN.** Re-run focused contract plus PostgreSQL/SQLite repository tests. Expected: all pass and no test writes outside its temporary database.
- [ ] **Step 5: Commit.** Commit only the read-only contract/repository paths with `git commit -m "feat(history): read formal analysis history"`.

### Task 2: Add Primary-Admin History API and Pages

**Files:**
- Modify: `server/services/analysis-run-service.ts`
- Modify: `server/routes/analysis-runs.ts`
- Modify: `server/auth/authorization.ts`
- Modify: `server/app.ts`
- Create: `app/lib/analysis-history-client.ts`
- Create: `app/analyses/page.tsx`
- Create: `app/analyses/[runId]/page.tsx`
- Create: `app/analyses/analysis-history-page.tsx`
- Create: `app/analyses/analysis-history-detail-page.tsx`
- Create: `app/analyses/analysis-history.module.css`
- Test: `tests/agent/analysis-history-client.test.ts`
- Test: `tests/agent/analysis-history-page.test.tsx`
- Test: `tests/agent/analysis-history-detail-page.test.tsx`

**Interfaces:**
- Consumes: read-only repository methods from Task 1 and repository-loaded primary-admin identity.
- Produces: primary-admin-only `GET /v1/analyses`, `GET /v1/analyses/:runId`, `/analyses`, and `/analyses/{runId}`.

- [ ] **Step 1: Write RED API/UI tests.** Primary admin can list/read; ordinary admin/member receive 403; unauthenticated receives 401; cross-organization run receives 404. UI renders status, ASINs, progress, timestamps, partial gaps and report availability, while refresh remains GET-only.

```ts
assert.equal((await listAs(primaryAdmin)).statusCode, 200);
assert.equal((await listAs(ordinaryAdmin)).statusCode, 403);
assert.match(renderHistory(item), /部分结果/);
assert.equal(observedMutations, 0);
```

- [ ] **Step 2: Verify RED.** Run the three focused history API/UI test files. Expected: routes/pages are missing.
- [ ] **Step 3: Implement the minimum API and pages.** Reuse the old web branch's safe client/page patterns, remove every mutation control and polling POST, authorize through repository-loaded primary administrator, and preserve last successful GET view on transient read failure.
- [ ] **Step 4: Verify GREEN and affected checks.** Run focused history tests, authorization/contracts tests, changed-file ESLint, and `npm run build`.
- [ ] **Step 5: Commit.** Commit the API/UI slice with `git commit -m "feat(history): add primary admin history pages"`.
