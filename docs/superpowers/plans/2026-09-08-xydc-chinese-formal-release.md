# XYDC Chinese display and formal release implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan. Steps use checkbox syntax for tracking.

**Goal:** Chinese variation labels in the existing module, followed by guarded local formal publication at the unchanged 31900 URL.
**Architecture:** A small pure display helper feeds the existing orderAttributeLabel seam. No source-data mutation, new route, Provider call or order calculation change.
**Tech Stack:** TypeScript, React, node:test/tsx, existing PowerShell formal manager.

## Global constraints

Use only C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907 for development. Preserve test-results and unrelated work. Brand, ASIN and full product titles stay original. Known colors/specs translate for display only, unknown values fall back unchanged. Preserve ASIN identity and existing 12-month calculation. No new monthly interactions or pie. Formal deployment is coordinator-only after review. No main/GitHub, live Provider calls, business-data writes or forced task restart.

### Task 1: Chinese variation display (sole implementation owner)

Read design docs/superpowers/specs/2026-09-08-xydc-chinese-formal-release-design.md and all global constraints above.

Files:
- Create app/xydc-variant-label.ts as a pure bounded display translator.
- Modify app/xydc-order-card.tsx only at the shared orderAttributeLabel seam (and import).
- Create tests/agent/xydc-variant-label.test.ts; update existing xydc UI assertions only where their expected displayed English becomes Chinese.
- If another source file is actually necessary, ask coordinator before expanding scope.

- [ ] Inspect current attribute shape and known values in test-results/xydc-current-asins-20260908/preview-props.json read-only. Translate common Color/Shape/size display values without changing raw title/identity.
- [ ] RED: add meaningful tests against existing orderAttributeLabel for Sand Black, compound 22/26 inch colors, remote/RGB/dimmable/shade/Arc variants. Include case/whitespace, unknown values, no mutation and distinct ASIN identity expectations. Run focused test and record expected failures before implementation.
- [ ] GREEN: add minimal bounded dictionary/parser. Never broad substring translation of arbitrary unknown strings, never network/AI dependency. Preserve numbers and meaningful separators. All components reuse existing seam.
- [ ] Run focused tests plus the existing 4-file UI matrix once: node --import tsx --test tests/agent/xydc-variant-label.test.ts tests/agent/xydc-order-section.test.tsx tests/agent/xydc-variant-section.test.tsx tests/agent/xydc-order-progress-ui.test.tsx tests/agent/xydc-order-poll-owner.test.ts
- [ ] Lint only changed source/test files, git diff --check; self-review; commit only owned source/tests.
- [ ] Write .superpowers/sdd/xydc-chinese-task-1-report.md with RED/GREEN outputs and exact verification. Do not claim formal release complete.

### Task 2: Coordinator verification and guarded local publication

- [ ] Independently review Task 1 exact diff/report, fix blocking findings if any; perform final scoped release review carrying previously approved V2 evidence (219 tests), not reimplementing V2.
- [ ] Verify localized real-cache preview, source build and relevant regressions. Confirm no new TS/lint debt against known existing baselines.
- [ ] Resolve OpenSpec parallel release ownership; verify target ancestry, generated-data hashes, current health/active work/ownership, exact roots, config needs, actual annual cache coverage and backup/rollback reference.
- [ ] Integrate only reviewed source into the authorized formal worktree without overwriting dirty generated files, then invoke unmodified guarded -PublishCode. If a safety gate blocks, stop publication and report the concrete reason.
- [ ] Verify actual 31900 health/source/artifact and original-module Chinese presentation (or explicit auth/data limitation), unchanged business data and existing generated files. Record evidence and no-main/no-push boundary. Preserve both worktrees.
