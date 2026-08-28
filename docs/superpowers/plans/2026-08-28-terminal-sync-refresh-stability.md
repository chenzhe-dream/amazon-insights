# Terminal Sync Refresh Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the existing 1.5-second sync GET stream and 1-second countdown while work is active, then converge terminal stage outputs/publication exactly once, stop both timers, avoid duplicate React updates/callbacks, and replace automatic artifact navigation with a manual-refresh notice.

**Architecture:** Add a pure terminal-decision module, extend the stage-output browser owner into a four-outcome bounded state machine, and make `AsinSyncFunnel` own both timer lifecycles through those interfaces. Keep artifact mismatch handling page-owned but synchronous and notice-only; no server, publication, runner, Provider, database, or VOC contract changes are part of this plan.

**Tech Stack:** TypeScript 5.9, React 19, Playwright 1.62 headless Chromium with `page.clock`, Node.js `node:test` through `tsx`, ESLint 9, Vinext production build, OpenSpec CLI.

## Global Constraints

- Implement from `docs/superpowers/specs/2026-08-28-terminal-sync-refresh-stability-design.md`; preserve design commits `dfe7b03f088c8d4107e5eb20af725d4631f4cdcd` and `1a0109214aa27d94081c631feb8274c58e7a52a3`; never amend them.
- Work only in the isolated feature worktree. Do not touch the formal runtime directory, WIP files, unrelated index entries, ports 31900/31901/58258, running tasks, Provider calls, or PostgreSQL.
- Node.js remains `>=22.13.0`; add no dependencies and modify no package or lock file.
- `queued`, `running`, `base-ready`, and `enriching` retain an immediate GET, one GET every 1,500 ms, and the 1,000 ms countdown clock.
- Terminal statuses are exactly `completed`, `completed-with-gaps`, and `failed`.
- Publication omitted, `applied`, and `failed` are settled; explicit `pending` continues polling. Do not require public `not-required`: `server/routes/local-data.ts::publicSyncJob` intentionally omits it.
- Required outputs are only existing projectable stages whose status is `done`, `partial`, or `failed`; `pending`, `active`, `manual`, `skipped`, and non-projectable stages do not block quiescence.
- Stage-output outcomes are exactly `applied`, `resolved-unchanged`, `retryable-missing`, and `missing-output`; each `(scope, jobId, stage, terminal episode)` receives at most three attempts total.
- Repeated canonical `(jobId, jobVersion, status, canonical publication)` observations must not call job `setState`, terminal callbacks, or artifact handling. A response without a valid `jobVersion` is legacy and must not be suppressed by this key.
- Automatic convergence is GET-only: POST 0, `window.location.reload/replace/assign` 0, router refresh 0, and automatic full-page navigation 0. Existing explicit user start/resume actions are outside this automatic path.
- Preserve verified stage data when later reads fail. A third permanent miss displays `missing-output`; it never fabricates a persisted projection/contentHash or writes to the server.
- Do not modify `server/routes/local-data.ts`, publication services, `scripts/run-asin-sync-job.mjs`, `scripts/start-agent-stack.mjs`, DB/migrations, Provider adapters, SellerSprite, Sorftime, or VOC.
- VOC Positive/Negative merging is a later independent task and is excluded from every task below.
- Tests use isolated headless Chromium and fake time only. Do not automate desktop Chrome or the mouse.
- Do not push. This plan ends after local commits, verification, and bounded review; it contains no formal-server deployment.

## File/Interface Map

- Create `app/lib/sync-terminal-convergence.ts` and `tests/agent/sync-terminal-convergence.test.ts` for pure settlement, observation identity, and quiescence.
- Modify `app/lib/stage-output-browser.ts`, `app/stage-output-gap-card.tsx`, and owner/card tests for the four outcomes and three-attempt cap.
- Modify `app/asin-sync-funnel.tsx`, `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`, and `tests/agent/asin-sync-session.test.ts` for timer ownership, dedupe, and headless fake-time verification.
- Create `app/lib/publication-artifact-notice.ts` and its test; modify `app/page.tsx` and the harness; delete `app/lib/publication-artifact-convergence.ts` and its test.
- Read-only contract evidence: `server/routes/local-data.ts:270-292`, `shared/agent-contracts.ts:1190-1240`, and `app/lib/sync-progress-presentation.ts:1-65`. Never edit them for this slice.

---

### Task 1: Pure terminal settlement and observation identity

**Files:**
- Create: `app/lib/sync-terminal-convergence.ts`
- Test: `tests/agent/sync-terminal-convergence.test.ts`

