# 德国项目 31900 正式发布与任务创建验收

2026-10-21，用户明确要求将已验收的新版本发布到 31900，并将改动写入 Git。本次发布固定使用候选已运行的代码提交 `4bf06b0286a5e29995a2d4241c714cc986802add`；没有合入候选后续的英国原飞镖恢复工作。

## 故障与发布范围

正式旧版本为 `7efbc72a25f105192ec7786769b7d30a205fb3ae`。德国工作区虽然存在于本地项目列表，但 Agent 项目登记契约仅允许 US/UK，正式 PostgreSQL 的 `sync_jobs` 和 `sync_job_submissions` 也仅允许 US/UK，导致页面显示“项目登记失败，未创建分析任务”。

本次在正式工作区快进到已验收提交，通过 `scripts/manage-formal-stack.ps1 -PublishCode` 构建不可变 Web 产物并切换 Web 31900 / Agent 31901。新迁移将采集队列约束及关键词冻结输入支持范围扩展到 US/UK/DE/CA。为保持已通过真实模型验证的候选行为，同步设置 `AGENT_VOC_RELAY_RESPONSE_FORMAT=json_object` 和 `AGENT_VOC_RELAY_SINGLE_TRAILING_OBJECT_BRACE=1`；完整输出 schema、冻结引用和语义校验仍执行。配置中的凭据没有进入 Git。

## 正式发布证据

| 项目 | 发布前 | 发布后 |
|---|---|---|
| Web PID | 31676 | 108032 |
| Agent PID | 69464 | 330504 |
| 运行代码提交 | 7efbc72a25f105192ec7786769b7d30a205fb3ae | 4bf06b0286a5e29995a2d4241c714cc986802add |
| Web/Agent sourceHash | acc96105c7617d8414d64dbd0ba344210d5218ea81c7a7bf7508e61839117406 | 77eb5a561f550cdb14a6f0cdf0f7f42524716ee3b9fb90a5f66ee73032d3967e |
| Web artifactId | 889ecabc7ffdec3f76e6fa67a7366c5aed0c7a47814afac59151e97dfb41630b | c2efb6fedb2433f6241f318e7ccba60cf29fd253511aaea5fc730e058ac209a0 |

发布管理命令退出码为 0，稳定构建完成，Web/Agent 健康状态与精确代码指纹一致。一次激活尚未结束时的提前检查观察到了旧 Web 版本，未作为成功依据；发布管理器确认完成后重新检查通过。

32900/32901、33900/33901 的 PID 与 sourceHash 均与发布前一致。本次没有切换这些环境，也没有复制候选数据库覆盖正式数据库。

## 德国原项目真实操作

在用户已有登录的 Chrome 正式页面刷新后，点击“开始全自动分析”，成功创建并启动真实采集任务：

- 项目：`0e6d9225-54b4-404f-b998-44a53f3f1e2a`，DE。
- ASIN：`B09Q8MJP3R`、`B09GY72DX2`、`B09VP9LJQX`、`B0GCNJJDZP`、`B07KSDSSS1`。
- 采集任务：`c207314a-2c2b-4882-9cab-baa44aecafdf`。
- 基础数据运行：`65313bba-db4a-4468-98ae-743d0088e8be`。
- 页面已经显示“基础/MCP同步已启动”、运行 1、商品底库入库中；正式数据库记录为 `running`，精确五个 ASIN 与 DE 范围一致。
- 后续页面与数据库复核确认 catalog 阶段 `done`：5/5 个 ASIN 就绪，上游无结果 0、失败 0、待处理 0。其他采集阶段仍待执行，不把目录阶段成功视为所有字段或完整报告就绪。
- [正式项目任务页面](http://192.168.1.109:31900/p/playground-fitness-equipment-de?run=65313bba-db4a-4468-98ae-743d0088e8be&syncJob=c207314a-2c2b-4882-9cab-baa44aecafdf)。

此记录证明发布成功、原登记错误消除和真实任务启动，不证明本次正式采集或模型分析已全部完成。页面的“分析进行中”涵盖基础采集，不能据此声称已经生成 VOC/新品定义报告。

此前独立补充包含 110 条卖家精灵可取评论、115 个销售趋势点、9 个 Customers Say 主题与 6 个变体身份。它仍保存在独立目录，未通过此次代码发布自动写入正式报告；不得把这些数量算作当前正式任务已采集量。

## 备份与证据位置

发布前确认 `sync_jobs`、`run_stages`、`job_attempts`、`analysis_runs`、`market_analysis_steps` 的 queued/running 总数为零。正式数据库、启动状态、配置与已知可用发布指针已备份至：

`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/backups/de-formal-20261021-4bf06b02`

数据库备份 40,698,433 字节，SHA256：`7E18DCA89AA1F2ACF0ACD13F0B46482829892722A1054A7B1D848BCADACBC7A6`。首次备份因默认数据库用户名不匹配而未成功，随后使用正式配置中的用户名完成备份并校验；正式数据没有被该失败尝试修改。

执行脚本、脱敏日志、发布前后健康证据、数据库约束、任务快照和页面截图位于：

`C:/Users/EDY/.codex/visualizations/2026/10/21/01a15d00-9eb3-7a20-9692-40fb46183339/formal-de-release`

回退时须先检查活动任务，再使用备份中记录的旧提交与已知可用产物执行受控发布；不得在当前真实采集运行时强制回退或恢复整库。本次文档提交用于保留发布事实，不要求重启已验证的运行版本。
