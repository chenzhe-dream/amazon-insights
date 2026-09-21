# 2026-09-17 剩余失败原因调查

本轮只调查，不修改生产业务规则、正式配置或任务。证据来自现有源代码、上轮真实审计、冻结输入的有界真实复查及本地协议计数。不能将模型中继不可观测的内部原因写成已确认事实。

## 1. 总览：协议开销、限流重试、测试等待行为叠加

### 已证实

- `scripts/lib/sellersprite-mcp-client.mjs:64` 每次操作新建 Client；96 行连接，115 行关闭，没有跨操作复用连接。
- 133 行把所有 fetch 都纳入 SellerSprite governor，包括协议握手和 GET 监听，并非只计算 tools/call。
- 使用实际 MCP 客户端连接本地协议服务器，两个业务查询分别产生：POST initialize → POST notifications/initialized → GET 监听 → POST tools/call。共 8 次 fetch；没有外部供应商调用。证据 `.superpowers/sdd/market-live-acceptance-20260917/mcp-request-count-root-cause.json`。
- 实际 PostgreSQL 物理请求记录在 6 秒内达到 30 次/60 秒的既有限额。7 个完成查询的 28 次物理请求，加上后续连接阶段请求，就能耗尽窗口。后续被拒绝的调用没有新增物理请求，不能归因于供应商 HTTP 429。
- `remote-mcp-connector.ts:136` 把本地 ResourceGovernorAdmissionError 统一映射为 rate-limit；`market-source-step-handlers.ts:52` 再映射成 upstream-temporary。日志丢失了“本地限流还是上游限流”的区别。
- `market-module-execution-store.ts:291,303` 使用最多三次、间隔 5 秒及 30 秒的普通失败重试，不知道 60 秒窗口何时释放。因此可能在约 0/5/35 秒把同一限流窗口内的三次机会用完。上轮实际只执行了两轮；不能声称已观察到三轮全部失败。
- 上轮 acceptance 脚本 82 行 `if(!worked)break` 在 next_attempt_at 尚未到达、runtime.tick 返回 false 时结束测试。总览当时是 queued；并非证明正式服务永久停滞。随后测试者主动取消任务以收尾。

### 修复方向（尚未实施）

保留物理请求计量，评估同凭据/组织范围内受控复用 MCP 会话；把本地 admission 的可重试时间传给调度器，按实际窗口等待，不能靠增大限额或无间隔重试。测试循环必须等待非终态的 next_attempt_at，区分排队和执行完成。

## 2. 模型超时：主题已定位到收到 HTTP 响应之前

冻结主题批次 `ed382ff5-df08-409c-89e0-899eb76f048e`，12 条主题，原模型、原端点、low reasoning、4000 输出限额、60 秒截止、SDK 重试关闭。仅增加网络阶段诊断，单次物理请求。

2026-09-17 02:56:58.600Z 发出；59970ms 后 fetch AbortError；未观察到响应头或 HTTP 状态；总耗时 60031ms。说明本次失败发生于等待 HTTP 响应，未进入响应 JSON 解析、引文检查或数据库写入。证据 `theme-timeout-network-root-cause-20260917.json`。

业务超时取 `min(运行配置, 任务限额)`。主题/形态固定上限60秒，关键词90秒，见 `market-semantic-task-definitions.ts:73-76`、`market-model-runtime.ts:76`。单独调高通用模型超时仍受任务上限约束。

已存旧诊断还显示中继曾用126.6秒返回，报告输出8491 tokens，超过请求的4000，并曾返回不符合原生 strict schema 的字段。这证明该中继链路存在协议不一致，不能证明它内部一定排队、忽略 low reasoning 或实际用了什么模型。没有中继/上游服务端日志，DNS/TCP/TLS等待、网络延迟、中继排队和模型生成耗时尚不能细分。关键词的本轮单次网络诊断结果另附。

关键词冻结批次 `d22320f0-836d-4bde-bdd8-151d17bfae4d`、5词、本轮保持90秒截止：52955ms收到HTTP200响应头，53038ms完成并通过原语义校验，usage为3305输入/2821输出tokens。同一冻结输入此前90秒超时，本轮正常返回，说明存在响应耗时波动，不能归因于该输入必然不合法。证据 `keyword-timeout-network-root-cause-20260917.json`。这不是运行原任务或后续补充数据、归并和最终报告全部成功。

## 3. 形态：引文约束失败与修复信息不足

原失败商品 B019QBOG3U 的标题是 Paper Mate InkJoy Gel Pens 等书写属性，参数未采集，标题没有预设“按动/笔帽”的直接关键词。依据当前目录应允许 unknown；不能为了生成结论补造结构。

上轮首次错误确为 market-invalid-span。`semantic-validation.ts:244-253` 强制引用属于本商品、UTF-16 start/end 合法、quote 逐字等于原文切片，且不切开代理对。该错误只说明跨度条件至少有一项失败；旧日志未保存该次失败候选，无法指出究竟哪一个字符或位置错误。

本轮用同一冻结 inputDigest `ce4cf2aefe974e8bda35db1ae41c7f485d5ce69677d2045755ce183058ce2035` 发出一次真实请求：5093ms 返回、1913输入/166输出tokens，正常 JSON，unknown，通过完整原校验。这排除了“该冻结数据必然无法通过”的说法；不构成模型稳定性证明，也不把历史失败改为成功。证据 `shape-failed-member-root-cause-20260917.json`，原结果保持不变。

修复机制存在明确的信息缺口：跨度校验调用 fail('invalid_span') 没有传字段路径，日志只有空 path；普通修复请求仅带原输入和概括性 issue，再要求重新生成，没有带上次错误候选或指出哪条 evidence 的哪个范围。见 `skill-runner.ts:957-973`、`safe-validation-issues.ts:123-139`。因此“修复”实际上是依据笼统错误再生成一次，不能确保改正原处。

上轮第二次 issueCount=0 对应 provider invalid_output 分支；该分支涵盖输出文本形状/解析等失败。现有审计不足以进一步确定是围栏、JSON语法还是其他响应形状问题，不能只凭空 issues 猜测。

### 修复方向（尚未实施）

优先补可定位的安全诊断（字段路径、引用标识、失败条件），在限定权限内提供可复核的修复信息；评估由代码按同商品原文解析唯一精确引文的位置，遇多匹配/无匹配仍拒绝。不能放宽“原文必须匹配”或跨ASIN补证据。稳定性问题应单独用固定输入及有界调用评估。

## 调查边界

本次模型诊断为已取消测试任务的冻结输入只读准备与单次独立请求，不重启原任务、不更新其业务结果。不是四模块重新完成验收，也没有发布正式版。

本轮共3次真实模型请求：形态1次通过、主题1次截止、关键词1次通过；没有追加格式修复或隐藏SDK重试。主题未收到usage，费用未知；另外两次usage只作为供应商报告值。MCP计数实验完全在本地，不调用真实供应商。
