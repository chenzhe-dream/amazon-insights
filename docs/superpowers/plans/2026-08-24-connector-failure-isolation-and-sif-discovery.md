# Connector Failure Isolation And SIF Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep schema failures local to one ASIN and stage, prevent legacy schema diagnostics from poisoning connector health, and make truthful SIF results discoverable from terminal sync UI.

**Architecture:** Add a fail-closed filter at the Worker mirror-to-`connector_status` boundary while leaving the existing runner breaker behavior intact. Extend the pure sync-progress presentation with truthful terminal row states and status-only SIF destinations, then render navigation in the existing funnel without starting another job.

**Tech Stack:** TypeScript, Node.js, SQLite repository test seam, React 19, Next.js/Vinext, Playwright, Node test runner.

## Global Constraints

- Preserve strict SellerSprite, SIF, and Sorftime schemas; do not accept arbitrary objects or fabricate fallback business data.
- `schema`/`MCP_SCHEMA` is local to connector + ASIN + stage and must never write global `connector_status=unavailable`.
- Preserve current behavior for DNS, TLS, proxy, connection, timeout, HTTP, RPC, and governor failures.
- No production ASIN special cases; tests use synthetic fixtures only.
- SIF readiness may create navigation metadata only. It must not populate SellerSprite/Sorftime title, price, review, sales, image, or catalog fields.
- Do not call a real MCP, browser provider session, deployment endpoint, capability probe, or business POST while implementing or verifying this plan.
- Protect these 15 modified generated files: `app/competitor-data.ts`, `app/listing-image-remarks.ts`, `app/sif-keyword-analysis-data.ts`, `app/sif-keyword-enrichment-data.ts`, `app/sif-listing-traffic-raw-data.ts`, `app/sif-monthly-traffic-trend-raw-data.ts`, `app/sorftime-category-trend-data.ts`, `app/sorftime-child-sales-data.ts`, `app/sorftime-fba-fee-data.ts`, `app/sorftime-listing-content-data.ts`, `app/sorftime-price-strategy-data.ts`, `app/sorftime-rating-data.ts`, `app/sorftime-review-analysis-data.ts`, `app/sorftime-sales-trend-data.ts`, and `app/variant-data.ts`.
- Also protect `.superpowers/sdd/task-3-report.md` and these seven untracked files: `data/projects/34020241-202f-43b0-ac11-3d6ec44c033c.json`, `data/projects/3655cd71-3843-49b7-8866-ec672e2e124d.json`, `data/projects/4d49aafa-029d-41b2-a101-c8891048f857.json`, `data/projects/a0478af8-27d4-4970-a6db-2a90eda4a54b.json`, `data/projects/a081d838-ffcb-4e36-b4ad-e38937f7336a.json`, `data/projects/d47d71a0-c00c-4632-a9c8-855e55bbbbdb.json`, and `data/projects/deae416a-8726-4afd-a6d3-71fe2b016c03.json`.
- Never use `git add .`, `git reset`, `git stash`, or `git checkout`. Stage only the explicit files listed in each task.

---

### Task 1: Worker Boundary Rejects Schema Degradation

**Files:**
- Modify: `server/services/sync-job-worker-handler.ts:590-650`
- Modify: `tests/agent/sync-provider-degraded-admin.test.ts`
- Verify: `scripts/lib/provider-diagnostics.mjs`
- Verify: `tests/scripts/provider-degradation.test.mjs`
- Verify: `tests/agent/sync-job-production-main-resume.test.ts`

**Interfaces:**
- Consumes: mirror field `providerDegraded: unknown`, `ConnectorStatusRepository.upsertConnectorStatus(status: ConnectorStatusRecord)`, and the real `SyncJobWorkerHandler.handle(lease)` path.
- Produces: private `providerDegradations(mirror): readonly { connector: ConnectorStatusRecord["connector"]; failureKind: string; causeCode: string }[]`, where neither `failureKind === "schema"` nor `causeCode === "MCP_SCHEMA"` is publishable.
- Preserves: the existing publish path and exact unavailable record for DNS/TLS/proxy/connection/timeout/HTTP/RPC/governor entries.

- [ ] **Step 1: Write RED tests through the real Worker and repository seam**

