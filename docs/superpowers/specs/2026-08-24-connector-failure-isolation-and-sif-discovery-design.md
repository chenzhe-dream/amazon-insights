# 连接器失败隔离与 SIF 结果发现设计

## 目标

让 SellerSprite、SIF、Sorftime 在同一同步任务中按最窄可信范围失败：
单个 ASIN 的单个 stage 数据结构异常只留下该模块缺口，不再污染连接器健康状态；
真正的 provider-wide 故障仍能及时停止本任务内的后续无效调用。

同时让已经成功返回的 SIF 数据在任务终态与概览页可被用户发现，
并让进度 UI 区分“流程是否走完”和“数据是否完整”。

## 不变约束

- 保持三家连接器的严格 schema；不得接受任意对象或制造兜底业务值。
- 只处理用户提交的站点与 ASIN；生产代码不得加入 ASIN 特例。
- 不把 SIF 数据写入或展示为 SellerSprite、Sorftime 字段。
- 不改变单次提交、单个 job、单个 Worker 领取和现有 run lineage。
- 本设计不启用图片 AI，不改变 Alexa 人工流程。

## 失败范围模型

失败分为三个互不混用的范围：

| 范围 | 典型原因 | 行为 | 持久化健康状态 |
| --- | --- | --- | --- |
| ASIN + stage | `schema`、`MCP_SCHEMA`、消费者 shape 校验失败 | 当前模块标记缺口，继续其他 ASIN、stage 和 connector | 绝不写 `connector_status=unavailable` |
| 当前 job 内 provider-wide | DNS、TLS、proxy、connection、timeout、HTTP、RPC、governor | 打开该 connector 的 job 内熔断，跳过本 job 剩余调用 | 不凭一次业务调用直接写全局 unavailable |
| 全连接器不可用 | 缺失/无效配置、凭证无效、认证失败 | readiness 阻止该 connector，其他 connector 继续 | 可写安全、无密钥的 unavailable 状态 |

HTTP 只有在能被明确归类为认证失败时进入“全连接器不可用”；
其他 HTTP/RPC 故障仅作为当前 job 的 provider-wide 熔断。
短暂网络故障不会跨 job 永久封禁连接器。

## Runner 分类与继续执行

`classifyProviderFailure` 继续输出闭合的 `failureKind`、`causeCode` 和有限 shape 诊断。
`createProviderDegradationTracker.record` 对 `schema/MCP_SCHEMA` 必须 no-op，
不得把它计入阈值，也不得出现在 `providerDegraded` snapshot。

单 ASIN、单 stage schema 失败时：

1. 当前模块写入 `connector-failed` 或等价缺口状态；
2. 保存已成功模块，不回滚同 ASIN 的先前结果；
3. 继续同 connector 的下一 ASIN与下一 stage；
4. 继续其他 connector；
5. job 最终为 `completed-with-gaps`，不得伪装为完整成功。

provider-wide 失败时，tracker 只在当前 job 内阻止该 connector 的后续 dispatch；
skip diagnostic 使用固定安全原因，不保留响应正文、凭证、URL 或未知对象。

## Worker 持久化边界

Worker 不信任 mirror 的 `providerDegraded` 数组，即使 mirror 来自 legacy runner。
在 `#publishProviderDegradation` 前设置独立、可单测的过滤边界：

- `failureKind=schema` 或 `causeCode=MCP_SCHEMA` 一律丢弃；
- 伪造的 `provider-degraded`、未知 connector、未知 code 和异常对象一律丢弃；
- job 内 DNS/TLS/proxy/connection/timeout/HTTP/RPC/governor 只更新 job 诊断，
  不转换成持久化全连接器 unavailable；
- 只有已验证的配置或认证失败可写 unavailable；成功 capability probe 可写 available。

因此，旧版本或异常 mirror 即使错误地把 schema 放进 `providerDegraded`，
也不能在 Worker 持久化边界污染 readiness。

## SIF 成功结果发现

终态卡片和工作区概览根据当前 job 的真实 module readiness 展示入口：

- `keywords` 至少有一个目标 ASIN 为 `ready` 时显示“查看关键词调研”；
- `traffic` 至少有一个目标 ASIN 为 `ready` 时显示“查看竞品流量分析”；
- 两者都成功时并列显示两个中文入口；都未成功时不显示假入口。

入口复用现有 workspace/run 路由，只切换到既有页面，不发起同步、provider 调用或新 POST。
目标页面继续从 SIF 自己的 snapshot/generated 数据读取，并明确显示 `SIF MCP` 来源。
不得用 SIF 标题、价格、评论、销量或图片填补 SellerSprite/Sorftime 缺口。

## 进度与完整度

顶层继续显示两个独立指标：

- `执行进度`：描述调度流程是否已经走完；终态 job 可以是 100%。
- `数据完整度`：按目标 ASIN × 数据模块的真实 `ready` 数计算。

stage 行不再把 `partial` 或 `skipped` 渲染为 100% 成功条。
这两种终态行显示固定文案“流程已结束 · 数据缺口”，保留原因与缺失模块；
`done` 才显示完成，`failed` 显示失败，人工/停用行不显示伪百分比、ETA 或倒计时。

顶层执行 100% 与低于 100% 的数据完整度可以同时出现，且不构成矛盾。

## TDD 与验收

实现严格遵循 RED → GREEN → refactor：

1. 三 connector 矩阵证明 `MCP_SCHEMA` 只影响一个 ASIN + stage，后续调用各执行一次；
2. DNS/TLS/proxy/connection/timeout/HTTP/RPC/governor 矩阵证明 job 内熔断；
3. Worker 测试注入 legacy/异常 mirror，证明 schema 不写 `connector_status`；
4. UI 测试证明 SIF 入口只由真实 ready 模块出现，且路由不产生 POST；
5. 进度测试证明 partial/skipped 行无 100%，顶层双指标保持真实；
6. 回归证明已有成功数据、单提交、resume 和 GET-only 恢复语义不变。

所有实现与验收使用 fake connector、内存响应或本地 fixture；
不调用真实 MCP，不发业务 POST，不使用真实 ASIN 特例，不生成或改写 MCP 数据文件。

## 发布边界

合并前运行受影响的 runner、Worker、readiness、UI 定向测试、lint、diff-check 和一次 build，
并确认保护中的 generated WIP 与 project JSON 未被修改或暂存。

部署后只执行一次 Sorftime capability probe，用于把已修复连接器恢复为可用状态；
probe 不携带 ASIN、不写业务数据，也不自动提交 job。probe 成功后停止自动操作，
由用户输入全新 ASIN 并主动提交一次；系统只做只读监控，不代替用户重试或创建第二个任务。

## 完成判定

- 任意单 ASIN schema 失败不会停止其他有效数据采集，也不会写 connector unavailable。
- provider-wide job 熔断与全连接器配置/认证不可用具有清晰、可测试的不同生命周期。
- legacy mirror 无法越过 Worker 过滤边界污染健康状态。
- SIF 成功结果有真实中文入口，来源归属不被混淆。
- UI 同时真实表达流程结束与数据缺口，且发布后仅有一次受控 probe 和一次用户提交。
