# 模块三原版业务恢复实施计划

> 执行：按 executing-plans 逐项测试、实现与验收。用户已在本轮同意前一轮给出的原版样本、估算评分与业务输出方案，不再重复请求同一授权。

**Goal:** 恢复压缩包关键词需求分析的有效样本、S1–S5/PVS、归并和验证建议。

**Architecture:** 将原版纯计算作为有版本的独立业务投影接入服务端；基于已验证保存事实计算，不改原始来源或严格证据报告。主界面使用原版业务投影，并明确估算值；旧严格报告、人工版本保留核对入口。人工分类参与投影，不被自动规则覆盖。

**Tech Stack:** TypeScript、Zod、React、node:test、Playwright、现有服务契约。

## 约束及已核对设计

- 沿用原版权重、缺失增长回退、竞价中位数回退、小簇归并及优先级行为，估算不冒充真实输入；不新增真实评分输入前置条件。
- 原版规模来源是扩展词页面月搜索量，窗口未注明；与参考月趋势值分开标识。原版归并后未重算评分，明确显示原版评分基于归并前簇，不能把两者当同一口径。
- 保留现有卡片、明细、保存恢复；不修改事实、旧规则哈希或人工快照，不发起付费采集，不发布。
- 使用既有独立候选 worktree；正式 worktree 不变。

## 任务

- [x] 1. 建立原版对照测试：同输入逐项比较原版计算；覆盖缺量/缺趋势/缺竞价、小簇归并、零值与空池、人工分类。
  - 新增 tests/agent/market-keyword-original-estimate.test.ts，先确认失败。
- [x] 2. 移植原版纯计算并增加强类型估算契约及保存事实适配；服务读/保存/历史读取返回有版本、factsId 绑定的业务投影。
  - 新增 shared/market-keyword-original-estimate-contracts.ts、server/domain/market-research/keyword-original-demand.ts、keyword-original-estimate.ts；修改 public/revision contracts 与 market-module-service。
- [x] 3. 恢复业务报告主展示并保留旧依据入口；估算原因、有效样本、规模来源和归并口径可见。
  - 新增 app/market-keyword-original-estimate-report.tsx；修改 market-keyword-report/section，原卡片样式复用。
- [x] 4. 服务/契约回归、真实保存来源回放、桌面浏览器截图与交互检查，类型检查及构建；记录未验证范围和既有失败。
  - 禁止仅凭构建宣称页面完成。无需线上重采，测试数据与正式数据库隔离。

最终保留分支和测试产物供审核，发布状态单独说明。
