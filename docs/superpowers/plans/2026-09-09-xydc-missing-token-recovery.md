# Xiyou Missing Token Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox syntax for tracking.

**Goal:** Restore configured Xiyou collection without erasing valid variant evidence on missing credentials.

**Architecture:** Keep the current cache and runtime interfaces. Repair the missing-token branch and explicitly configure the private formal environment; use verified local historical data for the three affected families.

**Tech Stack:** TypeScript, Node test runner, PowerShell, existing PostgreSQL and managed Web/Agent publication.

## Global Constraints

- No new charts, demo mode, cache architecture, auth/role changes, main-branch merge or GitHub push.
- Secrets remain in the external private runtime configuration and never appear in reports, diffs or logs.
- Preserve unrelated dirty files and concurrent OpenSpec work; root is the only formal release owner.
- No live full analysis of the new three ASINs; the user initiates that acceptance test.
- Keep cache identity, timestamps, cancellation and provider coordination contracts intact.
- Never bypass active-job, ownership or release health guards.

## Operational preparation (root, before Task 1)

- [ ] Confirm formal config lacks XYDC_MCP_TOKEN, while the local User variable is nonempty; output booleans only.
- [ ] Back up the exact external file; append only the missing token using apply_patch with the value kept inside the shell process. Re-read and verify the token matches User and every existing key is unchanged.
- [ ] Do not restart until code and recovery checks are ready.

### Task 1: Preserve existing variant evidence when credentials are missing

**Files:**
- Modify: `scripts/build-xydc-variant-data.ts`
- Modify: `tests/scripts/xydc-variant-sync.test.ts`
- Modify: `scripts/formal-stack.env.example`
- Report: `.superpowers/sdd/xydc-missing-token-task-1-report.md`

**Interfaces:** Keep `syncXydcVariantFamilies(input: SyncXydcVariantInput)` and cache `readMany/write` signatures unchanged. Existing schema is `XydcVariantFamilySchema`; cache display consumes exact parent/child identity.

- [ ] Write failing tests using the existing `cacheFixture` and real family projection. For ready and partial matching nonfuture evidence with children, test blank/whitespace token with force both false/true; assert original family data and timestamps retained, returned `cacheState === 'stale'`, no writes to those cache entries, and zero tool calls. Add a mixed hit/miss test, and invalid country/input/future/no-relationship candidates that must not be reused. Add an actual temporary-file cache + order-display regression where preserving family identity keeps the original annual order readable and the file bytes unchanged.

Example assertion shape, adapted to the existing real fixture:

```ts
const before = structuredClone(prior);
const result = await syncXydcVariantFamilies({ asins: [prior.inputAsin], country: 'US', token: '', now, cache, callTool: async () => { throw new Error('unexpected provider call'); } });
assert.deepEqual(result[0], { ...before, cacheState: 'stale' });
assert.deepEqual(stored[prior.inputAsin], before);
```

- [ ] Run `node --import tsx --test --test-name-pattern="missing.*token|without.*token|credential" tests/scripts/xydc-variant-sync.test.ts`; record actual expected RED before changing production code.
- [ ] Replace only the missing-token branch with per-input selection. Safe-parse cached evidence; accept exact normalized country/input ASIN, status ready/partial, nonempty children, and finite fetchedAt <= now. Return a stale copy for eligible evidence without writing it. Otherwise keep current unavailableFamily/NOT_CONFIGURED persistence. Merge results with existing mergeFamilies. Preserve all nonempty-token behavior.
- [ ] Add blank `XYDC_MCP_TOKEN=` and an absolute shared `XYDC_COORDINATION_ROOT=` example plus a short note that formal services read this external config, not newly edited User variables. No real values.
- [ ] Run full `tests/scripts/xydc-variant-sync.test.ts`, `tests/scripts/xydc-order-display.test.ts`, `tests/scripts/xydc-order-sync.test.ts`; run changed-file ESLint and `git diff --check`.
- [ ] Self-review and commit only the three owned files and the scoped report; include RED/GREEN evidence and exact counts. Root-owned spec/plan/ledger and unrelated WIP stay untouched.

## Final integration and recovery (root)

- [ ] Independent task review, then whole-change review against 675fbfd; fix confirmed Important/Critical findings before activation.
- [ ] Locate authoritative historical family copies, validate schema/country/input/parent/full child set against surviving order caches, and record source hashes. Do not reconstruct unknown fields.
- [ ] Build and run scoped integration tests in source, preserve formal dirty-file hashes, and fast-forward only the formal branch to the reviewed commit.
- [ ] Check actual idle state, back up three current broken family files, restore verified copies using apply_patch and retain original fetchedAt while marking stale when appropriate.
- [ ] Execute `scripts/manage-formal-stack.ps1 -ProjectRoot <formal-root> -PublishCode` with NO_PROXY covering loopback and LAN. Poll health and release state, never force past active work.
- [ ] Verify current served artifact/source fingerprints, old three family-child counts and original 12-month order selection, no order-cache byte changes, no new-ASIN jobs. If authentication/browser tooling blocks real UI acceptance, state that boundary and provide user refresh instructions.
- [ ] Record safe verification evidence, hand off to the parallel OpenSpec window, and give the user the test entry and ASINs.
