# 类型错误修复验收

2026-09-14。本轮范围是修复已列出的全仓类型错误，并验证原 ASIN、市场调研和钉钉使用统计接入。继续使用 `integrate-xydc-variant-20260905` 集成工作树及原 PostgreSQL 数据库。

## 结果

`npm run typecheck` 已通过：439 条诊断降至 0，退出码 0。保持原严格检查配置，没有关闭类型检查或排除业务目录。439 条诊断涉及 94 个文件，并不代表 439 个运行故障；其中 276 条来自测试和夹具。

## 修复内容

- 竞品目录：清除 38 处重复 `productFamily`，保留原 JavaScript 实际采用的末次值，清理前后解析结果逐项相同。修复生成器仅搜索前 500 字符造成重复字段的问题；增加长标题及重复运行测试。
- FBA、Listing、类目生成数据：类型声明与已有真实字段一致，并同步修改生成脚本，避免下次采集重新引入报错。没有补造销量、评论或费用数据。
- 页面、VOC、SIF、接口：补齐空值与联合类型判断，修正状态协议、函数参数和只读返回值声明。可选评分/评论统一返回 `null`，避免把缺失值当成有效数值。
- 运行适配：补齐 Worker 平台类型及 JavaScript 可选参数声明；SQLite 直接仓库明确提供原有“不支持同步队列”的能力对象，保持运行入口现有行为。
- 测试夹具：同步当前返回协议、快照清单、权限与用量归属信息。模型预算超时测试先等待 Worker 初始化完成，再开始结果期限，保留 Worker 自身 25 毫秒超时断言。
- 实际恢复问题：重试接管后，模型用量与预算授权仍按最初任务 ID 查询，可能漏掉之前消耗。改为按当前有效任务授权、按同一 AgentRun 汇总历史请求；保留初始任务 ID 的审计来源和组织、阶段、逻辑执行周期约束。新增 PostgreSQL/SQLite 迁移 0048 更新插入约束，旧领取凭据仍被拒绝。

此前统计依赖注入位置错误已独立修复，本轮保留真实 `buildAgentApp` 与 PostgreSQL 的集成回归。人员页面使用时长与模型 Token 用量是两类不同的数据。

## 验证记录

日志均位于 `.superpowers/sdd/`。测试使用隔离数据库、合成数据或本地模拟接口，不向正式数据库填充测试统计，也不调用付费采集/模型服务。

| 检查 | 结果与证据 |
|---|---|
| 全仓类型检查 | 0 错误，`typefix-final.log` |
| 竞品目录生成器 | 1 通过，`typefix-catalog-green.log`；已验证修复前失败、修复后通过 |
| 市场调研定向回归 | 40 通过，`typefix-market-regression.log` |
| 类目续跑、VOC 夹具、市场形态解释 | 9 通过，`typefix-last-fixtures.log` |
| 流量脚本 / 页面回归 | 37 / 62 项；首次页面 60 通过、2 条布局失败。源码编辑结束后原两条单独重跑通过，`typefix-traffic-layout-retry.log`。不将首次失败描述为首次全绿 |
| 恢复用量与归属隔离 | 4 通过，`typefix-recovery-green.log`；PG/SQLite 当前任务可读取先前用量，错误组织/运行/旧任务不可读 |
| 并发 Governor 与 PostgreSQL | 34 通过，`typefix-backend-governor-tests.log` |
| Worker 退出清理、上游降级、阶段输出持久化 | 串行复核 31 通过，`typefix-worker-retry-final.log`；此前并行运行的 Windows 进程身份探测超时未改写生产锁策略 |
| 预算与统计定向测试 | 首次 43 项中 42 通过，1 条 Worker 启动时间挤占结果期限；修复测试等待逻辑后完整 SQLite 预算文件 16 项通过，`typefix-budget-barrier-final.log` |
| 钉钉统计真实浏览器到 PostgreSQL | PASS，`typefix-usage-smoke-final.log`；搜索/高亮/清空、日历/历史/明细、隐藏补报/重复去除、390px 布局 |

统计合成负载检查：100 个测试用户、4,000 个事件、并发 10，失败 0，批次请求 p95 为 59ms。这是本机隔离测试观测，不是生产容量承诺。

本轮没有运行全部仓库测试，以上为与变更有关的检查；不等同于外部数据源实时可用或所有 ASIN 都有上游结果。

## 本地更新

迁移前备份：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/typefix-before-20260914.dump`，5,805,557 字节，`pg_restore --list` 验证通过。沿用原 `amazon-insights-postgres-cutover` / 58258 / `amazon_insights`。

构建与本地启用已通过原 `scripts/manage-formal-stack.ps1 -PublishCode` 完成，保留活动任务及进程归属检查，日志 `typefix-local-update.log`。Web 31900、Agent 31901 健康；主页与管理页面均返回 HTTP 200。

Web、Agent 与当前工作树源码指纹一致：`cdb51e138cdc4f208a5a94fa636d1059df51b3cd2ed6ecda00e7120a26e18e93`。基础提交仍是 `ce694fde1b15662c9230cc7efc15eca75f20f615`，本轮修改未提交，不能仅靠该提交号还原此次运行代码。

测试入口：http://192.168.1.109:31900/ ，使用统计：http://192.168.1.109:31900/admin/users?view=usage 。使用现有钉钉登录及管理权限。