Extend `tests/agent/sync-provider-degraded-admin.test.ts` to use `SyncJobWorkerHandler`, a temporary mirror directory, and `openSqliteAgentRepository` as the `ConnectorStatusRepository`. Seed one active user whose `organizationId` equals `fakeLease().job.organizationId` before the Worker writes connector status. Keep the existing in-memory `SyncJobRepository` only for lease lifecycle callbacks, and close/remove the SQLite fixture in `t.after`.

Before editing, capture SHA-256 hashes for every protected file listed in Global Constraints into `$env:TEMP\connector-isolation-protected.json`; Task 3 must recompute and compare the same sorted path/hash records.

Add one legacy/tampered mirror case containing all of the following; after `handle`, assert `findConnectorStatus(organizationId, "sif") === null`:

```ts
providerDegraded: [
  { connector: "sif", failureKind: "schema", causeCode: "MCP_SCHEMA" },
  { connector: "sif", failureKind: "schema", causeCode: "DNS_NOT_FOUND" },
  { connector: "sif", failureKind: "dns", causeCode: "MCP_SCHEMA" },
  { connector: "unknown", failureKind: "schema", causeCode: "MCP_SCHEMA" },
  { connector: "sif", failureKind: "provider-degraded", causeCode: "MCP_SCHEMA" },
  null,
]
```

Parameterize the existing provider-wide test with the exact retained matrix and assert the repository record, not only an in-memory call count:

```ts
const providerWide = [
  ["dns", "DNS_NOT_FOUND"],
  ["tls", "TLS_CERTIFICATE"],
  ["proxy", "PROXY_CONNECT"],
  ["connection", "CONNECTION_REFUSED"],
  ["timeout", "REQUEST_TIMEOUT"],
  ["http", "HTTP_5XX"],
  ["rpc", "MCP_RPC"],
  ["governor", "RESOURCE_GOVERNOR"],
] as const;
```

For every row require `health === "unavailable"`, the same connector and organization, `lastError.code === "probe-failed"`, the fixed bounded message, and no secret/body/URL material.

- [ ] **Step 2: Run RED and identify the exact leak**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-provider-degraded-admin.test.ts
```

Expected: FAIL because current `providerDegradations` accepts allowlisted `schema`/`MCP_SCHEMA` entries and publishes unavailable; provider-wide matrix cases continue passing.

- [ ] **Step 3: Add the minimal Worker persistence filter**

In `providerDegradations`, keep all existing connector/failure/code allowlist checks, then reject schema by either dimension before returning a publishable item:

```ts
if (failureKind === "schema" || causeCode === "MCP_SCHEMA") return [];
return [{
  connector: connector as ConnectorStatusRecord["connector"],
  failureKind,
  causeCode,
}];
```

Do not change `createProviderDegradationTracker`, `classifyProviderFailure`, `#publishProviderDegradation`, or any provider-wide failure mapping in this task.

- [ ] **Step 4: Run GREEN and backend regressions**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-provider-degraded-admin.test.ts tests/agent/sync-job-production-main-resume.test.ts
node --test tests/scripts/provider-degradation.test.mjs
npx eslint server/services/sync-job-worker-handler.ts tests/agent/sync-provider-degraded-admin.test.ts --quiet
```

Expected: all selected tests pass with zero failures/skips; the three-connector `MCP_SCHEMA` cases stay local, and every provider-wide matrix case retains its exact previous unavailable state.

- [ ] **Step 5: Review and commit Task 1 only**

Run `git diff --check -- server/services/sync-job-worker-handler.ts tests/agent/sync-provider-degraded-admin.test.ts`, confirm no protected path is staged, then:

```powershell
git add -- server/services/sync-job-worker-handler.ts tests/agent/sync-provider-degraded-admin.test.ts
git diff --cached --name-status
git commit -m "fix: isolate schema failures at worker health boundary"
```

Expected staged set: exactly the two Task 1 files. This commit is independently reviewable and deployable.

---

### Task 2: Truthful Gap Rows And SIF Discovery Navigation

**Files:**
- Modify: `app/lib/sync-progress-presentation.ts`
- Modify: `app/asin-sync-funnel.tsx:550-690`
- Modify: `tests/agent/asin-sync-session.test.ts`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`

