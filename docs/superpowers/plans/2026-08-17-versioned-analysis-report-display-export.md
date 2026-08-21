# Versioned Analysis Report Display And Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display and export the selected saved versions of traffic, VOC, and product-definition reports from one analysis run.

**Architecture:** Keep the existing report APIs and repository unchanged. A pure browser module groups saved reports by stage, selects an explicit report id or the latest complete version, and builds one immutable export bundle; `app/page.tsx` renders and downloads that same bundle.

**Tech Stack:** TypeScript, React client components, Node test runner, existing Agent HTTP contracts.

## Global Constraints

- Reuse `GET /v1/runs/:runId/reports` and `GET /v1/reports/:reportId`.
- Do not recompute report results from static `app` data.
- Do not add dependencies, storage, migrations, real provider calls, or UI redesign.
- Preserve package-lock, migrations 0001-0005/0008, generated VOC, runtime data WIP, and stash.

---

### Task 1: Saved-report selection and export contract

**Files:**
- Create: `app/lib/saved-analysis-reports.ts`
- Create: `tests/agent/saved-analysis-reports.test.ts`
- Modify: `app/lib/voc-run-browser.ts`

**Interfaces:**
- Produces: `buildSavedAnalysisReportView(runId, reports, selectedIds)`, `readSavedAnalysisReport(reportId, fetchImpl)`, `serializeSavedAnalysisReportView(view)`.
- Each stage slot contains ordered history and exactly one selected saved report or `null`.

- [x] **Step 1: Write the failing test**

Create valid traffic v1, VOC v1/v2, and product v1 reports. Assert explicit VOC v1 selection controls both view and serialized export, default selection is latest complete, refresh reconstruction is deterministic, missing product is `null`, and detail reading uses `GET /v1/reports/:reportId`.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --conditions=react-server --test tests/agent/saved-analysis-reports.test.ts`

Expected: FAIL because `app/lib/saved-analysis-reports.ts` does not exist.

- [x] **Step 3: Write minimal implementation**

Use the shared `AnalysisReportSchema`/`GetReportResponseSchema`, the closed stage tuple `traffic-analysis | voc-positioning | product-definition`, stable version-descending ordering, and an export shape containing `runId` plus the selected saved report fields (`id`, `stage`, `version`, `status`, `schemaVersion`, `skill`, `dataCutoffAt`, `result`).

- [x] **Step 4: Run test to verify it passes**

Run: `npx tsx --conditions=react-server --test tests/agent/saved-analysis-reports.test.ts tests/agent/voc-run-browser.test.ts`

Expected: all tests pass and refresh performs only GET requests.

### Task 2: Existing page selector and export button wiring

**Files:**
- Modify: `app/page.tsx`
- Modify: `tests/agent/local-data-bridge.test.ts`
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Consumes: the exact view returned by `buildSavedAnalysisReportView`.
- Produces: one selector/result block per report stage and a JSON download built from that same view object.

- [x] **Step 1: Write the failing page seam test**

Assert the existing page imports the saved-report module, renders all three closed stage labels and explicit no-report state, calls the detail endpoint on selection, and wires the existing `导出对比报告` button to the shared serialized view.

- [x] **Step 2: Run test to verify it fails**

Run: `npx tsx --conditions=react-server --test tests/agent/local-data-bridge.test.ts`

Expected: FAIL because the page still renders only the VOC selector and the export button has no handler.

- [x] **Step 3: Write minimal page wiring**

Replace the single VOC selector state with per-stage selected ids; derive one memoized saved-report view from `vocRun.reports`; fetch an explicitly selected report with the existing detail API; render report identity, status, Skill provenance and JSON result; download the same memoized view as JSON.

- [x] **Step 4: Run focused GREEN and gates**

Run: `npx tsx --conditions=react-server --test tests/agent/saved-analysis-reports.test.ts tests/agent/voc-run-browser.test.ts tests/agent/local-data-bridge.test.ts`

Run: `npx eslint app/lib/saved-analysis-reports.ts app/lib/voc-run-browser.ts app/page.tsx tests/agent/saved-analysis-reports.test.ts tests/agent/local-data-bridge.test.ts`

Run: `npx openspec validate build-standalone-agent-workflow --strict`

Expected: all focused tests pass, ESLint exits 0, OpenSpec is valid, and `git diff --check` exits 0.

- [x] **Step 5: Check only 10.4 and create the checkpoint**

Stage only the plan, client/report tests, page/client implementation, and OpenSpec task file. Commit without amend or push.
