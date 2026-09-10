# Projects and Sync Module Organization Plan

> **For agentic workers:** Use superpowers:subagent-driven-development for bounded implementation and independent review.

**Goal:** Continue the user-approved incremental organization with real projects/sync directories, preserving existing behavior.

**Architecture:** Move existing frontend feature files into their owning feature directories; rewrite relative references to the same resolved targets. Extract historical project/run/job lookup from page into a project client helper. Keep main state and server/Provider/cache behavior intact.

**Baseline:** `8edb259`. Formal remains `5ba042f`; no deployment or GitHub push. Preserve all existing untracked test artifacts. This is continuation of the agreed approach, not a new feature.

## Tasks

- [x] Baseline relevant project/favorite/batch-input/gap tests and record known failures separately.
- [x] Move `project-library-panel.tsx`, `use-analysis-project-favorites.ts`, `analysis-project-favorite-button.tsx`, `workspace-history-strip.tsx` into `app/features/projects/`.
- [x] Move `batch-asin-input.tsx`, `asin-sync-funnel.tsx`, `stage-output-gap-card.tsx`, `stage-output-gap-notice.tsx` into `app/features/sync/`.
- [x] Update import/export references and executable test source-file paths; preserve historical documentation and public fixture URLs. Update moved files' own imports using their original resolved targets. No wrappers or broad barrel exports.
- [x] Extract `HistoricalSyncPointer` and `readHistoricalSyncPointer` into `app/features/projects/historical-sync-pointer.ts`; page imports it. Preserve all project/run/job identity, ASIN/market scope checks and null/error behavior. Targeted tests cover success and malformed/cross-scope/error responses using mocked network only.
- [x] Validate moves by comparing source after import-path normalization; check all tracked callers for stale paths. Run focused behavior tests, relevant project/sync browser tests, build and type/lint baseline comparisons. No weakening old assertions.
- [x] Update `app/README.md` and verification record to reflect actual paths and remaining work. Independent review, local commits, final formal-version check.

## Boundaries and acceptance

- Existing generated data files, CSS, route paths, tests' browser harness URLs, state effects, API payloads and server-side source remain semantically unchanged.
- Business root files physically move rather than leaving duplicate implementations. Browser clients shared across other features may remain under app/lib for now.
- No feature module imports page.tsx. The project helper may depend on sync shared job type and existing app/lib scope predicate; it does not start or mutate a job.
- New tests verify behavior only; existing source-location assertions may follow the moved file while retaining their original assertions.
- Baseline primary-admin terminal runtime refresh 2-vs-1 failure remains documented. Full repository tsc/lint debt is not silently converted into success.
