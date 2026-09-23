# 商品形态与关键词规则版收口 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新建形态与关键词任务在本地规则阶段可正确保存、展示和重放，不误触发或等待 Agent。

**Architecture:** 用持久化的 flow identity 区分新规则任务与历史语义任务。形态保存按 flow 选择是否创建解释子任务；两个页面使用 `ruleStatus` 和 `semanticStatus` 分开显示规则与语义状态，保留现有报告组件。

**Tech Stack:** TypeScript、Fastify、PostgreSQL、Next.js/React、Node test runner。

## Global Constraints

- 以 `docs/superpowers/specs/2026-09-24-shape-keyword-rule-completion-design.md` 为设计边界。
- 在 `codex/market-module-independent-input-20260923` 隔离分支工作；不触碰正式 31900/31901 服务。
- 历史语义任务仍可读取；原 UI 卡片、表格、布局和历史入口不重做。
- 缺失值不转零；不推断实际 CPC、毛利、退货率或机会结论。

---

### Task 1: 形态修订按任务版本决定是否创建解释任务

**Files:**
- Modify: `server/services/market-module-service.ts`
- Modify: `tests/agent/market-shape-explanation-public.test.ts`

**Interfaces:** `saveShapeRevision(actor,id,body,key)` 的返回合同不变；规则版返回 `explanation:null` 和未启用原因，历史版仍可返回解释任务。

- [x] **Step 1: 写失败测试。** 规则版任务在 `shapeModelIdentity` 存在时保存、同 key 重放，断言两次均无解释任务，数据库中该父任务的解释子任务数为 0。将原历史解释测试的父任务显式标记为旧语义 flow，继续覆盖创建、重试和取消。
- [x] **Step 2: 验证红灯。** `npx tsx --conditions=react-server --test tests/agent/market-shape-explanation-public.test.ts`；预期规则版会错误创建解释子任务。
- [x] **Step 3: 最小实现。** 从已保存 `view.run.params.flow` 判断 `MARKET_SHAPE_RULES_FLOW_VERSION`；仅非规则版且有模型 identity 时调用 `saveRevisionAndEnsureExplanation`。规则版调用 `PostgresMarketShapePriceRevisionStore.save`，返回明确的未启用说明。
- [x] **Step 4: 验证绿灯。** 重跑同一命令，检查历史语义分支和规则版均通过。

### Task 2: 形态报告与状态正确呈现规则完成

**Files:**
- Modify: `app/market-shape-section.tsx`
- Modify: `app/market-shape-report.tsx`
- Modify: `app/market-shape-saved-conclusion.tsx`
- Modify: `app/market-shape-structure-report.tsx`
- Modify: `app/market-shape-product-table.tsx`
- Test: `tests/agent/market-shape-completion-ui.test.tsx`
- Test: `tests/agent/market-shape-ui-parity.test.tsx`
- Test: `tests/agent/market-shape-ui-parity-browser.test.ts`

**Interfaces:** 新增可选 `semanticSkipped?:boolean` 展示属性，默认 false 保持历史页面。规则版的报告仍显示统计卡片；语义卡片显示“未启用”，不显示假等待。

- [x] **Step 1: 写失败页面测试。** 用规则版运行和已保存修订的 SSR fixture 断言有统计报告、无“模型暂不可用/待生成解释/等待本版本的保存解释”，并保留历史模式的解释提示。
- [x] **Step 2: 验证红灯。** `npx tsx --test tests/agent/market-shape-completion-ui.test.tsx tests/agent/market-shape-ui-parity.test.tsx`。
- [x] **Step 3: 最小实现。** 表单文案只承诺采集与人工确认；任务摘要按 `ruleStatus` 展示采集完成或缺口；规则版不挂载自动读取解释子任务的组件；报告原结构保留，解释位置提示语义未启用。
- [x] **Step 4: 验证绿灯。** 重跑页面测试并检查历史模式。

### Task 3: 关键词页显示 W5 规则完成与 W1–W4 边界

**Files:**
- Modify: `app/market-keyword-section.tsx`
- Modify: `app/market-keyword-report.tsx`
- Modify: `app/market-keyword-demand-summary.tsx`
- Modify: `app/market-keyword-table.tsx`
- Modify: `app/market-keyword-taxonomy-view.tsx`
- Modify: `app/market-keyword-editor.tsx`
- Test: `tests/agent/market-keyword-ui-parity.test.tsx`
- Test: `tests/agent/market-keyword-report-page.test.ts`
- Test: `tests/agent/helpers/market-keyword-report-harness.tsx`

**Interfaces:** `MarketKeywordFactsReport` 增加可选 `semanticSkipped?:boolean`；规则版使用此属性，历史版默认为 false。保留原 W1–W5 区域与来源表。

- [x] **Step 1: 写失败页面测试。** 规则版 fixture 断言 W5 已保存指标可见，W1–W4 显示待人工分类/后续语义扩展，未出现模型运行状态；历史模式语义证据仍可显示。
- [x] **Step 2: 验证红灯。** `npx tsx --test tests/agent/market-keyword-ui-parity.test.tsx tests/agent/market-keyword-report-page.test.ts`。
- [x] **Step 3: 最小实现。** `MarketKeywordSection` 传递 `semanticStatus==='skipped'`，任务卡显示 `ruleStatus`；`MarketKeywordFactsReport` 在规则版将模型证据标为未启用；`MarketKeywordDemandSummary` 的 W1–W4 文案不声称已有模型分类，保留 W5 与未知值。
- [x] **Step 4: 验证绿灯。** 重跑关键词页面测试。

### Task 4: 跨层回归和隔离验收

**Files:**
- Modify: `docs/superpowers/plans/2026-09-24-shape-keyword-rule-completion.md`（打勾并记录结果）

- [x] **Step 1: 运行服务和规则回归。** `npx tsx --conditions=react-server --test tests/agent/market-local-rule-replay.test.ts tests/agent/market-rule-baseline-modules.test.ts tests/agent/market-module-entry-replay.test.ts tests/agent/market-shape-explanation-public.test.ts`。
- [x] **Step 2: 运行 UI 与工程检查。** `npx tsx --test tests/agent/market-shape-completion-ui.test.tsx tests/agent/market-keyword-ui-parity.test.tsx tests/agent/market-shape-ui-parity.test.tsx tests/agent/market-keyword-report-page.test.ts`; `npm run typecheck`; `npm run build`; `git diff --check`。
- [x] **Step 3: 检查独立分支 diff 与报告状态。** 核对无其他窗口文件和正式服务变更；若可用本地页面，截取规则成功与缺失状态供审阅。正式发布留待用户审核。

## 验收记录（2026-09-24）

- 隔离 PostgreSQL 与规则回归 11 项通过；形态规则版在模型配置存在时保存、重放均无解释子任务，历史语义任务仍可创建解释。
- 页面与浏览器回归 19 项通过；桌面和手机规则版截图位于 `test-results/market-shape-rule-ui/` 与 `test-results/market-research-goal/T17/keyword-rule-report-*.png`。截图仅为合成夹具。
- `npm run typecheck`、`npm run build`、`git diff --check` 均通过。构建仅提示已有的大 chunk 警告。
- 本次没有真实供应商采集或正式环境页面验收；正式 31900/31901 服务未发布、未重启。