**Interfaces:**
- Consumes: `SyncJob` from `app/lib/sync-progress-presentation.ts`.
- Produces: `publicationIsSettled(job): boolean`, `syncObservationKey(job): string | null`, and `terminalSyncIsQuiescent(job, stageOutputsSettled): boolean`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { publicationIsSettled, syncObservationKey, terminalSyncIsQuiescent } from "../../app/lib/sync-terminal-convergence";
import type { SyncJob } from "../../app/lib/sync-progress-presentation";

const base = { jobId: "job-1", jobVersion: 8, status: "completed" } satisfies Pick<SyncJob, "jobId" | "jobVersion" | "status">;

test("publication settlement follows public GET", () => {
  assert.equal(publicationIsSettled({}), true);
  assert.equal(publicationIsSettled({ publication: { status: "not-required" } }), true);
  assert.equal(publicationIsSettled({ publication: { status: "pending", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z" } }), false);
  assert.equal(publicationIsSettled({ publication: { status: "applied", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z", appliedAt: "2026-08-25T00:00:05.000Z" } }), true);
  assert.equal(publicationIsSettled({ publication: { status: "failed", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z", failedAt: "2026-08-25T00:00:05.000Z", code: "WEB_PUBLICATION_FAILED" } }), true);
});

test("canonical observations dedupe by value and legacy does not", () => {
  assert.equal(syncObservationKey(base), syncObservationKey({ ...base }));
  assert.notEqual(syncObservationKey(base), syncObservationKey({ ...base, status: "failed" }));
  assert.equal(syncObservationKey({ ...base, jobVersion: undefined }), null);
});

test("quiescence requires terminal job, settled publication, and outputs", () => {
  assert.equal(terminalSyncIsQuiescent({ status: "running" }, true), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed" }, false), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed", publication: { status: "pending", requestId: "c".repeat(64), artifactId: "b".repeat(64), requestedAt: "2026-08-25T00:00:00.000Z" } }, true), false);
  assert.equal(terminalSyncIsQuiescent({ status: "completed-with-gaps" }, true), true);
  assert.equal(terminalSyncIsQuiescent({ status: "failed" }, true), true);
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-terminal-convergence.test.ts`

Expected: FAIL with `Cannot find module '../../app/lib/sync-terminal-convergence'`.

- [ ] **Step 3: Write the minimal implementation**

```ts
import type { SyncJob } from "./sync-progress-presentation";

const terminalStatuses = new Set(["completed", "completed-with-gaps", "failed"]);

export function publicationIsSettled(job: Pick<SyncJob, "publication">): boolean {
  return job.publication?.status !== "pending";
}

export function syncObservationKey(job: Pick<SyncJob, "jobId" | "jobVersion" | "status" | "publication">): string | null {
  if (!Number.isSafeInteger(job.jobVersion) || Number(job.jobVersion) < 1) return null;
  const publication = job.publication
    ? Object.fromEntries(Object.entries(job.publication).sort(([left], [right]) => left.localeCompare(right)))
    : null;
  return JSON.stringify([job.jobId, job.jobVersion, job.status, publication]);
}

export function terminalSyncIsQuiescent(job: Pick<SyncJob, "status" | "publication">, stageOutputsSettled: boolean): boolean {
  return terminalStatuses.has(job.status) && publicationIsSettled(job) && stageOutputsSettled;
}
```

- [ ] **Step 4: Run GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/sync-terminal-convergence.test.ts`

Expected: 3 tests PASS, 0 FAIL.

- [ ] **Step 5: Commit Task 1**

```powershell
git add -- app/lib/sync-terminal-convergence.ts tests/agent/sync-terminal-convergence.test.ts
git diff --cached --check
git commit -m "test(sync): define terminal convergence decisions"
```

Expected: one commit containing only the two Task 1 files.

---

### Task 2: Four-outcome stage-output owner with a three-attempt budget

**Files:**
- Modify: `app/lib/stage-output-browser.ts`
- Modify: `app/stage-output-gap-card.tsx`
- Modify: `tests/agent/stage-output-browser.test.ts`
- Create: `tests/agent/stage-output-gap-card.test.tsx`

**Interfaces:**
- Consumes: `ProjectableSyncStage`, `StageOutputProjection`, and `LocalDataStageOutputResponseSchema` from `shared/agent-contracts.ts`; existing scope and SHA-256 validation.
- Produces: `StageOutputMissing`, `StageOutputEntry`, `StageOutputSnapshot`, `StageOutputOutcome`, plus `accept(stage, candidate)`, `missing(stage)`, `outputsSettled(job)`, `observeJob(job)`, `snapshot()`, and `clear()`.

- [ ] **Step 1: Write the failing owner and display tests**

Add to `tests/agent/stage-output-browser.test.ts` using its existing `scope`, `projection`, and `job` helpers:

```ts
test("owner distinguishes all four outcomes and caps permanent misses at three", () => {
  const owner = createStageOutputOwner(scope);
  const terminal = job(9, { keywords: "done" });
  assert.deepEqual(owner.observeJob(terminal), ["keywords"]);
  assert.deepEqual(owner.missing("keywords"), { kind: "retryable-missing", attempt: 1, remainingAttempts: 2 });
  assert.deepEqual(owner.missing("keywords"), { kind: "retryable-missing", attempt: 2, remainingAttempts: 1 });
  const exhausted = owner.missing("keywords");
  assert.equal(exhausted.kind, "missing-output");
  assert.equal(exhausted.attempt, 3);
  assert.equal(owner.snapshot().keywords?.stageStatus, "missing-output");
  assert.equal(owner.outputsSettled(terminal), true);
  assert.deepEqual(owner.observeJob(terminal), []);
});

test("publication-only jobVersion growth resolves unchanged", () => {
  const owner = createStageOutputOwner(scope);
  owner.observeJob(job(7, { keywords: "done" }));
  assert.equal(owner.accept("keywords", projection("keywords", 7, 1, { accepted: true })).kind, "applied");
  const verified = owner.snapshot();
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), ["keywords"]);
  assert.equal(owner.accept("keywords", projection("keywords", 7, 1, { accepted: true })).kind, "resolved-unchanged");
  assert.strictEqual(owner.snapshot(), verified);
  assert.deepEqual(owner.observeJob(job(8, { keywords: "done" })), []);
});

test("foreign, future, malformed, and bad-hash results use the same miss budget", () => {
  const owner = createStageOutputOwner(scope);
  owner.observeJob(job(8, { keywords: "done" }));
  assert.equal(owner.accept("keywords", { ...projection("keywords", 9, 1), jobId: "foreign" }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", { ...projection("keywords", 9, 1), contentHash: "f".repeat(64) }).kind, "retryable-missing");
  assert.equal(owner.accept("keywords", projection("keywords", 9, 1)).kind, "missing-output");
});
```

Create `tests/agent/stage-output-gap-card.test.tsx`:

```tsx
import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { StageOutputSnapshot } from "../../app/lib/stage-output-browser";
import { StageOutputGapCard } from "../../app/stage-output-gap-card";

test("missing output renders the bounded-retry gap", () => {
  const snapshot: StageOutputSnapshot = Object.freeze({
    keywords: Object.freeze({ stage: "keywords", stageStatus: "missing-output", reasonCode: "OUTPUT_UNAVAILABLE" }),
  });
  const html = renderToStaticMarkup(<StageOutputGapCard snapshot={snapshot} stage="keywords" />);
  assert.match(html, /关键词数据缺口/);
  assert.match(html, /阶段结果暂不可用，已停止自动重试/);
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx`

Expected: FAIL because the owner returns booleans, has no `missing`/`outputsSettled`, and the snapshot cannot represent `missing-output`.

- [ ] **Step 3: Write the minimal bounded owner and display branch**

Use these public types in `app/lib/stage-output-browser.ts`:

```ts
export type StageOutputMissing = Readonly<{
  stage: ProjectableSyncStage;
  stageStatus: "missing-output";
  reasonCode: "OUTPUT_UNAVAILABLE";
}>;

export type StageOutputEntry = StageOutputProjection | StageOutputMissing;
export type StageOutputSnapshot = Readonly<Partial<Record<ProjectableSyncStage, StageOutputEntry>>>;

export type StageOutputOutcome =
  | Readonly<{ kind: "applied"; snapshot: StageOutputSnapshot }>
  | Readonly<{ kind: "resolved-unchanged" }>
  | Readonly<{ kind: "retryable-missing"; attempt: number; remainingAttempts: number }>
  | Readonly<{ kind: "missing-output"; attempt: 3; snapshot: StageOutputSnapshot }>;
```

Keep per-stage `attempts`, `acceptedVersions`, and `resolvedAtJobVersion` maps. `recordMissing(stage)` increments once per physical GET result, returns retryable outcomes for attempts 1/2, and caps at `missing-output` on attempt 3. Never reset this budget because publication metadata changed. Insert a client-only missing entry only when no verified projection is visible, so a later read failure cannot cover verified content.

`accept(stage, candidate)` must parse and validate scope/stage/hash, reject `projection.jobVersion > observedJobVersion`, enforce monotonic outputVersion, and route failures through `recordMissing`. An identical outputVersion/contentHash is `resolved-unchanged`, updates `resolvedAtJobVersion` to the current observed jobVersion, and preserves snapshot identity. `outputsSettled(job)` evaluates only projectable `done`/`partial`/`failed` stages and returns true for a legacy job without a valid jobVersion, so legacy reads are never trapped behind a canonical output contract. A transition through a non-terminal stage starts a new terminal episode and resets only that stage's attempt/missing marker while retaining verified data. `clear()` resets every map and visible entry.

Update `StageOutputGapCard` with the exact discriminant and copy:

```tsx
const stageOutputGapCopy = {
  CONNECT_TIMEOUT: "数据源连接超时，本模块存在既定数据缺口。",
  UPSTREAM_EMPTY: "数据源未返回可用记录，本模块存在既定数据缺口。",
  CONNECTOR_FAILED: "数据源连接失败，本模块存在既定数据缺口。",
  OUTPUT_UNAVAILABLE: "阶段结果暂不可用，已停止自动重试。",
} as const;

const reasonCode = projection.stageStatus === "missing-output"
  ? projection.reasonCode
  : projection.gap.reasonCode;
```

- [ ] **Step 4: Run GREEN and the unchanged overlay regression**

```powershell
npx tsx --conditions=react-server --test tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx
npx tsx --conditions=react-server --test --test-name-pattern "existing job poll fetches and renders seven scoped stage outputs" tests/agent/asin-sync-session.test.ts
```

Expected: all selected tests PASS; `stage-output-view.ts`, `page.tsx`, and gap-card consumers remain type-consistent.

- [ ] **Step 5: Commit Task 2**

```powershell
git add -- app/lib/stage-output-browser.ts app/stage-output-gap-card.tsx tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx
git diff --cached --check
git commit -m "fix(sync): bound terminal stage output reads"
```

Expected: one commit containing only the four Task 2 files.

---

### Task 3: Funnel observation dedupe and two-timer quiescence

**Files:**
- Modify: `app/asin-sync-funnel.tsx:64-72,326-574`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx:20-260`
- Modify: `tests/agent/asin-sync-session.test.ts:304-630,2778-2942,3146-3185`

**Interfaces:**
- Consumes: Task 1 `syncObservationKey`/`terminalSyncIsQuiescent`; Task 2 `owner.accept`, `owner.missing`, `owner.outputsSettled`, and `owner.snapshot`.
- Produces: one 1,500 ms poll and one 1,000 ms clock while non-quiescent; one idempotent cleanup path; canonical setState dedupe; exactly one terminal callback; unchanged explicit user-resume POST behavior.

- [ ] **Step 1: Write the failing headless fake-timer tests**

Add `syncFunnelCommits?: number` to the existing `HarnessWindow` type without removing its current named properties, then wrap the funnel in a React `Profiler` without adding production instrumentation:

```tsx
import { Profiler } from "react";

type HarnessWindow = Window & {
  rerenderSyncFunnel?: () => void;
  hydrateSyncWorkspace?: () => void;
  switchSyncFunnelTab?: (tab: "overview" | "keywords" | "traffic" | "library") => void;
  startNewSyncFunnel?: () => void;
  runOverviewAutoCheck?: () => void;
  logoutStageOutputs?: () => void;
  switchStageOutputJob?: (jobId: string) => void;
  syncTerminalEvents?: { completions: number; reloads: number };
  stageOutputEvents?: { updates: number; stages: string[] };
  syncFunnelCommits?: number;
};
harnessWindow.syncFunnelCommits ??= 0;

const funnel = <Profiler id="sync-funnel" onRender={() => { harnessWindow.syncFunnelCommits! += 1; }}>
  <UrlResumableAsinSyncFunnel
    asins={search.get("freshAsins") === "1" ? [...funnelAsins] : funnelAsins}
    marketplace={workspace.marketplace}
    syncRequest={syncRequest}
    resume={shared}
    focusStageIds={tab === "library" ? ["catalog", "keywords"] : undefined}
  />
</Profiler>;
```

Add this complete bounded-miss case to `tests/agent/asin-sync-session.test.ts`:

```ts
test("terminal output exhaustion clears the poll and clock exactly once", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = { jobs: 0, outputs: 0, posts: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const pathname = new URL(request.url()).pathname;
      if (request.method() === "POST") calls.posts += 1;
      if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.jobs += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          ...syncJob(), status: "completed", jobVersion: 11, message: "bounded terminal",
          stages: [{ id: "keywords", label: "Keywords", kind: "auto", status: "done", estimatedSeconds: 1 }],
        }) });
      }
      if (pathname.endsWith("/stages/keywords/output")) {
        calls.outputs += 1;
        return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: "{}" });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&realStageConsumers=1&run=${runId}&syncJob=job-1`);
    await page.clock.fastForward(3_100);
    await page.getByText("阶段结果暂不可用，已停止自动重试。", { exact: true }).waitFor();
    assert.deepEqual(calls, { jobs: 3, outputs: 3, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    const commits = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
    await page.clock.fastForward(10_000);
    assert.deepEqual(calls, { jobs: 3, outputs: 3, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits), commits);
    assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
  } finally {
    await page.close();
  }
});
```

Add a table-driven settled case using the existing `syncJob`, `publicationRequestId`, `nextArtifactId`, and `publicationRequestedAt` fixtures:

```ts
for (const [label, publication] of [
  ["omitted", undefined],
  ["applied", { status: "applied", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, appliedAt: "2026-08-25T00:00:05.000Z" }],
  ["failed", { status: "failed", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt, failedAt: "2026-08-25T00:00:05.000Z", code: "WEB_PUBLICATION_FAILED" }],
] as const) {
  test(`publication settlement stops both timers: ${label}`, async () => {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
    const calls = { jobs: 0, posts: 0 };
    try {
      await page.route("**/api/agent/**", route => {
        const request = route.request();
        const pathname = new URL(request.url()).pathname;
        if (request.method() === "POST") calls.posts += 1;
        if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
        if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
          calls.jobs += 1;
          return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "completed", jobVersion: 4, publication }) });
        }
        return route.fulfill({ status: 404, body: "{}" });
      });
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
      await page.clock.fastForward(5_000);
      assert.deepEqual(calls, { jobs: 1, posts: 0 });
      assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
      assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
    } finally { await page.close(); }
  });
}
```

Define this local test helper, then add the remaining cases:

```ts
async function routeClockedJobSequence(page: import("playwright").Page, jobs: Record<string, unknown>[]) {
  const calls = { jobs: 0, posts: 0 };
  await page.route("**/api/agent/**", route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST") calls.posts += 1;
    if (pathname.endsWith(`/v1/runs/${runId}`)) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
    if (pathname.endsWith("/v1/local-data/sync-asins/job-1")) {
      const body = jobs[Math.min(calls.jobs, jobs.length - 1)]!;
      calls.jobs += 1;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    return route.fulfill({ status: 404, body: "{}" });
  });
  return calls;
}

test("pending publication keeps timers until applied", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const pending = { status: "pending", requestId: publicationRequestId, artifactId: nextArtifactId, requestedAt: publicationRequestedAt } as const;
  const applied = { ...pending, status: "applied", appliedAt: "2026-08-25T00:00:05.000Z" } as const;
  const calls = await routeClockedJobSequence(page, [
    { ...syncJob(), status: "completed", jobVersion: 4, publication: pending },
    { ...syncJob(), status: "completed", jobVersion: 4, publication: pending },
    { ...syncJob(), status: "completed", jobVersion: 5, publication: applied },
  ]);
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
    await page.clock.fastForward(1_500);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 0);
    await page.clock.fastForward(1_500);
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
    await page.clock.fastForward(10_000);
    assert.deepEqual(calls, { jobs: 3, posts: 0 });
  } finally { await page.close(); }
});

for (const status of ["queued", "running", "base-ready", "enriching"] as const) {
  test(`running sync keeps stream and clock: ${status}`, async () => {
    const page = await browser.newPage();
    await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
    const calls = await routeClockedJobSequence(page, [{ ...syncJob(), status, jobVersion: 4 }]);
    try {
      await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
      const before = await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits);
      await page.clock.fastForward(3_100);
      assert.equal(calls.jobs, 3);
      assert.equal(calls.posts, 0);
      assert.ok(await page.evaluate(() => (window as unknown as { syncFunnelCommits: number }).syncFunnelCommits) > before);
    } finally { await page.close(); }
  });
}

test("legacy observations remain live", async () => {
  const page = await browser.newPage();
  await page.clock.install({ time: new Date("2026-08-28T00:00:00.000Z") });
  const calls = await routeClockedJobSequence(page, [
    { ...syncJob(), status: "running", jobVersion: undefined, message: "legacy running" },
    { ...syncJob(), status: "completed", jobVersion: undefined, message: "legacy completed" },
  ]);
  try {
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?run=${runId}&syncJob=job-1`);
    await page.clock.fastForward(1_500);
    await page.getByText("legacy completed", { exact: true }).waitFor();
    assert.deepEqual(calls, { jobs: 2, posts: 0 });
    assert.equal(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number } }).syncTerminalEvents.completions), 1);
  } finally { await page.close(); }
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern "terminal output exhaustion|publication settlement stops both timers|running sync keeps stream and clock|legacy observations remain live" tests/agent/asin-sync-session.test.ts`

Expected: FAIL because stage reads are booleans, the clock is unconditional, retries are unbounded, and identical canonical payloads still call `setJob`.

- [ ] **Step 3: Implement minimal timer ownership and observation application**

Remove local publication helpers and import Task 1. Add idempotent clock ownership:

```tsx
const clockTimerRef = useRef<number | null>(null);
const lastObservationKey = useRef<string | null>(null);

const stopClock = useCallback(() => {
  if (clockTimerRef.current === null) return;
  window.clearInterval(clockTimerRef.current);
  clockTimerRef.current = null;
}, []);

useEffect(() => {
  if (!jobId || completedJobs.current.has(jobId) || clockTimerRef.current !== null) return;
  clockTimerRef.current = window.setInterval(() => setNow(Date.now()), 1_000);
  return stopClock;
}, [jobId, pollRevision, stopClock]);
```

Classify each physical stage response exactly once:

```tsx
const before = owner.snapshot();
const outcomes = await Promise.all(stages.map(async stage => {
  try {
    const response = await localAgentFetch(
      `/v1/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/sync-jobs/${encodeURIComponent(jobId)}/stages/${stage}/output`,
    );
    if (!response.ok) return owner.missing(stage);
    return owner.accept(stage, await response.json());
  } catch {
    return owner.missing(stage);
  }
}));
if (owner.snapshot() !== before && outcomes.some(result => result.kind === "applied" || result.kind === "missing-output")) {
  onStageOutputRef.current?.(owner.snapshot());
}
const outputsSettled = owner.outputsSettled(payload);
```

Apply only unique canonical job observations, while always applying legacy:

```tsx
const observationKey = syncObservationKey(payload);
if (observationKey === null || observationKey !== lastObservationKey.current) {
  lastObservationKey.current = observationKey;
  setError(null);
  setJob(payload);
}
```

Use one terminal branch for all terminal statuses:

```tsx
if (terminalSyncIsQuiescent(payload, outputsSettled)) {
  completedJobs.current.add(jobId);
  stopPolling();
  stopClock();
  if (payload.status === "failed") {
    setError(payload.message);
    onTerminalRef.current?.(payload);
  } else {
    onCompleteRef.current?.(payload);
  }
  return;
}
```

Initialize `let outputsSettled = true` before the optional canonical owner block and replace it with `owner.outputsSettled(payload)` after classified stage reads; this makes jobs without a canonical stage-output owner retain existing terminal behavior. Add `stopClock` to the polling effect dependencies. Keep current in-flight serialization/scope cancellation. Explicit `pending` remains non-quiescent. Reset observation/stage episode/timers only on scope/job switch or existing explicit resume; do not alter its POST endpoint.

- [ ] **Step 4: Run GREEN and focused regressions**

```powershell
npx tsx --conditions=react-server --test --test-name-pattern "terminal output exhaustion|publication settlement stops both timers|running sync keeps stream and clock|legacy observations remain live|canonical terminal job retries|scope cancellation|same-content ASIN arrays|delayed terminal read" tests/agent/asin-sync-session.test.ts
npx tsx --conditions=react-server --test tests/agent/sync-terminal-convergence.test.ts tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx
```

Expected: all selected tests PASS; running cadence remains, terminal timers stop, callbacks equal 1, output attempts never exceed 3, POSTs equal 0, and navigation entries equal 1.

- [ ] **Step 5: Commit Task 3**

```powershell
git add -- app/asin-sync-funnel.tsx tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts
git diff --cached --check
git commit -m "fix(sync): quiesce terminal client timers"
```

Expected: one commit containing only the three Task 3 files.

---

### Task 4: Manual artifact-refresh notice with zero automatic navigation

**Files:**
- Create: `app/lib/publication-artifact-notice.ts`
- Create: `tests/agent/publication-artifact-notice.test.ts`
- Modify: `app/page.tsx:90-113,1868-1876,1931-1972,2877`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx:1-230`
- Modify: `tests/agent/asin-sync-session.test.ts:2504-2635,2787-3100`
- Delete: `app/lib/publication-artifact-convergence.ts`
- Delete: `tests/agent/publication-artifact-convergence.test.ts`

**Interfaces:**
- Consumes: `document.documentElement.dataset.webArtifactId` and an applied publication artifactId.
- Produces: `publicationArtifactNotice(currentArtifactId: string, targetArtifactId: string): string | null`; exact mismatch copy `新数据已发布，请手动刷新`; no health probe, cache-busted URL, timer, reload, location replacement, or router refresh.

- [ ] **Step 1: Write the failing notice and browser assertions**

Create `tests/agent/publication-artifact-notice.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { publicationArtifactNotice } from "../../app/lib/publication-artifact-notice";

test("only a different valid applied artifact asks for manual refresh", () => {
  const current = "a".repeat(64);
  const target = "b".repeat(64);
  assert.equal(publicationArtifactNotice(current, current), null);
  assert.equal(publicationArtifactNotice(current, target), "新数据已发布，请手动刷新");
  assert.equal(publicationArtifactNotice(current, "invalid"), null);
});
```

Replace old navigation assertions in `tests/agent/asin-sync-session.test.ts` with:

```ts
await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
await page.waitForTimeout(1_700);
assert.equal(await page.evaluate(() => performance.getEntriesByType("navigation").length), 1);
assert.equal(new URL(page.url()).searchParams.get("webArtifact"), null);
assert.equal(calls.post, 0);
assert.equal(calls.health, 0);
assert.deepEqual(
  await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents),
  { completions: 1, reloads: 0 },
);
```

Rename/reframe the existing publication cases to cover: pending twice then applied shows one notice and never navigates; already-current artifact shows no notice; failed publication keeps its current alert and no notice; all four consumers remain GET-only; tab switches start no artifact work; health calls/POSTs/navigation are all zero.

- [ ] **Step 2: Run RED**

```powershell
npx tsx --conditions=react-server --test tests/agent/publication-artifact-notice.test.ts
npx tsx --conditions=react-server --test --test-name-pattern "manual artifact refresh|terminal publication blocks|applied artifact already|failed publication|all production consumers retain terminal progress" tests/agent/asin-sync-session.test.ts
```

Expected: pure test FAILS because the module is absent; browser tests FAIL because current code probes `/api/health` and calls `window.location.replace`.

- [ ] **Step 3: Write the minimal notice-only replacement**

Create:

```ts
const SHA256 = /^[a-f0-9]{64}$/;
const MANUAL_REFRESH_NOTICE = "新数据已发布，请手动刷新";

export function publicationArtifactNotice(currentArtifactId: string, targetArtifactId: string): string | null {
  if (!SHA256.test(targetArtifactId) || currentArtifactId === targetArtifactId) return null;
  return MANUAL_REFRESH_NOTICE;
}
```

In `app/page.tsx`, remove `publishedArtifactFromHealth`, `waitForPublishedArtifact`, `urlForPublishedArtifact`, and `scheduledReloadJobId`; keep `currentWebArtifactId` and replace artifact handling with:

```tsx
if (applied) {
  setPublicationConvergenceNotice(publicationArtifactNotice(currentWebArtifactId(), applied.artifactId));
} else {
  setPublicationConvergenceNotice(null);
}
```

Make the same notice-only change in the harness. Delete the old helper/test after `rg -n "waitForPublishedArtifact|urlForPublishedArtifact|publishedArtifactFromHealth|scheduledReloadJobId" app tests/agent` reports only the removal targets. Do not replace them with another timer or navigation API.

- [ ] **Step 4: Run GREEN and navigation/GET-only regressions**

```powershell
npx tsx --conditions=react-server --test tests/agent/publication-artifact-notice.test.ts
npx tsx --conditions=react-server --test --test-name-pattern "manual artifact refresh|terminal publication blocks|applied artifact already|failed publication|all production consumers retain terminal progress|storage failure retains|legacy needsReload" tests/agent/asin-sync-session.test.ts
rg -n "window\.location\.(reload|replace|assign)|router\.refresh|waitForPublishedArtifact|urlForPublishedArtifact|publishedArtifactFromHealth" app/page.tsx tests/agent/helpers/asin-sync-funnel-browser-harness.tsx app/lib
```

Expected: selected tests PASS; `rg` has no match in the changed terminal path; applied mismatch has one navigation entry, automatic navigation 0, POST 0, and the fixed notice.

- [ ] **Step 5: Commit Task 4**

```powershell
git add -- app/page.tsx app/lib/publication-artifact-notice.ts app/lib/publication-artifact-convergence.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts tests/agent/publication-artifact-notice.test.ts tests/agent/publication-artifact-convergence.test.ts
git diff --cached --check
git commit -m "fix(sync): make artifact refresh manual"
```

Expected: one commit containing only the Task 4 create/modify/delete set.

---

## Implementation Completion Gates

- [ ] **Focused headless/fake-timer suite:**

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-terminal-convergence.test.ts tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/publication-artifact-notice.test.ts
npx tsx --conditions=react-server --test --test-name-pattern "terminal output exhaustion|publication settlement stops both timers|running sync keeps stream and clock|legacy observations remain live|canonical terminal job retries|scope cancellation|same-content ASIN arrays|manual artifact refresh|terminal publication blocks|applied artifact already|failed publication|all production consumers retain terminal progress|storage failure retains|legacy needsReload|delayed terminal read" tests/agent/asin-sync-session.test.ts
```

Expected: 0 failed; browser is headless; desktop Chrome automation and mouse input are absent.

- [ ] **Changed-file lint:**

```powershell
npx eslint app/asin-sync-funnel.tsx app/page.tsx app/stage-output-gap-card.tsx app/lib/stage-output-browser.ts app/lib/sync-terminal-convergence.ts app/lib/publication-artifact-notice.ts tests/agent/sync-terminal-convergence.test.ts tests/agent/stage-output-browser.test.ts tests/agent/stage-output-gap-card.test.tsx tests/agent/publication-artifact-notice.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts
```

Expected: exit 0, no lint errors. Do not format unrelated files.

- [ ] **One production build, exactly once in this plan:**

Run: `npm run build`

Expected: exit 0. This is build verification only; do not start or deploy the artifact.

- [ ] **OpenSpec and diff checks:**

```powershell
npx openspec validate stabilize-resumable-sync-pipeline --strict
git diff --check
git status --short
```

Expected: OpenSpec valid, diff check clean, status restricted to planned files. Do not edit `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`.

- [ ] **Protected-scope check:**

```powershell
$terminalSyncChanged = @(git diff --name-only 1a0109214aa27d94081c631feb8274c58e7a52a3..HEAD)
$terminalSyncForbidden = $terminalSyncChanged | Where-Object { $_ -match '^(server/|scripts/|db/|drizzle/|shared/agent-contracts\.ts$|openspec/|app/.*(voc|sorftime|sellersprite))' }
if ($terminalSyncForbidden.Count -gt 0) { throw "Out-of-scope files: $($terminalSyncForbidden -join ', ')" }
```

Expected: no forbidden files. VOC Positive/Negative remains a future task.

- [ ] **Limited review:** invoke `superpowers:requesting-code-review` only for the four Task commits and only for timer cleanup, canonical-vs-legacy dedupe, three-attempt accounting, publication omitted/pending/applied/failed semantics, GET-only/POST0/navigation0, cancellation/scope safety, and manual-refresh copy. Reject suggestions requiring server routes, publication service, runner, supervisor, DB, Provider, SellerSprite, Sorftime, or VOC changes.

- [ ] **Local controlled-rollout eligibility gate:** this plan performs no deployment and starts no server. A later, separately authorized local-only rollout is eligible only after all gates are green, no formal sync job is active, and 31900/31901/58258 remain untouched. That rollout must record the actual local `/api/health` artifact, use isolated headless Chromium, permit at most one user-initiated cache refresh if stale, and prove no navigation loop. Formal-server deployment is absent.

- [ ] **Final local history check:**

```powershell
git log --oneline -6
git status --short
```

Expected: four new implementation commits after this committed plan, no amend, no push, and no uncommitted implementation files.

## Plan Self-Review

- **Spec coverage:** Task 1 covers publication settlement, canonical identity, legacy bypass, and quiescence. Task 2 covers all four stage-output outcomes, validation, three attempts, preserved data, and explicit missing output. Task 3 covers active cadence, terminal cleanup, dedupe, GET-only behavior, cancellation, and headless fake time. Task 4 covers manual-refresh copy and automatic navigation removal. Completion gates cover focused tests, changed lint, one build, OpenSpec, diff/scope review, bounded review, and local-only rollout eligibility.
- **Placeholder scan:** No unresolved markers, unnamed handlers, unspecified tests, or deferred edge-case language remain. Modules, signatures, commands, expected results, copy, and commit messages are explicit.
- **Type consistency:** `SyncJob` is the job input; `StageOutputOutcome` uses the same four discriminants in Tasks 2/3; `StageOutputSnapshot` contains `StageOutputProjection | StageOutputMissing`; `publicationArtifactNotice` has one signature; publication omission remains `undefined`; later consumers use names produced by earlier tasks.
- **Scope consistency:** No task modifies server routes, publication services, runner, supervisor, DB, Provider, SellerSprite, Sorftime, or VOC. External health/cache acceptance is a later local-rollout gate, not a server requirement or formal deployment step.
