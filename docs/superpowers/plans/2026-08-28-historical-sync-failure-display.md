# Historical Sync Failure Display Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold a failed sync job restored from an existing URL into a compact history summary while keeping failures from the current page session fully visible.

**Architecture:** `UrlResumableAsinSyncFunnel` derives whether the mounted job came from an old URL pointer by combining `resumeJobId` with the absence of an active `syncRequest`. `AsinSyncFunnel` latches that origin for the job, clears it when the job is observed active or explicitly resumed, and renders a GET-only collapsed history branch only for an already-failed restored job.

**Tech Stack:** React 19, TypeScript 5.9, Playwright browser tests, Vinext production build.

## Global Constraints

- Restored terminal `failed` jobs default to a compact “历史任务” summary.
- Failures created or observed running in the current page session remain fully expanded.
- Collapse and expand perform zero POST, zero Provider calls, and create or modify no job/run/stage.
- Existing resume, restart, authorization, URL-pointer, polling, and deduplication contracts remain unchanged.
- No database migration, API field, ASIN exception, deletion, or automatic retry.
- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\hide-historical-sync-failures`; do not touch the stable worktree business WIP.

---

### Task 1: Fold restored failed jobs without hiding current failures

**Files:**
- Modify: `app/asin-sync-funnel.tsx:142-188,320-557,609-704`
- Test: `tests/agent/asin-sync-session.test.ts:1923-2000`

**Interfaces:**
- Consumes: existing `UrlResumableAsinSyncFunnel({ syncRequest, resume })`, `SyncJob.status`, `resumeFailedStages()`, and `localAgentFetch()` behavior.
- Produces: internal `restoredFromHistory: boolean` prop and UI markers `data-sync-history="collapsed|expanded"`; no public API or persisted schema changes.

- [ ] **Step 1: Write the failing browser tests**

Add focused cases beside the existing retained failed-job tests:

```tsx
test("a restored failed job is folded into history and expands without POST", async () => {
  const page = await browser.newPage();
  const calls = { get: 0, post: 0 };
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-1")) {
        calls.get += 1;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), status: "failed", message: "historical EPERM" }) });
      }
      if (request.method() === "POST") calls.post += 1;
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&run=${runId}&syncJob=job-1`);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 0);
    await page.getByRole("button", { name: "查看详情", exact: true }).click();
    assert.equal(await page.locator('[data-sync-history="expanded"]').count(), 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
    assert.equal(calls.post, 0);
  } finally {
    await page.close();
  }
});

test("a job started in this page stays expanded when it fails immediately", async () => {
  const page = await browser.newPage();
  let post = 0;
  try {
    await page.route("**/api/agent/**", route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path.endsWith(`/v1/runs/${runId}`)) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ run: { projectId }, stages: [] }) });
      }
      if (request.method() === "POST") {
        post += 1;
        return route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ jobId: "job-new", status: "queued", message: "Queued", stages: [] }) });
      }
      if (path.endsWith("/v1/local-data/sync-asins/job-new")) {
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...syncJob(), jobId: "job-new", status: "failed", message: "current failure" }) });
      }
      return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: { message: "not found" } }) });
    });
    await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&manualStart=1&run=${runId}`);
    await page.evaluate(() => (window as unknown as { startNewSyncFunnel(): void }).startNewSyncFunnel());
    await page.waitForTimeout(1_700);
    assert.equal(post, 1);
    assert.equal(await page.locator('[data-sync-history="collapsed"]').count(), 0);
    assert.equal(await page.getByText("current failure", { exact: true }).count(), 1);
    assert.equal(await page.locator(".sync-progress-list").count(), 1);
  } finally {
    await page.close();
  }
});
```

- [ ] **Step 2: Run RED and confirm the missing behavior**

Run:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern "restored failed job is folded|started in this page stays expanded" tests/agent/asin-sync-session.test.ts
```

Expected: the restored failure test fails because `[data-sync-history="collapsed"]` is absent and the full stage list is rendered.

- [ ] **Step 3: Implement the minimal latched origin and history branch**

Pass the origin from the wrapper:

