# Image Publication Clarity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reliably converge a terminal browser page onto its published Web artifact, show every Provider-returned image and AI remark, and separate terminal execution state from truthful data completeness.

**Architecture:** Add one pure, bounded artifact-convergence helper and call it from the page-owned terminal handler before navigating to a cache-busted version of the same canonical URL. Keep gallery rendering source-driven, add per-ASIN image/remark counters, and apply an image-ready coverage factor to the existing module completeness without changing Provider or job lifecycle code.

**Tech Stack:** TypeScript, React, vinext, Node test runner through `tsx`, Playwright browser harness.

## Global Constraints

- Do not create a new job, run, stage, submission, Provider request, or retry.
- Do not add an Amazon-page scraping fallback in this slice.
- Preserve `run` and `syncJob` URL identity across artifact convergence.
- Artifact polling is same-origin, no-store, bounded to 30 attempts at 1 second, and never loops after the target artifact is loaded.
- Provider image arrays remain capped by the existing 9-column UI limit.
- Terminal copy is `流程已结束`; non-terminal execution percentage remains unchanged.
- Final completeness equals existing base completeness multiplied by ready image remarks divided by Provider-returned images; 20/20 preserves the current 80%.
- Do not modify concurrency, tenant isolation, Provider adapters, database schema, or sync lifecycle contracts.

---

### Task 1: Bounded published-artifact convergence

**Files:**
- Create: `app/lib/publication-artifact-convergence.ts`
- Modify: `app/page.tsx:99,1908-1940`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx:35-175`
- Test: `tests/agent/asin-sync-session.test.ts:2651-2850`
- Test: `tests/agent/publication-artifact-convergence.test.ts`

**Interfaces:**
- Consumes: current document artifact ID, publication target SHA-256, same-origin `/api/health`, canonical page URL.
- Produces: `waitForPublishedArtifact(input): Promise<"already-current" | "ready" | "timeout">` and `urlForPublishedArtifact(href, artifactId): string`.

- [ ] **Step 1: Add RED pure tests for readiness, timeout, and URL preservation**

```ts
test("waits through unavailable health until the exact artifact is ready", async () => {
  const values = [null, "a".repeat(64), "b".repeat(64)];
  const result = await waitForPublishedArtifact({
    currentArtifactId: "a".repeat(64),
    targetArtifactId: "b".repeat(64),
    probe: async () => values.shift() ?? null,
    wait: async () => undefined,
    maxAttempts: 3,
  });
  assert.equal(result, "ready");
});

test("cache-busted artifact URL preserves canonical identities", () => {
  const url = new URL(urlForPublishedArtifact(
    "http://host/p/ai-us-3?run=run-1&syncJob=job-1&tab=overview-images",
    "b".repeat(64),
  ));
  assert.equal(url.searchParams.get("run"), "run-1");
  assert.equal(url.searchParams.get("syncJob"), "job-1");
  assert.equal(url.searchParams.get("tab"), "overview-images");
  assert.equal(url.searchParams.get("webArtifact"), "b".repeat(64));
});
```

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/publication-artifact-convergence.test.ts`

Expected: FAIL because the helper module does not exist.

- [ ] **Step 3: Implement the bounded pure helper**

```ts
const SHA256 = /^[a-f0-9]{64}$/;

export async function waitForPublishedArtifact(input: {
  currentArtifactId: string;
  targetArtifactId: string;
  probe: () => Promise<string | null>;
  wait: (milliseconds: number) => Promise<void>;
  maxAttempts?: number;
  intervalMs?: number;
}): Promise<"already-current" | "ready" | "timeout"> {
  if (!SHA256.test(input.targetArtifactId)) return "timeout";
  if (input.currentArtifactId === input.targetArtifactId) return "already-current";
  const attempts = input.maxAttempts ?? 30;
  const interval = input.intervalMs ?? 1_000;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await input.probe() === input.targetArtifactId) return "ready";
    if (attempt + 1 < attempts) await input.wait(interval);
  }
  return "timeout";
}

export function urlForPublishedArtifact(href: string, artifactId: string): string {
  if (!SHA256.test(artifactId)) return href;
  const url = new URL(href);
  url.searchParams.set("webArtifact", artifactId);
  return url.toString();
}
```

