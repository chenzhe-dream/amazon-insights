# 市场总览报告只读入口实施计划

> **For agentic workers:** Execute tasks in order with red-green tests and review each result. This plan is implemented in the existing isolated market worktree; no parallel agent is needed.

**Goal:** 查看已有总览报告不触发重复采集，并收紧等待态的视觉层级。

**Architecture:** PostgreSQL 查询只返回匹配范围的历史总览任务编号；浏览器再用现有任务读取接口取报告。新建任务仍只走明确的“开始总览分析”。

**Tech Stack:** TypeScript, Fastify, PostgreSQL, React, Playwright, node:test.

## Global Constraints

- 保留现有 15 列表格、历史报告、状态、来源披露及三个其他子模块。
- 用户查看历史数据不产生采集或模型调用；空态不能伪装成结果。
- 正式服务只使用受管发布门禁；运行任务存在时拒绝重启。

---

### Task 1: 只读任务查找

**Files:** `shared/market-overview-report-contracts.ts`, `shared/agent-contracts.ts`, `server/routes/market-modules.ts`, `server/services/market-module-service.ts`, `app/lib/market-overview-browser.ts`, `tests/agent/market-overview-entry.test.ts`.

- [x] 先写 PostgreSQL 集成测试，证明匹配任务可找回，跨范围/组织不可见，查询不创建任务。
- [x] 运行测试看到失败，再增加合同、路由和服务查询。
- [x] 重跑专项测试、类型检查和代理合同测试。

### Task 2: 查看按钮与状态

**Files:** `app/market-overview-section.tsx`, `app/market-overview-reference.css`, `tests/agent/market-overview-reference-flow.test.ts`.

- [x] 先改浏览器测试，模拟新页面、已保存任务和无任务三种状态；确认旧实现失败。
- [x] 查看入口改为只读查询；无任务显示明确空态，显式分析按钮保留创建流程。
- [x] 把任务工具放到报告区之后，等待状态收紧为可读状态卡，保留失败/重试信息。
- [x] 重跑浏览器、UI 对照、移动端及状态测试。

### Task 3: 验证与发布

**Files:** `docs/superpowers/plans/2026-09-23-market-overview-read-view.md` and acceptance screenshots.

- [x] 运行修改范围的测试、ESLint、类型检查、构建与 `git diff --check`；检查当前三模块状态。
- [x] 在独立分支提交，确保本次修复与并行窗口隔离。
- [ ] 正式目录干净且受管空闲门禁通过后发布。
- [ ] 核验 Web/Agent 版本指纹、正式入口和样式；无法登录的真实页面验收须如实说明。

当前正式服务目录存在并行窗口的未提交修改。正式发布需等其处理完毕，以免把两条开发线一同构建上线。扩展测试中的旧 Agent 流程断言另行跟进，不作为本次总览只读修复的通过条件。

### 三个子模块的正式数据检查（2026-09-23，只读）

- 商品形态与价格带：正式数据库无任务记录，规则流程尚无真实业务样本验收。
- 类目关键词洞察：4 个旧 `market-keyword-flow/v1` 任务，状态均为 `partial`，没有保存的报告；新 `rules-v1` 尚无正式任务。
- 类目买家评论见解：2 个旧 `market-theme-flow/v2` 任务，状态均为 `partial`，已有保存报告；新 `rules-v1` 尚无正式任务。

规则基线计算和三个模块的新任务启动/身份隔离在本地测试通过。旧 Agent 流程测试仍有与规则优先行为不一致的断言，需按现行规格清理，不能用这些旧报告代替新流程验收。
