# Sorftime 原版形态模块恢复实施计划

> For agentic workers: use subagent-driven-development for isolated tasks and task-scoped review; shared pipeline changes stay with the primary worker.

Goal: 用户已确认商品池Sorftime、补SalesAmount及毛利准入，其余按压缩包原版。本文按已批准方向执行。
Architecture: 新rules-v4独立版本；持久化来源→公开瘦身合同→原版纯规则及七区。旧任务合同保持。Tech stack: TypeScript/Zod/PostgreSQL/React。

## Global Constraints
- 原版业务流程不变：来源到位显示，人工修改即时影响草稿；保存不是查看报告的门槛。
- 数字来自可追溯数据库来源；不启用Agent。未知不伪造零，实际来源周期明确。
- 旧任务不换源、不重采。只在market-real-acceptance开发，不混入其他任务及正式生成数据。

### Task 1: 历史金额与原版周期（独立子任务）
Files owned: shared/market-product-history-contracts.ts, server/services/market-product-history-collector.ts, server/services/market-shape-history-reader.ts, tests/agent/market-product-history*.test.ts (existing specific history tests first discover by rg). Do not edit step handlers, flow, main public run schema, UI, or source metadata.
Interfaces: extend collectMarketProductHistory input with optional metric:'SalesVolume'|'SalesAmount' default SalesVolume. Preserve existing volume evidence hashes/replay. Add amount output contract and exported readMarketShapeAmountHistory with the same read input and step kind collect-product-amount-history. Amount points use month/value or month/amount (choose and report), nonnegative decimal finite safe, currency scope bound and checked against any response currency. Immutable input collection product-amount-history metric SalesAmount. Primary worker handles step enum/worker persistence and assigns run.source.productAmountHistory to returned contract.
Existing readMarketShapeHistory retains v1-v3 semantics. New exported referenceProductHistoryPeriods(points, referenceMonth) mirrors original sorted.slice(-3/-6), years referenceYear-1/-2 for UI with actual months, preserving null/invalid, not treating unavailable as real zero. Main worker selects v4 only. Extend max product lists to300; no legacy behavior changed for existing100.
- [x] Write failing tests for decimal amounts, real zero, missing, conflicts, scope/currency mismatch; legacy volume output equality and no-network reader behavior where feasible.
- [x] Implement normalization/collection/read replay and reference periods.
- [x] Run covering tests and report exact commands/results; do not commit unrelated files. Report under test-results/shape-history-amount-report.md.

### Task 2: Sorftime product pool and pipeline (primary)
Files: new server/services/market-shape-sorftime-pool.ts, shared source public contract; shape-price-flow.ts, market-source-step-handlers.ts, source projection and read/revision services, step enums/migration.
- [x] Fail tests for report mapping, duplicate/filter/300 bounds, non-monthly period metadata and failed-source behavior.
- [x] Add rules-v4 and freeze original-provider products; collect histories independently; preserve legacy replay and no-model boundary.
- [x] Persist and read source snapshots, expose images/gross margin/period identity without loss; isolated DB create/read/retry/save tests.

### Task 3: Original rules and seven sections
Files: app/market-shape-section.tsx and product/report components; narrowly copy/adapt reference pure functions/components under isolated namespace as needed.
- [x] Restore10-unitbands, reference cycles, margin entry and synthesis via reference source.
- [x] Remove save gate for live drafts, keep explicit DB version save/restore; no network reads within charts/rules.
- [x] Original filters/sort, charts/hover, capacity controls; same-input rule comparisons and browser interactions.

### Task 4: Integrated acceptance
- [x] Typecheck, required isolated DB tests, browser screenshots desktop/mobile, build, strictspec.
- [x] Independent task/whole-change review, resolve blockers; verify formal concurrent work before release.
- [x] Real Sorftime category input and persisted source values; refresh no recapture, fault recovery,300capacity limitations explicit. Only then update OpenSpec checkboxes and release record.

执行记录：已发布012e9eca，正式10商品38步骤完成；版本保存/刷新无重采，配置模型情况下的本地规则分发问题已复现并修复。300商品完整容量测试使用模拟上游；业务终验尚待用户，因此OpenSpec4.1继续保留未完成。详细证据见同目录2026-09-24-shape-sorftime-delivery-review.md及OpenSpec verification.md。
