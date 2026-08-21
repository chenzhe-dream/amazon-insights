# VOC Run Progress and Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete OpenSpec 8.4's minimum durable VOC page experience: live stage observation, cancel/retry actions, report-version history, and URL refresh restoration.

**Architecture:** Keep Agent HTTP and the existing Worker as the only lifecycle authority. Extend the browser-safe `voc-run-browser` adapter to normalize the existing run, report, cancel, and retry APIs; `app/page.tsx` renders that observation and issues actions only for the current durable run ID. No new endpoints, runner, report store, or data-sync behavior are introduced.

**Tech Stack:** TypeScript, React/vinext, existing Fastify Agent HTTP, SQLite-backed Agent Service, Node `node:test`, fixture provider.

## Design decision

1. **Recommended — extend the existing browser client.** It owns exact API paths, structured errors, polling callbacks, and report-history normalization; the page owns only view state and button handling. This keeps refresh read-only and makes all POST behavior contract-testable.
2. **Rejected — page-local fetches for cancel/retry/history.** This would duplicate token/error handling and make it easy to accidentally re-submit on refresh.
3. **Rejected — a new aggregated server status endpoint.** Existing `GET /v1/runs/:runId` and `/reports` already expose the required durable records; a new endpoint expands 8.4 without benefit.

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\feat-voc-positioning-skill-execution` on `feat/voc-positioning-skill-execution`.
- Preserve current runtime-data WIP and `data/projects/*.json`: never reset, checkout, delete, overwrite, stage, or commit them.
- Do not change `package-lock.json`, migrations `0001`-`0005`, generated VOC inputs, or stash.
- Do not push, merge, rebase, amend, or use stash; add no dependency.
- Reuse only existing Worker, Skill, report repository, and Agent HTTP routes.
- VOC actions must retain the current run ID; refresh and polling issue only GET reads.
- Keep VOC and data-sync UI isolated: no SellerSprite, SIF, Sorftime, or Alexa action is triggered by progress, cancel, retry, or report selection.
- Keep 8.5 unchecked during 8.4 implementation. Use fixture provider for one smoke; do not manufacture failure/cancel smoke calls.
- Start any local Windows services hidden on ports `31900`/`31901`, capture their PIDs, and terminate only those trees after evidence.

---

## File responsibility map

- `app/lib/voc-run-browser.ts`: typed browser adapter; normalizes current report plus ordered history, read polling callbacks, and current-run cancel/retry mutations.
- `tests/agent/voc-run-browser.test.ts`: injected-fetch contract tests for GET-only observation, callback sequence, history, and exact cancel/retry requests.
- `app/page.tsx`: consumes observation state, renders stage/progress/error/report versions, and invokes adapter actions without altering data-sync flow.
- `tests/agent/local-data-bridge.test.ts`: page-boundary source guard for the browser adapter and isolation from sync endpoints.
- `openspec/changes/build-standalone-agent-workflow/tasks.md`: mark only 8.4 complete after code, focused tests, and fixture page evidence meet its wording.

---

### Task 1: Extend the browser VOC run adapter

**Files:**
- Modify: `app/lib/voc-run-browser.ts`
- Modify: `tests/agent/voc-run-browser.test.ts`

**Interfaces:**
- Produces `VocRunObservation = { kind, runId, stage, report, reports, message }`, where `reports` preserves API order and `report` is `reports[0] ?? null`.
- Extends `waitForVocRun(runId, { attempts, intervalMs, sleep, onObservation })`, where `onObservation(observation)` runs after every completed `observeVocRun` GET cycle, including the first and terminal cycle.
- Produces `cancelVocRun(runId, fetchImpl?)` and `retryVocStage(runId, stage = "voc-positioning", fetchImpl?)`; both return `Promise<VocRunObservation>` only after a follow-up GET observation.

- [x] **Step 1: Write adapter RED tests**

Add injected-fetch tests that return a running stage then a succeeded stage with reports `[v2, v1]`. Assert each `onObservation` receives the real status/progress sequence, `reports` remains `[v2, v1]`, and `report.id` is v2. Add exact request tests:

```ts
await cancelVocRun(runId, fetchImpl);
await retryVocStage(runId, "voc-positioning", fetchImpl);
assert.deepEqual(calls.slice(0, 2), [
  { method: "POST", url: `/v1/runs/${runId}/cancel`, body: "{}" },
  { method: "GET", url: `/v1/runs/${runId}` },
]);
assert.deepEqual(calls.slice(2, 4), [
  { method: "POST", url: `/v1/runs/${runId}/stages/voc-positioning/retry`, body: "{}" },
  { method: "GET", url: `/v1/runs/${runId}` },
]);
```

Also retain the refresh assertion that `observeVocRun` performs exactly two GETs and no POST.

- [x] **Step 2: Run RED**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts
```

Expected: missing history/callback/action exports or assertions fail against the current client.

- [x] **Step 3: Implement the smallest adapter extension**

Keep `responseJson` fail-closed. Use helpers rather than page fetches:

```ts
type ObserveOptions = { onObservation?: (value: VocRunObservation) => void };

function publish(value: VocRunObservation, onObservation?: ObserveOptions["onObservation"]) {
  onObservation?.(value);
  return value;
}

async function mutateThenObserve(path: string, fetchImpl: BrowserFetch) {
  const response = await fetchImpl(path, { method: "POST", body: "{}" });
  await responseJson(response, "VOC run action failed");
}
```

`observeVocRun` returns `reports` from the API unchanged in order. `waitForVocRun` calls `onObservation` after every `observeVocRun`. `cancelVocRun` and `retryVocStage` validate the run ID through the same entity-ID guard, POST the exact existing route with `{}`, then call `observeVocRun` for the same run ID. HTTP errors remain `VocRunClientError` with `waiting-input` only for 422; network `TypeError` retains the existing offline message.

- [x] **Step 4: Run GREEN and commit Task 1**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/voc-run-browser.test.ts tests/agent/contracts.test.ts
git add -- app/lib/voc-run-browser.ts tests/agent/voc-run-browser.test.ts
git diff --cached --check
git commit -m "feat(web): expose VOC run actions and history"
```

Expected: all tests pass; only the two listed files are staged.

---

### Task 2: Render durable progress, actions, and report history

**Files:**
- Modify: `app/page.tsx`
- Modify: `tests/agent/local-data-bridge.test.ts`

**Interfaces:**
- Consumes Task 1 `VocRunObservation`, `waitForVocRun(..., { onObservation })`, `cancelVocRun`, and `retryVocStage`.
- Produces a minimal card for the `voc` page tab with current stage status/progress/error, a current-run cancel/retry button, a waiting-input instruction, and report-version selection defaulting to the newest report.

- [x] **Step 1: Write page-boundary RED**

Extend the existing source test to assert the page imports `cancelVocRun` and `retryVocStage`, passes `onObservation` to `waitForVocRun`, renders `progress`, `lastError`, `reports`, and calls `setVocRun` from current-run action results. Assert the page still does not call `/v1/local-data/sync-asins` from the VOC card or contain a direct `fetch` to a VOC route.

- [x] **Step 2: Run RED**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts
```

Expected: the new adapter/action/history assertions fail before page wiring.

- [x] **Step 3: Wire page state and actions**

Keep one `vocRun` observation state and add only selected report ID state. On submit and URL restore, use:

```ts
const observe = (value: VocRunObservation) => setVocRun(value);
setVocRun(await waitForVocRun(runId, { onObservation: observe }));
```

For actions, guard `vocRun.runId`, call the adapter with that ID, set the returned observation, then resume read-only `waitForVocRun` only when it is active. Do not call `submitVocRun`, `ensureAnalysisWorkspace`, or `startSyncIfNeeded` from these handlers.

Render using existing card/button classes:

```tsx
<p>Stage: {String(vocRun.stage?.status ?? "queued")} · {String(vocRun.stage?.progress ?? 0)}%</p>
{vocRun.stage?.lastError ? <p>{errorSummary(vocRun.stage.lastError)}</p> : null}
{vocRun.kind === "active" ? <button onClick={cancelCurrentVocRun}>取消运行</button> : null}
{vocRun.kind === "failed" ? <button onClick={retryCurrentVocStage}>重试 VOC 阶段</button> : null}
{vocRun.kind === "waiting-input" ? <p>需要补齐可信 VOC 数据后再重试；不会自动采集外部数据。</p> : null}
```

Use `vocRun.reports` to render every persisted version. The selected version initially resolves to `vocRun.report` (API newest), changes only with the local selector, and shows its result summary. Retain the existing offline `npm run agent:dev` message.

- [x] **Step 4: Run GREEN and commit Task 2**

Run:

```powershell
node --import tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts tests/agent/voc-run-browser.test.ts tests/agent/asin-sync-session.test.ts
npx eslint app/page.tsx app/lib/voc-run-browser.ts tests/agent/local-data-bridge.test.ts tests/agent/voc-run-browser.test.ts
git add -- app/page.tsx tests/agent/local-data-bridge.test.ts
git diff --cached --check
git commit -m "feat(web): show VOC progress and report history"
```

Expected: focused tests pass, lint has no errors, and only the listed source/test files are staged.

---

### Task 3: Fixture page evidence and OpenSpec 8.4 completion

**Files:**
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`
- Modify: `docs/superpowers/plans/2026-08-15-voc-run-progress-actions.md`

**Interfaces:**
- Consumes the same fixture route and browser path from the prior slice.
- Produces evidence that the page shows stage observation, persisted report/history controls, and URL restoration; marks only 8.4 after those checks.

- [x] **Step 1: Start hidden fixture services and verify health**

Use `.env.local` with `AGENT_VOC_LOCAL_FAKE=1`, launch Agent on `31901` and web on `31900` with `Start-Process -WindowStyle Hidden -PassThru`, redirecting stdout/stderr to `%TEMP%\amazon-voc-8-4-logs`. Verify both `/health` and the page return HTTP 200 without printing environment values.

- [x] **Step 2: Run one fixture page smoke**

Open `http://127.0.0.1:31900/p/kick-scooters-us-2`; submit `B07VY9Q95Q`, `B0BPXRVWYK`, `B07DYG1C9B` once. Record run ID, stage status/progress, report ID/version, and visible history selector. Reload the URL carrying `run=<uuid>&tab=voc`; verify the same report appears and browser resource entries contain only existing `GET /v1/runs/:runId` and `GET /v1/runs/:runId/reports` reads for the restore. Do not invoke cancel/retry in smoke.

Observed: fixture run `68fd9bd6-029d-4fe7-bf9e-abc00b8cc31b` reached `voc-positioning=succeeded` at `100%`; report `69c4e9f3-77a4-4a72-8192-527cebcfb7c4` is version `1`. The page displayed the saved-version selector and, after fresh URL load, rendered the same report while Agent resources included only GET reads for that run and reports.

- [x] **Step 3: Stop only captured processes and verify final focused checks**

Run:

```powershell
taskkill /PID $agent.Id /T /F
taskkill /PID $web.Id /T /F
Get-NetTCPConnection -LocalPort 31900,31901 -State Listen -ErrorAction SilentlyContinue
node --import tsx --conditions=react-server --test tests/agent/formal-voc-submission.test.ts tests/agent/voc-run-browser.test.ts tests/agent/local-data-bridge.test.ts tests/agent/asin-sync-session.test.ts tests/agent/service-security.test.ts tests/agent/contracts.test.ts
npx openspec validate build-standalone-agent-workflow --strict
```

Expected: no listener remains, focused tests pass, and OpenSpec validation is valid.

- [x] **Step 4: Mark 8.4 and commit Task 3**

After Steps 1-3 succeed, change only the 8.4 checkbox in `openspec/changes/build-standalone-agent-workflow/tasks.md` to `[x]`; leave 8.5 `[ ]`. Check this plan's completed steps, then run:

```powershell
git add -- openspec/changes/build-standalone-agent-workflow/tasks.md docs/superpowers/plans/2026-08-15-voc-run-progress-actions.md
git diff --cached --check
git commit -m "docs(openspec): complete VOC page acceptance"
```

---

## Post-8.4 8.5 preflight and single real-provider attempt

1. Read configuration presence only (never print values) for `OPENAI_API_KEY`, `HTTPS_PROXY`, `HTTP_PROXY`, and `NODE_USE_ENV_PROXY`.
2. If the existing complete real-provider configuration is present, start the same hidden services without fixture mode, submit the existing-data fixture once, and record only durable run/report IDs, HTTP status, provider error category, and page-refresh result. Mark 8.5 only if the real request reaches persisted SQLite report and survives refresh.
3. If a required variable is absent, authentication fails, quota is exhausted, or network fails, stop the attempt, leave 8.5 unchecked, and report the precise variable name or error category plus the safe verification command. Do not modify configuration, log values, or expand implementation scope.

## Self-review

- Coverage: Task 1 covers adapter callback/history/actions and GET-only restoration; Task 2 covers 8.4 page progress/error/action/history/offline behavior and sync isolation; Task 3 supplies fixture browser evidence and checkbox discipline.
- Placeholder scan: no TBD/TODO items; every action has a path, type, command, or concrete assertion.
- Type consistency: `VocRunObservation.reports`, `onObservation`, `cancelVocRun`, and `retryVocStage` are defined in Task 1 and consumed with identical names in Task 2.
