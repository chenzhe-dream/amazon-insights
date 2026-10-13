# 总览旧报告读取兼容修复（2026-10-13）

## 复现与触发条件

- 用户确认的 URL 指向 `overviewRun=fa3b0692-81ac-4771-ba53-4f43ce24de43`，美国站，类目 `228013:495224:3736561:1063294`，2026-06 至 2026-08。
- 该任务于 2026-10-06 创建，数据库状态 succeeded，任务编号和类目范围有效。旧版来源与报告仍在数据库中。
- 2026-10-08 的 `e8390f9a` 在分布归一化结果中增加 `productItems`（商品明细），未变更对应 catalog 版本。
- 当前读取流程使用冻结来源重新构造数字快照。新构造结果比旧快照多出 `records[].data.distributions[].distribution.rows[].productItems`，数字快照哈希不同，触发 `Overview source receipt or execution binding differs`。
- 路由原来将该内部校验错误当作参数校验错误，返回 400 和“市场研究参数或任务编号无效”。页面因此无法确认历史报告范围，仍显示手动选择的基础概览。这不是类目编号填写错误，也不是本次读取遇到供应商额度不足。
- 触发点是恢复/打开该旧报告，包括带 overviewRun 的链接刷新；输入同一类目不必然触发，新的报告可正常读取。

## 修改

1. 数字快照先按当前结构进行严格匹配。只对已知 v4–v7 版本提供一次旧格式重建：仅移除分布行新增的 `productItems`，重新计算完整快照哈希。
2. 只有重建哈希精确等于旧回执的数字快照 ID 才继续；随后仍核对数据库中冻结快照、来源、参数、月份、语义快照及完整输出。没有任意忽略哈希、覆盖旧数据或重新采集。
3. 来源兼容错误使用专用错误类型，公开接口返回 409 和历史报告校验提示；错误任务编号仍返回 400。后台 worker 仍归类为不可自动重试的 invalid-data。
4. 浏览器测试的历史样例继续不带 sampleSize；模拟新建任务的响应补回请求中的 sampleSize，匹配现行接口契约。此前该用例在最后新建环节超时，修正样例后通过，未为此修改生产采样逻辑。

## 验证记录

- 新增旧快照回归在修复前复现相同校验异常，修复后通过；同时覆盖来源被改、销量被改、冻结快照不存在时继续拒绝。
- 使用候选代码对正式数据库执行 SELECT 及读锁事务，未调用采集、模型、重试接口：目标任务读取成功，返回 5 份保存报告且当前详情可读取。
- 同批只读核对 `c96e3112-a137-4ddd-9ff5-6847016c119d` 和 `7fc3e63b-023c-43cd-936f-9235eea9e27b`，各 2 份保存报告及详情可读取。
- 上述回放前后任务数 75、尝试数 9634，均不变。此处未以全库调用量作为零外呼证明；使用的读取路径没有供应商执行入口。
- 最终 6 文件串行回归 26/26 通过、退出码 0，覆盖 worker、完整报告、分布历史兼容、接口错误区分、来源重试/冻结校验、浏览器只读恢复；`npm run typecheck` 退出码 0，`git diff --check` 通过。
- 测试命令：`node --import tsx --test --test-concurrency=1 tests/agent/market-overview-evidence-error.test.ts tests/agent/market-module-step-worker.test.ts tests/agent/market-overview-distribution-flow.test.ts tests/agent/market-overview-flow.test.ts tests/agent/market-overview-complete-flow.test.ts tests/agent/market-overview-reference-flow.test.ts`。

## 交付边界

基于候选 `codex/market-shape-restore-flow-20261012` 的 `492a392e` 修复。正式 `31900/31901` 服务本轮尚未更新，实际登录页面尚未验收；候选读取成功不等于正式服务已生效。没有修改数据库记录，没有归档 OpenSpec，也没有将四模块整体验收 10.11 标记完成。

更新后应使用用户原链接刷新并核对报告、图表明细与历史版本，确认不再出现参数错误且不会新建采集任务。
