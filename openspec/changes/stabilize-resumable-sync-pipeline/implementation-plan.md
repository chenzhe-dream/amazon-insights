# Trend Projection and Image Reactivation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让原三个新 ASIN 的 traffic snapshot 与主辅图分析在同一 canonical job/run 中完成，不创建重复任务。

**Architecture:** Trend raw response 在 `sif-traffic-snapshot-task` 的 provider adapter 边界投影为现有 canonical monthly record；未知及未消费字段直接丢弃。图片阶段在读取最新 Listing 图册后重新评估 pending，并通过持久化 job/ASIN 执行权保证只入队一次，图片结果完成后再发布。

**Tech Stack:** TypeScript、Node.js ESM、Zod、Node test runner、PostgreSQL sync job store、OpenSpec。

## Global Constraints

- 复用原 job `07faf6e9-899e-4d5f-82a3-016d920b5ab0`、run `8cb96776-281a-4a99-8d7e-ad5926547d71` 与唯一 traffic stage；不得创建新 job/run/stage。
- 三个 ASIN 固定为 `B07ZPGD8YR`、`B088LPLNPK`、`B0G5N593D6`。
- 不使用 `passthrough`、`any` 或 raw provider object 持久化；未消费和未知字段不得进入领域模型、诊断、日志、快照或 content hash。
- 图片 URL 已有 7/7/6 张；图片修复不得重新抓取 Listing，只重新激活缺失的图片分析。
- 两个任务独立提交、独立复审；未通过复审不得部署或调用真实 provider。
- 保留工作区 15 个 modified generated `app/*.ts` 与 3 个 untracked `data/projects/*.json`，禁止 reset、stash、clean、rebase、amend 和 `git add .`。

---

### Task 1: Trend raw response canonical projection

**Files:**
- Modify: `server/services/sif-traffic-snapshot-task.ts`
- Test: `tests/agent/sif-traffic-snapshot-task.test.ts`
- Test: `tests/agent/sync-job-dispatcher.test.ts`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`

**Interfaces:**
- Consumes: `ConnectorResult["data"]` from `ops_get_asin_traffic_trend`.
- Produces: unchanged `{ dates, nfScore, adScore }` canonical result consumed by `normalizeTrafficRecord`.

- [ ] **Step 1: Write the failing projection tests**

Add a live-equivalent object containing valid `dates`, `nfScore`, `adScore`, all other documented fields and four opaque extra keys. Assert `createForRun` succeeds, stores only the existing monthly fields, and serialized snapshot/diagnostic output contains none of the opaque keys or sentinel values. Add separate cases for missing `dates`, wrong score-array type, invalid month, negative/non-finite score and 25 points; each must reject with `SIF_TRAFFIC_SCHEMA_INVALID` and write zero snapshots.

- [ ] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/sif-traffic-snapshot-task.test.ts tests/agent/sync-job-dispatcher.test.ts`

Expected: the complete-object success case fails with `SIF_TRAFFIC_SCHEMA_INVALID`; malformed cases remain failing closed.

- [ ] **Step 3: Implement minimal projection**

Keep `MonthlyTrendSchema` as the strict canonical validator. Add a small adapter before `parseTrafficOperation` that checks the raw value is a plain object and constructs only one of these two candidates:

```ts
{
  dates: candidate.dates,
  nfScore: candidate.nfScore,
  adScore: candidate.adScore,
  ...(candidate.data_notice === undefined ? {} : { data_notice: candidate.data_notice }),
  ...(candidate.fetchedAt === undefined ? {} : { fetchedAt: candidate.fetchedAt }),
}
```

or the legacy `{ dates, nf, ad, data_notice?, fetchedAt? }` form. Pass only that projected value to the existing strict schema. Do not copy any other raw key.

- [ ] **Step 4: Run GREEN and gates**

Run the RED command again; expected all pass. Then run the affected lint command used by the repository, one production build, `npx openspec validate stabilize-resumable-sync-pipeline --strict`, and `git diff --check`.

- [ ] **Step 5: Commit explicit paths**

Stage only the two implementation/test files plus approved OpenSpec evidence and commit `fix: project official SIF trend response`.

### Task 2: Image analysis reactivation after gallery readiness

**Files:**
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `scripts/lib/sync-job-store.mjs` only if the existing atomic patch API cannot express execution ownership
- Test: `tests/scripts/sync-pipeline-ordering.test.mjs`
- Test: `tests/scripts/asin-sync-job-postconditions.test.mjs`
- Test: `tests/scripts/image-remarks-concurrency.test.mjs`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`

**Interfaces:**
- Consumes: latest `asinsNeedingImageRemarksSync(asins)` result after Listing persistence.
- Produces: one execution decision per job/ASIN and final `image_remarks` status after `readImageRemarkStatuses()`.

- [ ] **Step 1: Write the failing lifecycle tests**

Create a harness where the first image check sees no gallery and performs zero analysis calls; the same job later sees gallery-ready/imageRemarks-missing and must select the ASIN. Add two concurrent recovery calls and assert only one receives execution ownership. Assert a ready ASIN is never selected again and publication does not report ready before persisted remarks exist.

- [ ] **Step 2: Run RED**

Run: `node --test tests/scripts/sync-pipeline-ordering.test.mjs tests/scripts/asin-sync-job-postconditions.test.mjs tests/scripts/image-remarks-concurrency.test.mjs`

Expected: late-gallery reactivation or concurrent exactly-once assertion fails against the current permanent skipped/upstream-empty behavior.

- [ ] **Step 3: Implement minimal reactivation**

Re-read the latest job and Listing sources immediately before image selection. Treat prior `upstream-empty/skipped` caused by absent gallery as re-evaluable when gallery is now ready and remarks remain missing. Acquire one persistent execution owner for each selected job/ASIN before invoking `image-remarks:sync`; duplicate recovery observes the owner or terminal result and skips. Apply `readImageRemarkStatuses()` only after the command returns, then terminalize the image stage and final publication.

- [ ] **Step 4: Run GREEN and gates**

Run the RED command again; expected all pass. Then run affected lint, one production build, strict OpenSpec validation, and `git diff --check`.

- [ ] **Step 5: Commit explicit paths**

Stage only the image lifecycle implementation/tests plus approved OpenSpec evidence and commit `fix: reactivate image analysis after gallery readiness`.

### Task 3: Review, deploy, and original-task verification

**Files:**
- No source edits during deployment.

- [ ] **Step 1: Independent review Task 1**

Review the exact base-to-head diff for projection correctness, fail-closed malformed inputs, no raw-field leakage, WIP boundary and test authenticity. Fix all Critical/Important findings and re-review.

- [ ] **Step 2: Deploy Task 1 and resume once**

Require active=0, health 31900/31901/58258, 3000 absent, migration 15/15, fake=false, unchanged counts and safe WIP. Reuse the exact authenticated run+syncJob page and click only `续跑失败阶段` once. Verify traffic snapshot count becomes 1 and the same stage succeeds.

- [ ] **Step 3: Independent review Task 2**

Review late-gallery reactivation, exactly-once ownership, publication ordering, ready preservation, no Listing refetch and no duplicate image calls. Fix all Critical/Important findings and re-review.

- [ ] **Step 4: Deploy Task 2 and finish the original job**

Use the original canonical identity and one authorized recovery action. Verify image analysis calls are greater than zero and at most once per image, 7/7/6 gallery URLs remain unchanged, image remarks become visible, traffic snapshot remains present, and no new job/run/stage is created.
