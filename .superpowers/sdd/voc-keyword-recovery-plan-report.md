# VOC / Keyword Runtime Recovery Planning Report

Date: 2026-08-31 (Asia/Shanghai)

## Result

Created the self-contained eight-batch recovery plan:

- `docs/superpowers/plans/2026-08-31-voc-keyword-runtime-recovery.md`

Revised the two source plans needed by that execution:

- `docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md`
- `docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md`

No production code, test code, migrations, generated data, publication state, project JSON or pre-existing WIP was modified by this planning task.

## Verified Planning Baseline

- Worktree: `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline`
- Code baseline: `a5d233bdfe977fb33d814b79a89352d567d3d6c5`
- Initial planning commit: `3319b4d688e8e8aabcea0f55e054a8a08fb3599d`; reviewed plan anchor: `08a82f90a4652e44bac4165cb791872f4f2e556e`. The legal implementation planning baseline is exact `08a82f90` or its single direct child containing only this final four-document TDD revision; when that child exists, execution first fast-forwards to it.
- Existing migration head: SQLite/PostgreSQL `0019_manual_alexa_voc` + `0020_voc_snapshot_per_asin_provenance`
- `0021_comparison_project_scope`: absent
- `0022_keyword_evidence`: absent
- Plan 02 implementation state: 0/8 tasks
- Plan 03 implementation state: 0/12 tasks
- Full TypeScript command: `npx tsc --noEmit --incremental false --pretty false`
- Full TypeScript result: exit 2, exactly 306 raw diagnostic lines; duplicate semantic diagnostics are retained as separate occurrences
- Existing worktree WIP observed during planning: 17 tracked modified and 19 untracked entries; none was staged, reset, deleted or attributed to this task

Top TypeScript baseline categories captured for truthful final comparison:

| Code | Count |
| --- | ---: |
| TS2322 | 110 |
| TS2339 | 34 |
| TS2353 | 32 |
| TS2345 | 30 |
| TS2769 | 15 |
| TS7006 | 13 |
| TS7053 | 12 |
| TS2741 | 11 |
| TS1117 | 9 |
| TS2554 | 8 |

## Inputs Read Completely

- `.superpowers/sdd/voc-keyword-runtime-diagnosis.md`
- `.superpowers/sdd/sif-keyword-flow-diagnosis.md`
- `.superpowers/sdd/keyword-plan-preflight.md`
- `docs/superpowers/specs/2026-08-31-realtime-voc-asin-draft-keyword-fallback-design.md`
- `docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md`
- `docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md`

## Eight Reviewable Batches

1. Repair Manual VOC product-source arity/composition, ordinary Node `server-only` import boundary and migration-head assertion; verify VOC × keyword page model.
2. Implement Plan 02 reducer, migration `0021`, repositories, principal routes and favorite/legacy owner gate.
3. Complete Plan 02 page cutover, revision fencing, hydrate/library semantics, default-off UI rollback flag and acceptance.
4. Implement Plan 03 strict contracts/capability registry, migration `0022` and parity repositories.
5. Implement physical request receipts, verified worker scope, canonical/compatible retry and verified parent/category fallback.
6. Publish only immutable evidence ids and expose authenticated exact-set run-scoped evidence GET.
7. Remove every client-reachable static keyword consumer; merge current Manual VOC overlay with current keyword evidence for UI/export/product definition.
8. Add independent flags, observability, combined Manual+Keyword stable-build/bundle gates, rollback matrix and truthful full baseline classification.

## Revisions Applied to Existing Plans

### Plan 02

- Replaced stale spec/preflight baseline wording with exact HEAD `a5d233bd...` and a hard dependency on Batch 0 acceptance.
- Declared preservation of Batch 0's Manual VOC + keyword product source through all `app/page.tsx` changes.
- Added the missing default-off `COMPARISON_DRAFT_UI_ENABLED` owner, strict same-origin config route and UI-only rollback test.
- Replaced unreachable per-task full-tree TypeScript success claims with normalized changed-path baseline comparison plus affected tests.
- Kept migration ownership fixed at `0021` and Plan 03 start blocked on Task 8 acceptance.
- Made well-typed `PATCH` bodies containing `asins` or `marketplace` pass strict schema parsing and fail at the business immutability boundary with `409 IMMUTABLE_SCOPE` before any write; malformed scope fields and unknown keys remain 400.

