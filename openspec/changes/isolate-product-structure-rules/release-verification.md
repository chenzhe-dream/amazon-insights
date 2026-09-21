# 结构规则正式发布核验：2026-09-16

## 发布结果

用户已授权发布。正式栈管理器 `manage-formal-stack.ps1 -PublishCode` 完成，退出码 0；持久化激活时间为北京时间 15:23:54。规则版本 `product-structure/1.1.3`。

- 正式目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/integrate-xydc-variant-20260905`。
- 源码提交：`ce694fde1b15662c9230cc7efc15eca75f20f615`；发布包括已验证的工作树内容，不能仅凭提交号识别。
- Agent / Web 源码哈希一致：`2813a1ee5835c7cdef73dc140be5c08c45e1e282c2178dd784c6762f2358b8bf`。
- 已激活 artifact：`2df1dd9e4901ac15cb520c68a67530c25228eed63169171798ca47fbe8e41470`。
- 已应用 request：`e990472b71e6e48751c0be68e36d6229a6c22859231317f89ad4ff1c60814f81`。
- 北京时间 15:24:49，本机 Web 31900、Agent 31901、局域网 Web 192.168.1.109:31900 健康检查均为 HTTP 200 / ok；后续本机及局域网页面入口均为 HTTP 200 HTML。
- 激活产物的客户端与服务端 bundle 均包含规则版本 `product-structure/1.1.3`。
- 数据基底仍为 `55167de961d7427a14d8b3c17cc7c473f72c74c292b163ff9d4216017385ef2f`；十个业务数据阶段哈希与发布前备份一致。
- sync_jobs / run_stages / job_attempts / analysis_runs 的 queued/running 数量均为 0。

发布前本轮回归 95/95、发布管理器测试 23/23 通过；正式发布构建通过。首次发布后健康探测受本机代理连接关闭影响；关闭该探测进程的环境代理使用后直连验证成功，未修改持久配置。未执行付费 Provider 端到端分析；业务实机验收由用户继续。历史保存报告不自动改写，重新分析才使用新规则。

备份位于运行时 `backups/structure-rules-release-20260916`；旧产物 72 个文件均经哈希校验。原先预构建 artifact `40b4edce…` 仅 prepared，实际激活以上述正式管理器产物为准。

证据：`.superpowers/sdd/structure-other-asins/release-activation.log`、`release-verification.json`、`release-preflight.log`、`release-persistence.log`、`release-manager.log`。

## 发布前 VOC 超时核查

运行记录 `11cce58c-d4af-47d0-94ef-66c587b24ee4`，以下均为 2026-09-16 北京时间：

| 事件 | 时间 | 结果 |
| --- | --- | --- |
| 总分析记录创建 | 14:27:42 | 不等于 VOC 开始时间 |
| VOC 原文归一化首次开始 | 15:05:31 | 首次 15:07:27 成功 |
| VOC 产品定位首次开始 | 15:07:27 | 15:12:27 失败，UPSTREAM_TEMPORARY |
| 产品定位第二次尝试 | 15:12:27 | 15:17:28 失败，上游暂时不可用 |
| 第二轮归一化开始 | 15:10:12 | 15:13:29 成功 |
| 新定位周期入队 | 15:13:29 | attempt 3，retry_cycle_start_attempt=3 |
| 新周期开始执行 | 15:17:28 | 等前一调用退出后执行 |
| 队列周期截止 | 15:20:32 | QUEUE_TIMEOUT，停止自动重试 |

正式配置：模型调用上限 300000 ms，VOC 周期上限 420000 ms；独立清扫每 5 秒一次。最新周期从 15:13:29 至 15:20:32 约 7 分 2 秒，超时已生效；未手动取消、未直接更改数据库。总运行状态为 partial，归一化 succeeded，定位 failed，全部占用释放后才执行发布。

仍有需要单独改进的衔接边界：`latestActiveAttemptSql` 对定位仅选最新 attempt；新周期产生后旧的运行调用不再由这条截止查询选中，仍等其 Provider 超时退出。因此本例定位阶段总耗时约 13 分钟，并非整个阶段严格只允许 7 分钟。当前证据不足以认定第二轮输入由用户重复提交还是其他触发，也不足以定位上游不可用的具体网络原因。本轮没有把这些未验证原因写成结论，没有修改超时机制；建议后续补充新旧周期并存时的终止及展示回归。