- [ ] **Step 4: Run the pure tests GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/publication-artifact-convergence.test.ts`

Expected: PASS, including zero probes when already current and a bounded timeout after exactly 30 probes.

- [ ] **Step 5: Add RED browser coverage for the live failure mode**

Extend the production harness so an applied job whose document artifact is old observes `/api/health` as unavailable, old, then target. Assert zero POST, one cache-busted navigation only after target readiness, and preserved `run`/`syncJob`. Add a timeout case asserting fixed copy `新数据已发布，请手动刷新` and zero navigation.

Run: `npx tsx --conditions=react-server --test --test-name-pattern="published artifact convergence|publication convergence timeout" tests/agent/asin-sync-session.test.ts`

Expected: FAIL because the page still reloads immediately and has no timeout notice.

- [ ] **Step 6: Wire the page-owned convergence**

In `app/page.tsx`, probe only `/api/health` with `{ cache: "no-store" }`. Run convergence even when the terminal job/artifact tuple was already recorded, because that record must suppress automatic re-submission, not suppress artifact convergence. When ready, use `window.location.replace(urlForPublishedArtifact(window.location.href, target))`; on timeout set page-local copy `新数据已发布，请手动刷新`. Once the loaded document artifact equals the target, remove only `webArtifact` with `history.replaceState`.

- [ ] **Step 7: Run Task 1 GREEN and commit**

Run: `npx tsx --conditions=react-server --test tests/agent/publication-artifact-convergence.test.ts`

Run: `npx tsx --conditions=react-server --test --test-name-pattern="terminal publication blocks|applied artifact already|page-owned applied-artifact|published artifact convergence|publication convergence timeout" tests/agent/asin-sync-session.test.ts`

Expected: all selected tests PASS; POST count remains zero in convergence tests.

```bash
git add app/lib/publication-artifact-convergence.ts app/page.tsx tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts tests/agent/publication-artifact-convergence.test.ts
git commit -m "fix: converge pages on published artifacts"
```

### Task 2: Truthful image counts and terminal completeness

**Files:**
- Modify: `app/listing-images-section.tsx:105-222`
- Modify: `app/lib/sync-progress-presentation.ts:91-250`
- Modify: `app/asin-sync-funnel.tsx:680-700`
- Test: `tests/agent/listing-images-section.test.tsx`
- Test: `tests/agent/asin-sync-session.test.ts:1100-1340`

**Interfaces:**
- Consumes: resolved Provider gallery, `getListingImageRemark(asin, slotIndex)`, image stage detail `已完成 X/Y 张 · 就绪 R`.
- Produces: per-ASIN `Provider 返回 X 张 · AI 备注 Y/X 张`, image coverage factor, and terminal copy `流程已结束`.

- [ ] **Step 1: Add RED presentation tests**

```ts
test("terminal execution copy does not present 100 percent as completeness", () => {
  const progress = presentSyncProgress(terminalJobWithBaseCompleteness(80), Date.now());
  assert.equal(progress.terminal, true);
  assert.equal(progress.completenessPercent, 80);
});

test("image remark coverage reduces but never inflates base completeness", () => {
  assert.equal(presentSyncProgress(jobWithImageDetail("已完成 20/20 张 · 就绪 20"), 0).completenessPercent, 80);
  assert.equal(presentSyncProgress(jobWithImageDetail("已完成 20/20 张 · 就绪 15"), 0).completenessPercent, 60);
});
```

Add browser assertions that a terminal header contains `流程已结束`, contains `数据完整度 80%`, and does not contain `执行进度 100%`.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test --test-name-pattern="image remark coverage|terminal execution copy" tests/agent/asin-sync-session.test.ts`

