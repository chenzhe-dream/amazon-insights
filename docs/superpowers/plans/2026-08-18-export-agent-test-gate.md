# Export Agent Test Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align stale test fixtures and migration expectations with the already-protected migrations 0007 and 0008 so the complete Agent test gate validates the committed runtime correctly.

**Architecture:** Keep production code and migrations unchanged. Repair only test setup that bypasses the repository API and hard-coded expectations that stop at migration 0006. Preserve intentional legacy snapshot branches and all database integrity triggers.

**Tech Stack:** TypeScript, Node test runner, `tsx`, SQLite `DatabaseSync`.

## Global Constraints

- Do not modify migrations `0001` through `0008`.
- Do not modify production code, `package-lock.json`, generated Skills/VOC, `.env*`, data files, stash, or the original feature worktree.
- Do not weaken or drop snapshot artifact-kind integrity triggers.
- Keep the repair test-only and limited to the four files named below.
- Full acceptance requires `npm run test:agent` to exit 0 from the clean repair worktree.

---

### Task 1: Align Agent test fixtures with protected snapshot migrations

**Files:**
- Modify: `tests/agent/agent-run-repository.test.ts`
- Modify: `tests/agent/agent-run-service.test.ts`
- Modify: `tests/agent/sqlite-migrations.test.ts`
- Modify: `tests/agent/repository.test.ts`

**Interfaces:**
- Consumes: migration 0007 `data_snapshots.artifact_kind` contract and migration 0008 migration registry.
- Produces: test fixtures that insert current VOC snapshots with both `snapshot_kind = 'voc'` and `artifact_kind = 'voc'`; migration assertions covering versions 1 through 8.

- [ ] **Step 1: Verify the deterministic RED baseline**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/agent-run-repository.test.ts
npx tsx --conditions=react-server --test tests/agent/agent-run-service.test.ts
npx tsx --conditions=react-server --test tests/agent/sqlite-migrations.test.ts
npx tsx --conditions=react-server --test tests/agent/repository.test.ts
```

Expected: non-zero exits. AgentRun suites fail with `data snapshot artifact kind is inconsistent`; migration suites fail because assertions still describe migrations 1 through 6 or obsolete trigger text.

- [ ] **Step 2: Repair current VOC direct-insert fixtures without changing legacy fixtures**

In both current VOC inserts in `tests/agent/agent-run-repository.test.ts`, change the SQL shape from:

```ts
(id, run_id, snapshot_kind, schema_version, marketplace, asins_json,
 data_cutoff_at, sources_json, payload_json, content_hash, created_at)
VALUES (?, ?, 'voc', ?, ?, ?, ?, ?, ?, ?, ?)
```

to:

```ts
(id, run_id, snapshot_kind, artifact_kind, schema_version, marketplace, asins_json,
 data_cutoff_at, sources_json, payload_json, content_hash, created_at)
VALUES (?, ?, 'voc', 'voc', ?, ?, ?, ?, ?, ?, ?)
```

Apply the same change to `seedActiveExecution` in `tests/agent/agent-run-service.test.ts`.

Do not change the intentional legacy insert in `agent-run-repository.test.ts` that omits `snapshot_kind` after explicitly dropping the legacy guard.

- [ ] **Step 3: Align protected migration assertions**

In `tests/agent/sqlite-migrations.test.ts`, replace:

```ts
assert.match(sql, /OLD\.status <> 'failed'/i);
assert.match(sql, /NEW\.status <> 'queued'/i);
```

with:

```ts
assert.match(sql, /OLD\.status IS 'failed'/i);
assert.match(sql, /NEW\.status IS 'queued'/i);
```

In `tests/agent/repository.test.ts`, extend the expected migration list with:

```ts
{ version: 7, name: "traffic_data_snapshot" },
{ version: 8, name: "keyword_analysis_snapshot" },
```

Change the concurrent migration count expectation from `6` to `8`, and change the upgraded version array from `[1, 2, 3, 4, 5, 6]` to `[1, 2, 3, 4, 5, 6, 7, 8]`.

- [ ] **Step 4: Verify focused GREEN**

Run the four commands from Step 1 again.

Expected:

- `agent-run-repository.test.ts`: 30 passed, 0 failed.
- `agent-run-service.test.ts`: 20 passed, 0 failed.
- `sqlite-migrations.test.ts`: 0 failed.
- `repository.test.ts`: 20 passed, 0 failed.

- [ ] **Step 5: Verify the complete gate and adjacent noise candidates**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/model-budget-repository.test.ts
npx tsx --conditions=react-server --test tests/agent/voc-legacy-characterization.test.ts
npm run test:agent
git diff --check
```

Expected: every command exits 0. If a worker timeout appears only in the full suite, stop and report it as a separate concurrency diagnosis; do not change production code or timing thresholds in this task.

- [ ] **Step 6: Commit only the plan and four test files**

```powershell
git add docs/superpowers/plans/2026-08-18-export-agent-test-gate.md tests/agent/agent-run-repository.test.ts tests/agent/agent-run-service.test.ts tests/agent/sqlite-migrations.test.ts tests/agent/repository.test.ts
git commit -m "test(agent): align fixtures with snapshot migrations"
```

Do not add `.superpowers/`, `node_modules/`, credentials, data, generated assets, or any unrelated file.