### Plan 03

- Replaced stale baselines with exact HEAD and made Plan 02 `0021` acceptance a concrete hard dependency.
- Added omitted static consumers: `app/keyword-demand-conclusions.ts` and `app/lib/stage-output-view.ts`.
- Added indirect launch/VOC positioning/product definition/checklist consumers and required one explicit Manual VOC + keyword evidence product source.
- Added Manual overlay/session-org epoch regressions to the client cutover gate.
- Required keyword build scanning to extend the existing stable-build lock/fingerprint/cleanup transaction and run alongside, not instead of, the Manual bundle gate.
- Replaced per-task full-tree TypeScript success claims with changed-path baseline comparison; final release runs full compiler/lint, classifies the known 306 diagnostics and requires zero introduced diagnostics.
- Preserved the empty production capability manifest and separate human-reviewed provider-contract commit gate.

### Needs-Revision Closure

- Frozen the Batch 0 ancestry rule around reviewed plan commit `08a82f90` and its optional exact four-document direct successor, rather than the code baseline, so a valid final planning HEAD is accepted.
- Made all 23 commit units follow an explicit test-only RED, independent contract-failure capture, GREEN rerun, occurrence-preserving changed-path TypeScript comparison, occurrence-preserving changed-path ESLint comparison and scoped `git diff --check`. B2.1/B2.2/B2.3, B6.1 and the B7 release gate explicitly include `app/page.tsx`.
- Fixed migration-head assertions to the only legal sequence: Batch 0 = 20; after `0021` = 21; after `0022` and in every subsequent batch = 22.
- The TypeScript classifier compares a sorted stable multiset of normalized raw diagnostics with an occurrence index. It never uses `Sort-Object -Unique`, so two identical diagnostics remain two entries and any extra identical occurrence is introduced debt.
- Current measured compiler baseline remains exit 2 with 306 raw diagnostic lines. No implementation/final counts exist during planning; Batch 7 must report actual current raw, retained, resolved and introduced counts without converting a nonzero exit into success.
- Tightened every RED boundary: a missing module/export/import, loader error or file-existence assertion is never valid evidence. Plan 02 Task 1 now fails on the existing `parseBatchAsinInput` truncation behavior; B3.1 fails because existing `buildSifKeywordAnalysis` compresses schema drift to `empty`; B7.1 fails through existing config/worker/publication/stable-build behavior. GREEN alone creates private modules and wires them behind those same public entries.

## Self-Review

- Migration numbering and asserted heads are consistent: `0019`/`0020` (head 20) → `0021` (head 21) → `0022` (head 22, retained through B7).
- Plan 03 dependencies point only backward to completed Batch 2/Plan 02 contracts.
- Product source type is stable across Batch 0 and Batch 6: `ProductLaunchRuntimeSources` always contains current `manualVocByAsin` plus a prebuilt `KeywordDemandAnalysis | null`.
- Shared category lookup remains target-less; every target has its own immutable evidence id.
- Stage/API/browser/export/product-definition use evidence ids, never category lookup ids, as target coverage.
- Receipt hard cap, waiter-zero-request, sent-no-refund, tenant 404, fail-closed capability/schema and Sorftime separation contracts remain present.
- Placeholder scans and `git diff --check` are required before document commit.

## Concerns / Rollout Blockers

1. Production SIF capability proof is intentionally absent. `server/connectors/provider-contracts/sif/manifest.json` must remain empty until a separate human review accepts an official or sanitized saved descriptor and checksum. Strict production keyword calls must return `capability-unknown` with zero HTTP before that approval.
2. Full-tree TypeScript is currently red with 306 raw diagnostic lines, and the existing ledger also records substantial lint debt. The recovery work may claim focused/affected gates only; final reports must preserve duplicate occurrences and the actual nonzero full exits unless baseline remediation genuinely clears them.
3. The worktree contains user-owned generated/live WIP. Execution must use exact path staging and compare the cached file list before every commit.

## Commit Scope

The planning commit must contain only these four Markdown documents:

- `docs/superpowers/plans/2026-08-31-voc-keyword-runtime-recovery.md`
- `docs/superpowers/plans/2026-08-31-comparison-draft-asin-management.md`
- `docs/superpowers/plans/2026-08-31-sif-keyword-evidence-fallback.md`
- `.superpowers/sdd/voc-keyword-recovery-plan-report.md`