Expected: FAIL because image coverage is absent and the terminal header still prints 100%.

- [ ] **Step 3: Implement image coverage without changing the base denominator**

```ts
function imageRemarkCoverage(job: SyncJob): number {
  const detail = job.stages.find(stage => stage.id === "image_remarks")?.detail;
  const match = detail?.match(/已完成\s*(\d+)\s*\/\s*(\d+)\s*张\s*·\s*就绪\s*(\d+)/);
  if (!match) return 1;
  const total = Number(match[2]);
  const ready = Number(match[3]);
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(ready) || total < 1 || ready < 0 || ready > total) return 1;
  return ready / total;
}

const base = dataCompletenessPercent(job, focusStageIds);
const completenessPercent = Math.round(base * imageRemarkCoverage(job));
```

Render terminal summary as `<span>流程 <b>已结束</b></span>` and retain the percentage only for non-terminal jobs.

- [ ] **Step 4: Add per-ASIN gallery/remark counters**

For each resolved gallery calculate:

```ts
const readyRemarkCount = gallery.urls.reduce(
  (count, _, slotIndex) => count + (resolveImageRemark(product.asin, slotIndex) ? 1 : 0),
  0,
);
```

Render `Sorftime MCP · Provider 返回 ${gallery.urls.length} 张 · AI 备注 ${readyRemarkCount}/${gallery.urls.length} 张`. Keep every existing image cell and fixed per-slot outcome reason.

- [ ] **Step 5: Run Task 2 GREEN and commit**

Run: `npx tsx --test tests/agent/listing-images-section.test.tsx`

Run: `npx tsx --conditions=react-server --test --test-name-pattern="image remark coverage|terminal execution copy|terminal progress presents|image remark stage exposes" tests/agent/asin-sync-session.test.ts`

Expected: all selected tests PASS; 7/7, 7/7, and 6/6 labels render with all 20 image frames and remarks.

```bash
git add app/listing-images-section.tsx app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/listing-images-section.test.tsx tests/agent/asin-sync-session.test.ts
git commit -m "fix: show truthful image completion"
```

### Task 3: Integrated verification and controlled handoff

**Files:**
- Verify only; no new production files.

**Interfaces:**
- Consumes: Tasks 1 and 2 commits.
- Produces: frozen candidate commit and evidence for independent review/deployment.

- [ ] **Step 1: Run the complete affected suites**

Run: `npx tsx --conditions=react-server --test tests/agent/publication-artifact-convergence.test.ts tests/agent/asin-sync-session.test.ts`

Run: `npx tsx --test tests/agent/listing-images-section.test.tsx`

Expected: zero failures.

- [ ] **Step 2: Run quality gates once**

Run: `npx eslint app/lib/publication-artifact-convergence.ts app/page.tsx app/listing-images-section.tsx app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx tests/agent/publication-artifact-convergence.test.ts tests/agent/asin-sync-session.test.ts tests/agent/listing-images-section.test.tsx`

Run: `npm run build`

Run: `git diff --check 5dbd90aa4f2a1412a91c17102be8bf77fe674f91..HEAD`

Expected: ESLint has zero errors, production build exits 0, diff-check exits 0.

- [ ] **Step 3: Independent limited review**

Review only this plan/spec and `5dbd90a..HEAD`. Gate on Critical or direct business blockers: infinite reload, lost run/syncJob, hidden image gaps, false completeness, Provider/job writes, or regression of current-session terminal behavior.

- [ ] **Step 4: Controlled deployment verification**

Before deployment require active jobs/stages/attempts/runs = 0 and preserve formal WIP. After deployment require Web 31900 and Agent 31901 HTTP 200, PostgreSQL 58258 listening, port 3000 absent, served commit/artifact exact, and no Provider call. Refresh the existing `/p/ai-us-3` terminal page and verify 7/7/6 images, 7/7/6 remarks, `流程已结束`, and `数据完整度 80%`.
