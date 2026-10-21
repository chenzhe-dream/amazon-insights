# 英国原飞镖七个 ASIN 候选恢复记录

状态：实现与复审进行中，尚未完成本轮真实补采、模型分析和页面验收。本文不代表验收通过。

本次保留原项目 `6fb02de8-60dd-4c87-b168-8bbcb3cce277`、原任务 `fcbd86a0-501c-42b2-b28d-6f7d851db03b` 和全部七个 ASIN。本任务只允许切换 33900/33901，不操作正式 31900/31901 和原候选 32900/32901；正式服务的并行变更见文末。此前英国平衡板代表样本的成功不作为本项目的验收证据。

## 已验证的缺数原因

| ASIN | Sorftime GB 详情现场探针 | 解释 |
|---|---|---|
| B0FJ4T6V2C | `#B0FJ4T6V2C`，空标题和字段占位 | 来源没有可用商品详情；其中零值不能作为真实业务数据 |
| B0F5NRLWB6 | `#B0F5NRLWB6`，空标题和字段占位 | 同上 |
| B0FPXDD2D4 | `#B0FPXDD2D4`，空标题和字段占位 | 同上 |
| B0DLB22T15 | `#B0DLB22T15`，空标题和字段占位 | 同上；此前趋势请求返回工具错误并触发整任务供应商保护 |
| B0C6FP6LMY | 有效标题、父体 `B0CVNMW6DG`、评论总数 682 | 评论总数不等于可取得的评论样本；Sorftime reviews 返回无样本 |
| B0DQCF6ZVZ | 有效标题但类目等字段缺失 | 趋势返回 2026-06 至 2026-10 的 `-1`，必须保留未知，不能改成零 |
| B0GHQW7GYY | 有效标题，上架日期 2026-10-19，零评论 | 原阶段的“评论就绪”仅确认零评论，没有可供 VOC 的评论内容 |

Sorftime 工具的英国站参数是 `GB`，SIF 和 SellerSprite 使用 `UK`。探针证明此次缺数不能单纯归因于站点枚举。

关键词方面：原七个 ASIN 的 SIF 近 30 天结果为空；SellerSprite 同站点 traffic_keyword 也均为空。B0C6FP6LMY 的父体近 30 天同样为空，但原子 ASIN 的 2026 年 9 月 SIF 查询返回四个真实关键词。因此只允许显式标注月份的历史证据，不能宣称近 30 天存在关键词或当前需求已验证。

评论方面：B0C6FP6LMY 的 Sorftime Customers Say 仅有未结构化摘要，主题数组为空，reviews 返回 `No reviews found.`。SellerSprite 对同一个英国 ASIN 返回八条真实评论。修复采用独立标记来源的备用评论通道，不把该数据冒充 Sorftime 评论。

## 修复及验证边界

- 严格识别缺失商品详情，避免依赖趋势请求引起无关商品的连带失败；认证、额度和传输失败继续保留原诊断和保护。
- 当前查询经验证为空后，候选 UK 开关允许一次上个完整 UTC 月查询；缓存、阶段输出、冻结证据、模型和页面保留实际周期及当前为空的事实。
- UK 评论备用通道只在明确的 Sorftime 空结果后使用 SellerSprite；错误不能触发绕过，原七个商品身份及各自缺口均保留。
- 阶段终结、来源可用和分析成功分别验证；最终报告必须保留有限样本和部分覆盖说明，不扩大为全部数据完整。

证据根目录：`C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/de-ca-analysis-20261021/evidence/uk-darts-investigation/`。原始探针保存 JSON、gzip 和 SHA256；本轮状态文件与旧四站验收文件隔离。具体运行身份、实跑结果、报告入口和测试结论待实际验收后补充。

## 并行正式服务变更观察

本任务尚未切换候选时，六端口比较发现正式服务被并行操作变更：31900 从 PID 31676 / `7efbc72a` 变为 PID 329436 / `aa923008`，31901 从 PID 69464 / `7efbc72a` 变为 PID 330504 / `4bf06b02`。新进程来自独立的 `stable-persistent-20261006` 工作树，分别创建于本地 14:08:02 和 13:59:44；本任务没有对这两个端口执行停止、启动或发布操作。

原始 `baseline-before.json` 保留，发现时快照为 `external-formal-change-observed.json`，进程依据为 `external-formal-processes.json`。后续候选切换的保护检查以该已观察状态为比较基线，最终仍报告与最初状态的差异，不能声称整个会话期间正式进程完全未变。32900/32901 与本候选 33900/33901 在发现时均维持原 PID 和源码身份。

随后又观察到正式 31900/31901 变为 PID 328628 / 333972，提交均为 `1dac83bd3366bb23592c0d08941fb40cda76e947`，源码指纹为 `ea36f6110f69e3d542b924bbeef3f80012b432ce7c0e9a186f1fe2709411e34e`。进程仍来自独立的正式工作树。`external-formal-change-observed-2.json` 与 `external-formal-processes-2.json` 保留该次观察；后续候选操作使用此状态作保护比较。

## 首轮真实补采发现的集成问题

候选代码 `307b994e`，源码指纹 `f7c329a7b4ed99d964e9cc7c0581888426b3a2c6d33a79a932c32e7e5d3895d0`。补采任务 `213a11c2-f59f-4820-beaf-b11cf304c4a2`、数据运行 `262cdc71-fd6c-45d2-b803-959d2ea3e485` 在 2026-10-21 06:35 UTC 终结为失败，未提交模型分析。

- 商品底库 7/7，历史关键词 2/7：B0C6FP6LMY 四词、B0FPXDD2D4 五词，均来自 2026-09；其余五项为已验证空结果。
- 修复缓存错误地保护旧的 pending 空评论壳，拒绝写入本次 `terminalReason=valid-empty`，产生 MCP_SCHEMA，进而阻止 SellerSprite 备用评论。需允许经验证的空状态更新，同时保护已有实质评论内容。
- 发布保护将旧 `observationErrors` 错误字符串当成可验证销售数据，拒绝清除已解决的诊断。修复仅在销售记录比较中排除操作诊断；实际观测、时间、来源及 ready 状态仍受保护。
- 销售阶段实际只有四次 Sorftime 物理请求：B0DQCF6ZVZ 的 SalesVolume、SalesAmount、Price 成功返回未知值，Rank 返回工具 RPC 错误。后续 B0GHQW7GYY 的 request-failed 是保护机制跳过，不能报告为四次上游请求失败。
- 独立一次有界 Rank 探针仍返回 `An error occurred invoking 'product_trend'.`。Rank 是合法的主类目月排名类型；不能替换成小类目日排名 BsrRank，也不能根据当前类目为空就编造历史排名为空。保留上游失败和保护机制。

本轮日志、任务镜像及生成缓存已归档于 `attempts/213a11c2-f59f-4820-beaf-b11cf304c4a2/`，后续补采保留明确的父任务关系。
