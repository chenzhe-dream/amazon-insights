# Canonical Runtime Data Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate formal mutable runtime data from Git worktrees while preserving explicit development fallback and restoring audited history safely under `C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime`.

**Architecture:** P0 adds one root-resolution contract for the formal manager/launcher and project store, writes an atomic safe identity record while preserving existing state fields, and restores project JSON only. P1 separately migrates the complete Alexa publication unit atomically and handles rare races.

**Tech Stack:** Node.js ESM, PowerShell formal launcher, TypeScript, Node test runner, existing `tsx`/`npm` scripts.

## Global Constraints

- Code baseline: `a6a2bc4`.
- P0 implementation and verified project restoration are allowed under the
  gates in this plan. Push, deployment, provider calls, and real POSTs remain
  prohibited. A controlled restart has a separate approval and verification
  gate.
- Formal mode requires `AGENT_DATA_ROOT` and `AGENT_RUNTIME_ROOT`, both absolute and beneath the canonical shared root; development fallback is `<codeRoot>/data` only outside formal mode.
- Add `codeRoot`, `dataRoot`, `runtimeRoot`, and commit to the state record while preserving all existing fields; never persist secrets, provider bodies, or database URLs.
- Observed inventory: source 23, live 7, common 6, union 24, and 17 missing-only IDs. Preserve both different-ID same-scope records and mark the restored one duplicate.
- Require `active = 0`, verified backup hashes, exclusive-create, copied-file hash verification, and an exact rollback manifest.
- Never restore SQLite, sync jobs, Web runtime/reload artifacts, locks/owners, Alexa files, or generated `app/*-data.ts` in P0.

---

## File Map

- Create: `scripts/lib/runtime-roots.mjs` — validates and resolves formal/development roots.
- Create: `scripts/lib/runtime-data-restore.mjs` — inventories, plans, and applies guarded project-only missing restoration.
- Modify: `scripts/start-agent-stack.mjs` — consumes roots, passes them to children, records formal state atomically.
- Modify: `scripts/team-prod-server.mjs`, `server/config.ts`, and the project-store data-root entry point — consume the resolved root rather than implicit `cwd/data`.
- Modify: `scripts/manage-formal-stack.ps1` — requires/forwards formal root arguments and reads the canonical state file.
- Create: `tests/scripts/runtime-roots.test.mjs` and `tests/scripts/runtime-data-restore.test.mjs`.
- Extend: `tests/scripts/start-agent-stack.test.mjs`.

### Task 1: Define and test the root-resolution contract

**Files:**

- Create: `scripts/lib/runtime-roots.mjs`
- Test: `tests/scripts/runtime-roots.test.mjs`

**Interfaces:**

- Produces `resolveRuntimeRoots({ codeRoot, dataRoot, runtimeRoot, formal, commit })`.
- Returns `{ codeRoot, dataRoot, runtimeRoot, commit, mode }`, where every root is absolute and normalized.

- [ ] **Step 1: Write failing contract tests**

```js
assert.throws(() => resolveRuntimeRoots({ codeRoot, formal: true }), /dataRoot/);
assert.throws(() => resolveRuntimeRoots({ codeRoot, dataRoot: "relative", runtimeRoot, formal: true }), /absolute/);
assert.throws(() => resolveRuntimeRoots({ codeRoot, dataRoot: join(codeRoot, "data"), runtimeRoot, formal: true }), /worktree/);
assert.deepEqual(resolveRuntimeRoots({ codeRoot, formal: false }), {
  codeRoot, dataRoot: join(codeRoot, "data"), runtimeRoot: join(codeRoot, ".runtime"), commit, mode: "development",
});
```

- [ ] **Step 2: Run the test to verify RED**

Run: `node --test tests/scripts/runtime-roots.test.mjs`

Expected: FAIL because `runtime-roots.mjs` does not exist.

- [ ] **Step 3: Implement the minimal resolver**

```js
export function resolveRuntimeRoots(input) {
  const codeRoot = resolve(input.codeRoot);
  if (!input.formal) return { codeRoot, dataRoot: join(codeRoot, "data"), runtimeRoot: join(codeRoot, ".runtime"), commit: input.commit, mode: "development" };
  // Require absolute non-code-root dataRoot/runtimeRoot and return normalized values.
}
```

