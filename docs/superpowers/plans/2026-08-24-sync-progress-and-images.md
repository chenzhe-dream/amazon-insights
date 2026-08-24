# Sync Progress And Raw Images Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the sync UI truthfully separate execution progress from data completeness, treat Alexa and disabled image AI as non-automatic work, and show MCP-provided raw product images whenever Sorftime listing data exists.

**Architecture:** Keep job lifecycle and polling unchanged. Add a pure display projection for terminal/executing/manual/disabled states, consume it in the existing funnel, and keep raw listing image rendering independent from AI image remarks. No provider calls or new job creation are part of this plan.

**Tech Stack:** Next.js, React, TypeScript, Node test runner, Playwright browser harness, CSS.

## Global Constraints

- Product data MUST come only from the existing MCP sync output; never synthesize a title, price, metric, or image URL.
- Alexa VOC remains manual and MUST NOT show a percentage, countdown, or estimated finish time.
- `image_remarks` remains disabled and MUST NOT show automatic progress; raw Sorftime `main_image` / `a_plus` images remain displayable.
- A terminal job reports execution as 100%, while data completeness remains a separate truthful value.
- Refresh, dismiss, restart, and workspace-switch semantics from commit `ebad8585e4072a83f1c1b13c485fe3dd9845193a` MUST remain unchanged.
- Do not touch generated MCP data files or the six untracked project JSON files.

---

### Task 1: Pure progress presentation

**Files:**
- Create: `app/lib/sync-progress-presentation.ts`
- Modify: `app/asin-sync-funnel.tsx`
- Modify: `app/comparison-layout.css`
- Test: `tests/agent/asin-sync-session.test.ts`
- Test: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx`

**Interfaces:**
- Consumes: `SyncJob`, `SyncStage`, current clock, and optional focused stage ids.
- Produces: `presentSyncProgress(job, now, focusStageIds)` returning `{ executionPercent, completenessPercent, remainingSeconds, finishAt, terminal, rows }`; each row exposes `mode: "automatic" | "manual" | "disabled"`, `executionPercent`, and status copy.

- [ ] **Step 1: Write RED browser tests**

Add fixtures for a running job and a terminal `completed-with-gaps` job. Assert the terminal job renders `执行进度 100%`, a separate `数据完整度`, no remaining/ETA, manual Alexa text without `%`, and disabled image AI text without `%`. Assert the running job still advances the active automatic stage and leaves pending stages at 0.

```ts
assert.equal(await page.getByText("执行进度 100%", { exact: true }).count(), 1);
assert.equal(await page.getByText(/数据完整度 \d+%/).count(), 1);
assert.equal(await page.getByTestId("sync-stage-alexa_voc").getByText("待人工录入").count(), 1);
assert.equal(await page.getByTestId("sync-stage-alexa_voc").getByText(/%|剩余|预计/).count(), 0);
assert.equal(await page.getByTestId("sync-stage-image_remarks").getByText("已停用，待后续分析").count(), 1);
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npx tsx --test tests/agent/asin-sync-session.test.ts`

Expected: the new assertions fail because terminal partial stages currently remain at 0 and Alexa currently displays simulated progress.

- [ ] **Step 3: Implement the pure projection**

Use terminal statuses as attempted execution and calculate completeness only from successful module outcomes.

```ts
const TERMINAL_JOB = new Set(["completed", "completed-with-gaps", "failed"]);
const TERMINAL_STAGE = new Set(["done", "partial", "skipped", "failed", "manual"]);

