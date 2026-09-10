# Module Organization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Complete the approved first batch of code organization by extracting navigation and shared rating presentation from the main page, after publishing the completed VOC fix.

**Architecture:** The page owns state and orchestration. The shell module owns navigation definitions, grouping and visual navigation pieces; shared components own reusable rating presentation. Dependency direction remains page → feature/component → types, never feature → page.

**Tech Stack:** React 19, TypeScript, Vinext/Vite, Node test runner and Playwright.

## Global Constraints

- Work only in the existing bd63 isolated worktree; preserve test-results and all formal runtime data.
- Keep visible labels, tab IDs, grouping, icons, link construction, keyboard/mouse behavior, CSS and rating null/zero formatting unchanged.
- No framework changes, generated-data moves, database/API changes, sync/VOC state changes, GitHub push or second publication.
- Baseline is published 5ba042f, with VOC evidence fix included. The old design note saying VOC is still being implemented is superseded by the actual publication record.
- No empty feature folders. Only create modules with actual code. No broad export barrels or compatibility wrappers without a consumer need.
- Baseline primary-admin browser runtime-refresh case fails identically in 1551ed0 and 5ba042f (2 reads versus 1); do not remove or weaken that assertion. Report independently from new regressions.

### Task 1: Extract navigation and shared rating presentation

**Files:**
- Modify `app/page.tsx` to import module definitions/components, retaining state/effects/URL mutations.
- Create `app/features/shell/navigation.ts` for NavGroupId/NavLeaf/NavGroup/NavEntry, static navigation entries, group predicates and tab-group lookup.
- Create `app/features/shell/navigation-presentation.tsx` for NavSubText/NavThemeIcon and icon theme definitions.
- Create `app/components/amazon-star-rating.tsx` for AmazonStarRating and RatingCell.
- Add focused behavior coverage in `tests/agent/shell-navigation.test.ts` and `tests/agent/amazon-star-rating.test.tsx` where existing coverage is missing.
- Adjust existing tests only if a source-location assertion must follow the moved definition; retain its behavior expectation.

**Interfaces:** Page consumes explicit exports equivalent to current helper signatures; `navigationEntries` is static and not mutated. RatingCell consumes `{rating:number; reviews:number|null}`, AmazonStarRating consumes `{rating:number; compact?:boolean}`. Modules have no runtime/provider/file side effects.

- [ ] Record relevant app-tabs and rendering checks before extraction; use existing source and behavior to establish expected output.
- [ ] Extract definitions and JSX verbatim, update imports and remove the obsolete per-page memo for static entries. Keep all stateful sidebar handlers and report/data plumbing in the page.
- [ ] Cover tab grouping including standalone tabs, navigation uniqueness/validity, and rating clamp/compact/null-versus-zero review behavior. Do not add tests that merely assert file existence or copied implementation text.
- [ ] Run focused tests, targeted ESLint for new files, full build and related page/VOC browser regressions; classify known failures against baseline.
- [ ] Self-review diff and commit the scoped refactor locally. Record source line reduction and changed file responsibilities.

### Task 2: Document module ownership and finish verification

**Files:** `app/README.md`, the design note, and `docs/verification/2026-09-10-module-organization.md`.

- [ ] Document actual shell/shared modules and current feature entry points for projects/sync/VOC/keywords/listing/reports, including generated-data location and server boundary. Mark future moves explicitly as future work.
- [ ] Update the design status and baseline with the completed VOC release and implemented first batch.
- [ ] Independent review checks exact preserved behavior and import boundaries. Resolve substantive findings before completion.
- [ ] Record fresh validation and commit documentation; verify working tree has only preserved untracked test artifacts. Formal service must still report 5ba042f. No automatic second deployment.