- [ ] **Step 4: Run the focused test to verify GREEN**

Run: `node --test tests/scripts/runtime-roots.test.mjs`

Expected: PASS.

### Task 2: Wire formal launcher identity and child roots

**Files:**

- Modify: `scripts/start-agent-stack.mjs`
- Modify: `scripts/manage-formal-stack.ps1`
- Modify: `scripts/team-prod-server.mjs`
- Test: `tests/scripts/start-agent-stack.test.mjs`

**Interfaces:**

- Consumes `resolveRuntimeRoots` from Task 1.
- Produces atomically written `<runtimeRoot>/state/stack.json` with added `codeRoot`, `dataRoot`, `runtimeRoot`, and `commit`, preserving all pre-existing state fields.

- [ ] **Step 1: Write failing launcher tests**

```js
assert.throws(() => buildFormalLaunch({ codeRoot, formal: true }), /dataRoot/);
const launch = buildFormalLaunch({ codeRoot, dataRoot, runtimeRoot, formal: true });
assert.equal(launch.childEnv.AGENT_DATA_ROOT, dataRoot);
assert.equal(launch.childEnv.AGENT_RUNTIME_ROOT, runtimeRoot);
assert.deepEqual(readState(launch.statePath), expect.objectContaining({ codeRoot, dataRoot, runtimeRoot, commit }));
```

- [ ] **Step 2: Run the focused launcher test to verify RED**

Run: `node --test tests/scripts/start-agent-stack.test.mjs`

Expected: FAIL for missing explicit-root validation/state fields.

- [ ] **Step 3: Implement minimal formal wiring**