export function presentSyncProgress(job: SyncJob, now: number, focusStageIds?: readonly string[]) {
  const terminal = TERMINAL_JOB.has(job.status);
  const automatic = selectedStages(job.stages, focusStageIds).filter(stage => stage.kind === "auto");
  const executed = automatic.filter(stage => terminal || TERMINAL_STAGE.has(stage.status)).length;
  const complete = automatic.filter(stage => stage.status === "done").length;
  return {
    terminal,
    executionPercent: Math.round((executed / Math.max(automatic.length, 1)) * 100),
    completenessPercent: Math.round((complete / Math.max(automatic.length, 1)) * 100),
    remainingSeconds: terminal ? 0 : remainingAutomaticSeconds(automatic, now),
    rows: job.stages.map(presentStage),
  };
}
```

`presentStage` must return `manual` for `alexa_voc`, `disabled` for the currently disabled `image_remarks`, and `automatic` for the remaining stages. It must not invent progress for manual or disabled rows.

- [ ] **Step 4: Render the projection and truthful Chinese copy**

Replace `MCP 进度` with `执行进度`; render `数据完整度` beside it; hide remaining and ETA for terminal jobs. Replace idle copy `含 Alexa VOC 全自动采集` with `Alexa VOC 需人工录入`. Add stable `data-testid="sync-stage-${stage.id}"` selectors. Keep partial/failed rows visually distinct and completed as terminal execution rather than pending.

- [ ] **Step 5: Run focused GREEN tests**

Run: `npx tsx --test tests/agent/asin-sync-session.test.ts`

Expected: all tests pass, including existing refresh GET-only, no duplicate POST, dismiss, restart, and reload-loop tests.

- [ ] **Step 6: Commit Task 1 only**

```powershell
git add app/lib/sync-progress-presentation.ts app/asin-sync-funnel.tsx app/comparison-layout.css tests/agent/asin-sync-session.test.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx
git commit -m "fix: separate sync execution from data completeness"
```

---

### Task 2: Keep raw images independent from AI remarks

**Files:**
- Modify: `app/listing-images-section.tsx`
- Test: `tests/agent/listing-images-section.test.tsx` (create if no focused test exists; otherwise extend the existing listing-image test)

**Interfaces:**
- Consumes: existing Sorftime listing records containing `product_detail.main_image` / `a_plus` and existing image remarks records.
- Produces: raw image gallery whenever listing images exist, with an independent `AI 备注待后续分析` state when remarks are absent/disabled.

- [ ] **Step 1: Write RED component tests**

Cover: listing images present + remarks absent renders all provided image URLs; listing images absent renders a truthful no-data state; no test may insert a fabricated fallback URL.

```tsx
render(<ListingImagesSection asins={[asin]} listingByAsin={{ [asin]: listingWithImages }} remarksByAsin={{}} />);
expect(screen.getAllByRole("img").map(image => image.getAttribute("src"))).toEqual(expectedMcpUrls);
expect(screen.getByText("AI 备注待后续分析")).toBeTruthy();
```

- [ ] **Step 2: Run the focused test and confirm RED if AI state currently suppresses raw images**

Run the exact focused listing-image test file with the repository's Node/TSX test command.

Expected: the new independence assertion fails only if the section currently couples gallery rendering to remarks readiness.

- [ ] **Step 3: Apply the minimal render split**

Derive `rawImages` only from the MCP listing record. Derive `remarksState` independently. Render no image element when the MCP record contains no URL.

```ts
const rawImages = listing ? listing.galleryImages.filter(isTrustedImageUrl) : [];
const remarksState = remarks ? "ready" : "disabled";
```

- [ ] **Step 4: Run GREEN tests and commit Task 2**

Run the focused listing-image test and `npx tsx --test tests/agent/asin-sync-session.test.ts`.

Expected: all pass; no POST/provider call is added.

```powershell
git add app/listing-images-section.tsx tests/agent/listing-images-section.test.tsx
git commit -m "fix: show MCP listing images without AI remarks"
```

---

### Task 3: Combined UI gate

**Files:**
- Verify only; no production edits unless a direct regression is found.

- [ ] Run the two focused suites plus changed-file ESLint.
- [ ] Run `git diff --check` only over the task commit range so protected generated WIP is not rewritten.
- [ ] Run one production build after both tasks are integrated.
- [ ] Confirm no generated data file or project JSON is staged.
- [ ] Request one independent limited review with gates `Critical=0` and `direct business blockers=0`.