```tsx
<AsinSyncFunnel
  key={resumeJobId ?? "new"}
  asins={syncRequest ?? asins}
  marketplace={marketplace}
  projectId={resume.projectId}
  runId={resume.runId}
  resumeJobId={resumeJobId}
  terminalJob={resume.terminalJob}
  organizationId={resume.organizationId}
  stageOutputScopeKey={resume.stageOutputScopeKey}
  onStageOutput={resume.onStageOutput}
  onJobId={resume.onSyncJobId}
  focusStageIds={focusStageIds}
  restoredFromHistory={Boolean(resumeJobId && !syncRequest)}
  onComplete={job => {
    resume.onComplete?.(job);
    onComplete?.();
  }}
  onTerminal={job => resume.onTerminal?.(job)}
  onDismiss={() => {
    resume.onDismiss?.();
    onDismiss?.();
  }}
  onRestart={resume.onRestart}
  canResumeFailedStages={resume.canResumeFailedStages}
  allowDismiss={resume.allowDismiss}
/>
```

Latch it inside the funnel and clear it when the job is current:

```tsx
type Props = {
  asins: string[];
  marketplace: string;
  projectId?: string | null;
  runId?: string | null;
  resumeJobId?: string | null;
  onJobId?: (jobId: string) => void;
  focusStageIds?: string[];
  onComplete?: (job: SyncJob) => void;
  onTerminal?: (job: SyncJob) => void;
  onDismiss?: () => void;
  onRestart?: () => void;
  canResumeFailedStages?: boolean;
  allowDismiss?: boolean;
  restoredFromHistory?: boolean;
};

export function AsinSyncFunnel({ asins, marketplace, projectId = null, runId = null, resumeJobId = null, terminalJob = null, organizationId = null, stageOutputScopeKey = "", onStageOutput, onJobId, focusStageIds, onComplete, onTerminal, onDismiss, onRestart, canResumeFailedStages = false, allowDismiss = true, restoredFromHistory = false }: Props & { terminalJob?: SyncJob | null; organizationId?: string | null; stageOutputScopeKey?: string; onStageOutput?: (snapshot: StageOutputSnapshot) => void }) {
const [historicalOrigin, setHistoricalOrigin] = useState(restoredFromHistory);
const [historyExpanded, setHistoryExpanded] = useState(false);

// after a successful new submit or explicit resume
setHistoricalOrigin(false);

// after a successful GET, before terminal handling
if (!["completed", "completed-with-gaps", "failed"].includes(payload.status)) {
  setHistoricalOrigin(false);
}

const historicalFailure = historicalOrigin && job?.status === "failed";
if (historicalFailure && !historyExpanded) {
  return (
    <section className="card asin-sync-progress asin-sync-progress-idle" data-sync-history="collapsed">
      <div className="sync-progress-head">
        <div className="sync-progress-head-copy">
          <span className="status-chip">历史任务</span>
          <h3>{jobLifecycleLabel(job.status)}</h3>
          <p>{job.message}</p>
        </div>
        <div className="sync-progress-summary">
          <button type="button" className="ghost-btn sync-progress-dismiss" aria-expanded="false" onClick={() => setHistoryExpanded(true)}>
            查看详情
          </button>
          {onDismiss && allowDismiss ? <button type="button" className="ghost-btn sync-progress-dismiss" onClick={dismissSync}>关闭</button> : null}
        </div>
      </div>
    </section>
  );
}
```

Mark the existing full section with `data-sync-history={historicalFailure ? "expanded" : undefined}` and add a GET-only “收起历史” button when expanded. Do not change existing restart/resume/dismiss conditions.

- [ ] **Step 4: Run GREEN and the affected gates**

Run:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern "restored failed job is folded|started in this page stays expanded|validated failed job|storage failure retains" tests/agent/asin-sync-session.test.ts
npx eslint app/asin-sync-funnel.tsx tests/agent/asin-sync-session.test.ts
npm run build
git diff --check
```

Expected: focused tests pass, ESLint exits 0, production build succeeds once, and diff-check exits 0.

- [ ] **Step 5: Commit the isolated implementation**

```powershell
git add -- app/asin-sync-funnel.tsx tests/agent/asin-sync-session.test.ts
git commit -m "fix: fold restored sync failures into history"
```

Expected: commit contains only the two implementation paths; the worktree index is clean.