**Interfaces:**
- Consumes: `SyncJob.asinProgress`, current workspace pathname/search, and existing `tab=keywords | traffic` routes.
- Produces: `SifDiscoveryDestination = { tab: "keywords" | "traffic"; label: "查看关键词调研" | "查看竞品流量分析" }` and `SyncProgressPresentation.sifDestinations: readonly SifDiscoveryDestination[]`.
- Preserves: `presentSyncProgress(job, now, focusStageIds)`, top-level execution/completeness calculations, active-stage timing, GET-only refresh, terminal retention, dismiss, and explicit restart.

- [ ] **Step 1: Write pure RED tests for row truth and SIF readiness**

In `tests/agent/asin-sync-session.test.ts`, name the pure case `terminal progress presentation keeps partial and skipped rows as data gaps` and assert terminal `partial` and `skipped` automatic rows use no successful percentage:

```ts
const terminalGapJob: SyncJob = {
  ...syncJob(),
  status: "completed-with-gaps",
  stages: [
    { id: "keywords", label: "Keywords", kind: "auto", status: "partial", estimatedSeconds: 10 },
    { id: "traffic", label: "Traffic", kind: "auto", status: "skipped", estimatedSeconds: 10 },
  ],
  asinProgress: mixedCompletenessProgress(),
};
const result = presentSyncProgress(terminalGapJob, Date.parse("2026-08-24T00:00:00.000Z"));
assert.equal(result.executionPercent, 100);
assert.ok(result.completenessPercent < 100);
for (const id of ["keywords", "traffic"]) {
  const row = result.rows.find(candidate => candidate.id === id);
  assert.equal(row?.executionPercent, 0);
  assert.equal(row?.statusCopy, "流程已结束 · 数据缺口");
}
```

Name the second pure case `SIF discovery destinations come only from ready status`. Build `asinProgress` fixtures proving destinations are status-only: one ready `keywords` module yields only “查看关键词调研”; one ready `traffic` module yields only “查看竞品流量分析”; both ready yield both in fixed keyword-then-traffic order; no ready SIF module yields none.

- [ ] **Step 2: Write browser RED for navigation and lifecycle preservation**

Add browser case `SIF discovery navigation preserves run job and remains GET-only`. Extend the existing terminal fixture so at least one target ASIN has `keywords=ready` and `traffic=ready`. Assert both Chinese actions are visible, partial/skipped rows contain “流程已结束 · 数据缺口” and contain neither a percentage nor a 100%-width track.

Click each action in an isolated page and assert:

```ts
assert.equal(new URL(page.url()).searchParams.get("tab"), destination);
assert.equal(new URL(page.url()).searchParams.get("run"), runId);
assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1");
assert.equal(calls.post, 0);
```

Keep the existing active-stage, refresh, terminal remount, dismiss, resume, and explicit restart assertions unchanged.

- [ ] **Step 3: Run RED**

Run:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern="progress presentation|SIF discovery|terminal progress|production consumers|explicit restart" tests/agent/asin-sync-session.test.ts
```

Expected: FAIL because partial/skipped rows currently report 100% and `SyncProgressPresentation` has no SIF destinations or navigation actions.

- [ ] **Step 4: Implement the pure presentation changes**

Add the exact type and field, then derive destinations only from real per-ASIN module status:

```ts
export type SifDiscoveryDestination = {
  tab: "keywords" | "traffic";
  label: "查看关键词调研" | "查看竞品流量分析";
};

export type SyncProgressPresentation = {
  executionPercent: number;
  completenessPercent: number;
  remainingSeconds: number;
  finishAt: string | null;
  terminal: boolean;
  rows: SyncProgressRow[];
  sifDestinations: readonly SifDiscoveryDestination[];
};

