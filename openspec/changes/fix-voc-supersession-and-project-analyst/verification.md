# 验证与发布记录（2026-09-16）

## 完成范围

- 新 VOC 输入显式接替同一定位阶段的旧执行：原子撤销旧租约、记录 SUPERSEDED、停止自动重试。下一次 Worker 心跳中断本地等待，迟到完成和报告发布受现有租约代次校验保护。
- 新周期有独立截止；正常自动重试仍继承原周期。已开始后释放回队列的前序不被误当成后继，重复并发唤醒只保留一个真正待执行后继。不同 ASIN 的归一化不套用此取消规则。
- PostgreSQL 接替与完成/失败/释放统一父级优先锁顺序，避免新旧操作锁反转。
- 项目列表显示只读“最近分析人”，以同组织精确项目 ID 的最新分析记录关联账号。每批 200 个项目，列表/详情/新增修改响应均派生可信值；前端不能伪造字段。未知显示未记录，姓名搜索在分页前执行。
- 修复初始化空搜索防抖误重置页码；实际搜索改变仍返回第一页。

## 红绿回归和审查

最初 SQLite/PostgreSQL 均复现旧任务仍 running，Worker 未 abort（3 项失败）。修复后通过。独立子智能审查又复现两处竞争：完成与接替死锁、释放回队列的前序被复用；补正式回归并修复，独立复验通过。迟到报告发布、租约、截止继承及分析人组织隔离审查未发现剩余重要问题。

- 最终九套后端回归 **176/176 通过**，含两库、Worker、归一化恢复、分析人接口、分页和本地数据桥接。
- 子智能执行完整浏览器回归 **13/13 通过**，包含姓名展示/搜索、伪造字段回退、时钟控制的初始化翻页回归。早期分页失败有实际原因，未以延时掩盖；已修复后重跑。
- 全仓 typecheck 通过。新增竞态测试拦截器最初有泛型类型错误，修正为保留 QueryResultRow 泛型后通过。
- 限定 ESLint 0 errors，保留项目列表原有 refresh Hook 冗余依赖 warning。
- 隔离目录 `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/voc-analyst-20260916` 构建成功，源码/复制目录/构建指纹一致：`dea7a85662f7d5d38c9061efe384fff75fd028ba5d2406320d0047665395e05a`。

证据在 `.superpowers/sdd/`：`voc-supersession-red.log`、`voc-supersession-requeue-red.log`、`voc-supersession-races-green.log`、`voc-analyst-final-tests.log`、`voc-analyst-final-typecheck.log`、`voc-analyst-final-lint.log`。独立竞态复现脚本为 `supersession-lock-review.ts` 和 `supersession-requeued-review.ts`；正式测试已纳入 tests/agent。

## 正式发布

沿用已授权的正式更新流程，管理器 `manage-formal-stack.ps1 -PublishCode` 退出码 0，于北京时间 **15:59:05** 激活。

- source commit：`ce694fde1b15662c9230cc7efc15eca75f20f615`；包括已验证工作树源码，精确身份以源码哈希为准。
- Web / Agent source hash：`dea7a85662f7d5d38c9061efe384fff75fd028ba5d2406320d0047665395e05a`。
- artifact：`4cab6405ff99ad6d78e5ae0b8a302652f0336abf7aa9ea9ab1745cef78043c76`。
- request：`dab2d3809fc71d81014171c28cd5a445aa8391d723debaf808003f3dee9091be`。
- 基底为上一版本 `2df1dd9e4901ac15cb520c68a67530c25228eed63169171798ca47fbe8e41470`；业务数据十项哈希与发布前一致，结构规则仍为 1.1.3。
- 16:00:58 直连核验：本机 Web 31900、Agent 31901、局域网 Web 健康均 HTTP 200 / ok；局域网页面入口 HTTP 200 HTML；四张任务表 queued/running 均为 0。
- 正式库只读抽查：70 个有分析记录的项目均能解析同组织发起账号。不表示所有旧本地项目都一定有分析记录。
- 旧产物 72 个文件备份并逐项哈希校验，位置为运行时 `backups/voc-analyst-20260916`。

发布日志 `voc-analyst-release.log`，核验 JSON `voc-analyst-release-verification.json`。浏览器连接可枚举标签但读取新标签超时，未将此声称为已完成的正式登录态 UI 验收；页面功能由上述浏览器测试验证，正式登录态实机验收留给用户。未触发付费模型调用、未直接改写生产任务或历史报告。Provider 远端是否立即停止计费不由本地中断保证；本修复解决本地任务占用及迟到写入，不承诺上游模型永不超时。
