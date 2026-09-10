# VOC 全步骤超时收尾验证

## 范围与语义

- `alexa-voc-normalization`、`voc-positioning`、`product-definition` 共用默认 300000 ms 截止时间；每次提交的步骤/重试链独立计时，排队、运行、自动重试和结果发布恢复均计入。
- 自动重试不延长截止时间。人工重试、等待输入后的明确恢复、新 ASIN 输入拥有新的计时起点。
- 独立扫描及心跳最长每 5 秒检查一次，正常数据库条件下到期收尾；撤销任务租约，标记非自动重试的 `QUEUE_TIMEOUT`，拒绝迟到结果覆盖。
- 保留加密原文、不可变模型审计、评论版本、数据快照和报告。数据库故障不能被视为已成功释放任务。
- 输入与 origin job 的持久归属隔离防止新输入重新执行旧超时内容，也防止一个 ASIN 的失败覆盖另一个 ASIN 的状态。

## 回归与审查

- 最终 10 套相关测试同一命令执行：223/223 通过，0 失败，耗时 100.7 秒；包括 queue safety/runtime、worker、真实多 ASIN recovery、repository/migrations、normalization status、两种 manual store、实际旧版升级。
- 最终 `npm run build` 通过（vinext 五阶段）；全部改动 TypeScript/TSX 文件 ESLint 和 `git diff --check` 通过。保留既有 chunk 大小/路由静态分类提示。
- 双适配器覆盖三个阶段的 queued/running 过期、租约失效、自动重试不重置、人工重试新截止时间、不可变结果保留、独立 ASIN 截止时间、单个任务完成后兄弟任务仍受超时扫描。
- 真实 normalization runtime 验证：A 过期后新增 B，provider 只收到 B；加密输入保留，A 状态仍是 timeout。
- 真实 0029 -> 0030 升级覆盖 SQLite/PostgreSQL，验证旧 shared batch 的归属回填、历史发布次数不变及重复迁移幂等。
- 保留原有多 ASIN 结果发布失败恢复测试，明确区分升级前 shared batch 与升级后独立输入队列。
- 审查发现并修正：等待输入恢复沿用旧时间、跨 ASIN 状态污染、新输入继承旧排队任务、执行器扫描旧输入、一个任务完成使兄弟任务漏掉收尾、交错任务编号提前耗尽重试次数。实际重试链计数保留持久预算与 worker policy 双限；新增真实 worker 用例验证三次调用且原截止时间不变。
- 全仓类型检查仍有 336 项既有错误，当前改动文件无新增诊断；不能声称全仓 TypeScript 干净。既有 `voc-waiting-input-resume.test.ts` 使用过期的固定日期，该失败已在基线复现，不作为本次修复通过的证据。

## 正式数据保护

- 私有备份目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/voc-all-step-timeout-20260910`。
- PostgreSQL custom dump 4374865 字节，目录检查包含 43 个 TABLE DATA 条目及原文快照/评论版本表。
- 46 个 generated/项目文件与 72 个当前页面产物文件逐一核对散列；另备份 formal-stack.env、stack.json、current-known-good.json。凭据不进入代码仓库或报告。
- 发布前仅检查到一个旧 normalization 阶段仍 queued，没有活动 job、analysis run 或 sync job。计划只通过测试过的 repository 超时方法收尾该旧 run；不执行直接状态 SQL、不重跑整批分析。

## 正式发布结果

- 独立审查批准，无阻断 P1/P2；代码提交 `97f74e401f4bf4610733c564602d2ad4c0c69241`。
- 使用正式 migration runner 将 schema 28 升级到 30。首次本地连接池参数传递未成功，核验仍为 28 后修正连接创建；没有把失败调用当成成功迁移。
- 对旧 run `0b1f247f-620b-4475-8a68-53964fdf4be7` 调用 repository 超时收尾。首次扫描返回 0，仍存在候选，复核条件和数据库活动后再次有限调用返回 2。没有绕过 SKIP LOCKED、强制解锁或直接更新状态。
- 两条旧 normalization job 均为 failed / retryable=false / QUEUE_TIMEOUT，租约清空；旧 queued 阶段已 failed。原 95 个 data snapshots、88 个 agent audits、29 个 VOC revisions、29 个 publication outbox、33 个 normalization terminals 和 2 个 reports 的整表内容散列在收尾前后完全一致。
- 正式目录无冲突快进至该提交，15 个 generated 数据文件保留。`manage-formal-stack.ps1 -PublishCode` 正常通过空闲/健康/进程归属检查并退出 0；未绕过发布检查。
- 本机 Web、局域网 `192.168.1.109:31900` 和 Agent 31901 均 status=ok，Web/Agent sourceCommit 同上，sourceHash 一致为 `1c63718b2ff9aec5ec8dd971ac036fb385be14e554f39111bbbda280d5ee08f0`。
- 新代码 artifact：`fa2d5bf6415cda2bbf5b5ead4dddbe6802563b15e7c3297ca45190447688d211`；原数据 artifact `9602179000313f8e85507d833a1698918252113ec21f553081ba1b366d5be711` 保留为 dataCurrent / baseArtifactId。
- 发布后 job_attempts / run_stages / analysis_runs / sync_jobs 的 queued/running 数量均为 0。15 个 generated、31 个项目文件及正式配置，共 47 个文件逐字节与备份一致。
- 未删除历史、未重跑整批分析，未把旧第三个 ASIN 标记为分析成功。用户可刷新后手动重试；新重试独立计时。