function hasReadyModule(job: SyncJob, moduleId: "keywords" | "traffic") {
  const asins = job.asins ?? Object.keys(job.asinProgress);
  return asins.some(asin => job.asinProgress[asin]?.[moduleId]?.status === "ready");
}
```

Return `executionPercent: 0` and `statusCopy: "流程已结束 · 数据缺口"` for automatic `partial`/`skipped` rows. Keep terminal top-level execution at 100%, keep `done` at 100%, and do not alter active-stage percentage calculation.

- [ ] **Step 5: Render SIF actions without data projection or POST**

In `app/asin-sync-funnel.tsx`, render actions only from `overall.sifDestinations`. On activation, clone `window.location.search`, set only `tab`, preserve pathname/run/syncJob/project, and navigate to the resulting same-workspace URL. Reuse existing button/link styling; do not add a sync callback.

```ts
function navigateToSifDestination(tab: "keywords" | "traffic") {
  const params = new URLSearchParams(window.location.search);
  params.set("tab", tab);
  window.location.assign(`${window.location.pathname}?${params.toString()}`);
}
```

For partial/skipped automatic rows, render the fixed gap copy and omit `.sync-progress-percent` plus the success-width progress track:

```tsx
const gapTerminal = row.status === "partial" || row.status === "skipped";
{row.mode === "automatic" && !gapTerminal ? <span className="sync-progress-percent">{row.executionPercent}%</span> : null}
{row.mode === "automatic" && !gapTerminal ? <div className="sync-progress-track"><i style={{ width: `${row.executionPercent}%` }} /></div> : null}
```

No code in catalog/product/source modules changes.

- [ ] **Step 6: Run GREEN and full lifecycle regression**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/asin-sync-session.test.ts
npx eslint app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx --quiet
```

Expected: all session tests pass with zero failures/skips; active progress still advances, refresh/remount remain GET-only, restart still creates exactly one POST only after explicit action, and SIF actions never create a POST.

- [ ] **Step 7: Review and commit Task 2 only**

Run `git diff --check` over the four Task 2 files and verify no generated product-data file is staged, then:

```powershell
git add -- app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx
git diff --cached --name-status
git commit -m "fix: expose truthful sync gaps and SIF destinations"
```

Expected staged set: exactly the four Task 2 files. Review Task 2 independently from Worker health persistence.

---

### Task 3: Combined Gate And Deployment-Ready Handoff

**Files:**
- Verify only; do not edit production, generated data, task reports, or project JSON in this task.

**Interfaces:**
- Consumes: Task 1 Worker boundary and Task 2 `SyncProgressPresentation.sifDestinations`.
- Produces: one tested artifact and a limited review verdict; it performs no deployment or provider operation.

- [ ] **Step 1: Run the combined focused suites**

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-provider-degraded-admin.test.ts tests/agent/sync-job-production-main-resume.test.ts tests/agent/asin-sync-session.test.ts
node --test tests/scripts/provider-degradation.test.mjs
```

Expected: zero failed and zero skipped tests.

- [ ] **Step 2: Run static checks and exactly one build**

```powershell
npx eslint server/services/sync-job-worker-handler.ts app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/sync-provider-degraded-admin.test.ts tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx --quiet
git diff --check 3fa23d5f501afe408adf45a15cab3fda939ed755..HEAD
npm run build
```

Expected: all commands exit 0. Do not run another build unless a subsequent code change invalidates this evidence.

- [ ] **Step 3: Prove the protection boundary**

Recompute the sorted SHA-256 path/hash records for all protected files and compare them byte-for-byte with `$env:TEMP\connector-isolation-protected.json`. Then run `git status --short` and `git diff --cached --name-only`. Require the 15 generated `app/*.ts` files, `.superpowers/sdd/task-3-report.md`, and seven `data/projects/*.json` files to remain unstaged and byte-unmodified by Tasks 1-2; require an empty staging area.

- [ ] **Step 4: Request one limited independent review**

Review only: schema/MCP_SCHEMA persistence isolation, retained provider-wide behavior, row percentages/copy, SIF navigation status source, no cross-provider field mutation, refresh/restart semantics, and protected-WIP scope. Gate requires `Critical=0` and `direct business blockers=0`; defer unrelated observations.

- [ ] **Step 5: Deployment precheck and handoff**

Confirm exact artifact SHA, migrations healthy, fake mode off, active job count zero, and no staged files. Stop before any real capability probe, provider call, deployment mutation, or POST. The later operational runbook owns the single Sorftime capability probe and the user's one fresh-ASIN submission.