Pass `AGENT_DATA_ROOT` and `AGENT_RUNTIME_ROOT` consistently to Web/Agent children, resolve commit from `codeRoot`, merge identity into the existing state object, write through an adjacent temporary file plus atomic rename, and make every formal launcher reject absent or divergent roots before spawning.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/scripts/runtime-roots.test.mjs tests/scripts/start-agent-stack.test.mjs`

Expected: PASS.

### Task 3: Make project-store data lookup root-aware

**Files:**

- Modify: `server/config.ts`
- Modify: the exact project-store root consumers identified during implementation
- Test: `tests/agent/agent-storage-config.test.ts`.

**Interfaces:**

- Consumes `AGENT_DATA_ROOT` and `AGENT_RUNTIME_ROOT` from Task 2.
- Produces a single validated resolved data-root value for project-store consumers. Alexa and other runtime consumers remain P1 work.

- [ ] **Step 1: Write failing configuration tests**

```ts
assert.equal(resolveDataRoot({ AGENT_DATA_ROOT: sharedDataRoot }, codeRoot), sharedDataRoot);
assert.equal(resolveDataRoot({}, codeRoot), join(codeRoot, "data"));
assert.throws(() => resolveDataRoot({ AGENT_DATA_ROOT: "relative" }, codeRoot), /absolute/);
```

- [ ] **Step 2: Run only the affected test file(s) to verify RED**

Run: `npm exec -- tsx --test tests/agent/agent-storage-config.test.ts`

Expected: FAIL because current consumers use the worktree-local path.

- [ ] **Step 3: Implement the smallest shared-root injection**

Replace implicit project-store root construction with the unified `AGENT_*` contract; retain local fallback outside formal mode. Defer Alexa wiring and rare-race hardening to P1.

- [ ] **Step 4: Run focused configuration and launcher tests**

Run: `node --test tests/scripts/runtime-roots.test.mjs tests/scripts/start-agent-stack.test.mjs && npm exec -- tsx --test tests/agent/agent-storage-config.test.ts`

Expected: PASS.

### Task 4 (P0): Add guarded project-only missing restoration

**Files:**

- Create: `scripts/lib/runtime-data-restore.mjs`
- Create: `tests/scripts/runtime-data-restore.test.mjs`
- Modify: `scripts/manage-formal-stack.ps1` to expose explicit dry-run and approved apply commands.

**Interfaces:**

- Produces `planRuntimeRestore({ sourceRoot, destinationRoot })` with `missingProjects`, duplicate markers, conflicts, backup hashes, and rollback manifest paths.
- Rejects SQLite, Alexa files, generated TS, sync jobs, Web artifacts, and locks by construction.

- [ ] **Step 1: Write failing restoration tests**

```js
const plan = await planRuntimeRestore({ sourceRoot, destinationRoot });
assert.equal(plan.missingProjects.length, sourceProjects.length - commonProjects.length);
assert.equal(plan.requiresActiveCount, 0);
assert.equal(plan.sameScopeDifferentId.length, 1);
assert.equal(plan.sameScopeDifferentId[0].action, "preserve-and-mark-duplicate");
assert.equal(plan.copyPaths.some(path => path.includes("app/")), false);
assert.equal(plan.copyPaths.some(path => path.includes("sync-jobs")), false);
```

- [ ] **Step 2: Run the focused test to verify RED**

Run: `node --test tests/scripts/runtime-data-restore.test.mjs`

Expected: FAIL because the planner does not exist.

- [ ] **Step 3: Implement inventory and conflict logic**

Require `active = 0`; hash and verify the destination backup; include a project only when its ID path is absent; report same-name/same-scope differences while preserving different IDs. Apply with exclusive-create, verify each destination hash, and emit the exact created-path/hash rollback manifest. Rollback removes only unchanged manifest entries.

- [ ] **Step 4: Run focused tests to verify GREEN**

Run: `node --test tests/scripts/runtime-data-restore.test.mjs`

Expected: PASS.

### Task 5 (P1): Add complete atomic Alexa migration and rare-race hardening

**Files:**

- Extend: `scripts/lib/runtime-data-restore.mjs`
- Extend: `tests/scripts/runtime-data-restore.test.mjs`

- [ ] Validate publication state, all referenced snapshots, active generated projection, and cache policy as one closed unit.
- [ ] Stage the complete unit, commit it atomically with a journal, and prove injected failures roll back every member.
- [ ] Never copy Alexa state, snapshot, cache, or generated TS independently.
- [ ] Add rare-race handling only in P1; P0 remains limited to resolver, formal manager/launcher, project store, and project restore.

### Task 6: Verification and independent review gate

**Files:**

- Modify: `docs/superpowers/specs/2026-09-01-canonical-runtime-data-root-design.md` only if audit results change the approved contract.

- [ ] **Step 1: Run all new focused tests**

Run: `node --test tests/scripts/runtime-roots.test.mjs tests/scripts/runtime-data-restore.test.mjs tests/scripts/start-agent-stack.test.mjs`

Expected: PASS with no provider, browser, service, or deployment activity.

- [ ] **Step 2: Lint changed source and tests**

Run: `npm exec -- eslint scripts/lib/runtime-roots.mjs scripts/lib/runtime-data-restore.mjs scripts/start-agent-stack.mjs server/config.ts tests/scripts/runtime-roots.test.mjs tests/scripts/runtime-data-restore.test.mjs tests/scripts/start-agent-stack.test.mjs`

Expected: exit code 0.

- [ ] **Step 3: Review the restoration plan only**

Run: `node scripts/plan-runtime-data-restore.mjs --source C:\\runtime-audit\\source-data --destination C:\\runtime-audit\\shared-data --dry-run`

Expected: reports counts derived from the supplied fixture, including the observed 23/7/6/24/17 inventory when run against the audited manifests, without copying, launching, POSTing, or reading secrets.

- [ ] **Step 4: Obtain final independent review, then gate P0 restoration**

After final independent review, require `active = 0`, a verified destination
backup, source/destination hash manifests, and an approved rollback manifest;
then backup plus P0 missing-only project restoration may execute. Do not push,
deploy, call a provider, or issue a real POST. Any controlled restart remains a
separate gated action after restoration verification.

## Review Checklist

- [ ] Formal launch cannot silently use a worktree-local data/runtime root.
- [ ] Development fallback remains explicit and test-covered.
- [ ] State identity records all three roots plus commit and no sensitive values.
- [ ] Project recovery requires `active = 0`, verified backup hashes, exclusive-create, and a guarded rollback manifest.
- [ ] Both different-ID same-scope records are preserved and the duplicate is explicit.
- [ ] P0 excludes SQLite, sync jobs, Web artifacts, locks, Alexa data, and generated TS.
- [ ] P1 migrates the complete Alexa unit atomically with tested rollback.
- [ ] No live or provider operation is included.
