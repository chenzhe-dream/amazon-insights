# 2026-09-17 真实调用阻塞修复复测

## 范围与发布状态

用户授权修复并使用真实额度。候选代码位于 integrate-xydc-variant-20260905；连接真实供应商、已配置模型中继及 PostgreSQL，任务写入独立 market_live_* schema。正式服务未重启、正式配置未修改，不能把本记录当成正式页面验收通过。前端没有因本轮修复更换布局。

模型候选使用市场专用 AGENT_MARKET_MODEL_TRANSPORT=responses-strict；端点、凭据、模型及额度来自现有配置，VOC 传输设置不变。该覆盖只用于本轮候选测试，尚未写入正式环境。

## 已确认并修复

1. 完整请求原先按 UTF-8 字节当 tokens，导致合法商品无法准入、总览过度分片。已识别模型改用固定版本 o200k 分词，加 20% 和 512 framing 余量；未知模型及可能阻塞 CPU 的长输入保守回退。显式 schema 提示也纳入实际请求计量，没有截断证据或提高输入预算。
2. 模型中继实际返回过单段 JSON 围栏以及错误顶层字段。市场请求同时携带原生 schema 与显式 schema 提示；仅允许剥离整个响应的单个 JSON object 围栏，仍执行原字段、ASIN、引用跨度校验。错误 results 不会被猜测映射为 products。
3. 接通封闭规则编号及安全结构诊断，使一次有界修复知道具体失败原因，不输出原始供应商内容或凭据。
4. 若供应商报告输出超出请求 cap，保留真实 usage 结算并终止该请求，不追加格式修复消费。此保护不能撤销供应商已发生的费用。
5. 取消事务关闭 pending 模型审计，晚到输出不发布，已完成历史不覆盖。旧隔离任务 c7b9256e-9769-4b6b-b882-7a332297b0d4 的两个遗留 pending 已通过正常取消入口收尾。

## 真实结果（包括失败）

| 测试 | 实际结果 | 证据目录 |
| --- | --- | --- |
| 单商品形态，显式 schema + Responses | 初次引用跨度不合法，被拦截；一次修复后成功保存。商品标题不能支持预设形态，正确保留 unknown；整个模块仍待人工确认，不等于全部报告完成 | .superpowers/sdd/market-live-contract-20260917 |
| 10 商品形态，同一批 | 采集成功；模型 60 秒超时，测试取消剩余工作 | .superpowers/sdd/market-live-acceptance-20260917 |
| 评论主题，3 个 ASIN、25 条主题 | 4 次来源调用成功，形成 12/12/1 三批；首批模型 60 秒超时，未继续其余付费批次 | 同上 |
| 关键词，5 个词 | 词来源成功，首模型请求 90 秒超时；取消已提交，随后公开读取误拒绝尚无 attempt 的已取消步骤，触发 lineage 报错 | 同上 |
| 市场总览 | 13 个来源操作中，前 7 个响应成功（含 1 个空响应），后 6 个被本地 governor 返回 rate-limit；一次仍在 60 秒窗口内的延后恢复继续受限，停止继续重试。未完成本轮模型总览生成 | 同上 |

来源操作调用次数不直接等于物理上游请求数或扣费次数；本地 governor 也可能拒绝调用。真实余额接口不可用，不能伪造精确费用或将超时的 usage 记为零。

事后只读核对：总览 02:31:46–02:31:52Z 已记录 30 次 SellerSprite 物理请求，当前策略为 30 次/60000ms；02:31:55Z 与 02:32:24Z 的窗口计数均为 30。后续拒绝及恢复尝试没有新增物理请求，属于本地滚动保护，不能归因为供应商 HTTP 429。证据 governor-read-only.json；本轮未提高或绕过限流。后续需核对采集调度的冷却等待与 MCP 多次物理请求开销，再进行完整总览验收。

## 无外呼重放

当前完整 schema 计量策略下，原 10 商品均准入；原总览 73 个窗口压缩为 6 个，保留全部 142 个唯一主事实及 167 个唯一缺失项。此为已保存真实输入的规划重放，不是 6 次真实模型调用成功。

## 形态逐商品修复后的复测

形态规划增加 shape-single-product-v2，只将该任务的每批上限从 10 改成 1；其他模块上限不变。新配置身份纳入策略，旧十商品绑定仍按保存的输入与引用校验，不重算新规划。10 个商品会产生最多 10 个初始模型请求，仍受既有单次、整任务和组织预算约束。

独立新任务 `80db90c3-ba78-496d-8242-9c26266a061c`，schema `market_live_shape_single_batches_20260917`：真实采集成功（来源报告 attemptCount=2），完整形成 10 个单商品批次。前三批分别约 40.7 秒、7.9 秒、3.9 秒通过；第四批首次触发 market-invalid-span，一次格式修复后仍报 MODEL_OUTPUT_ERROR。测试随即取消其余 6 个尚未执行批次，保留前三批成功结果。该结果证明逐商品路径可执行，但不证明 10 个商品全部通过或模型稳定性已解决。

证据：`.superpowers/sdd/market-live-shape-single-batches-20260917/{events.jsonl,shape-execution.json,shape-public.json,shape-model-audit.json}`。失败修复的诊断没有结构化 issue，不从空 issue 列表猜测具体格式错误。

## 代码验证

最终主回归 `final-contract-regression-v2.log`：143 项，142 通过，1 项需显式独立开关的 OpenAI smoke 跳过，0 失败。另有上述真实请求记录，不能把该跳过项描述为全套真实测试通过。

全量 TypeScript `npm run typecheck` exit 0；本轮相关后端文件 ESLint exit 0，保留 16 个原有的解构排除字段未使用警告，未为清除警告扩大生产改动。形态旧绑定兼容、规划和身份相关定向测试已包含于独立验证记录，不与主回归数量相加。

OpenSpec `validate enable-market-backend-evidence-flow --strict` 通过。

取消读取补充主线回归 `final-cancel-read-regression.log` 31/31；最后三处生产修改后的全量 TypeScript 也通过（typecheck-cancel-read-final.log）。独立 public 集成覆盖取消后 facts/pool 保留、重复取消与跨组织拒绝；测试文件仍有既有 any lint 错误，不能声称全仓 lint 清零。

## 取消后公开结果读取修复

真实关键词任务的取消在 02:31:21Z 已提交；报错来自随后的读取。旧读取将 cancelled 临时伪装成 partial，使合法的“尚未领取、没有 attempt 的已取消步骤”被 reconciliation 判为损坏。现以真实 cancelled 状态进行只读追溯，只接受 attemptCount=0 且无任何历史 attempt 的未领取取消步骤；原步骤定义、inputRefs 与 inputHash 校验保留。执行入口默认仍拒绝推进已取消任务。

两个 acceptance 关键词/总览任务均通过正常取消入口收尾；关键词已保存 facts 可读，无 pending 模型审计。真实 Fastify 路由与会话认证注入测试中，四模块 GET 均返回 200，读取前后步骤 attempt 数均为 37，没有因读取重新启动分析。此为后端 HTTP 注入验证，不是浏览器完整验收。证据：`.superpowers/sdd/market-live-acceptance-20260917/{cancel-repair.json,http-check.json}`。

## 未通过项与后续验收

批量模型耗时仍需真实验证。主题、关键词和总览尚未全链路通过；不能发布“四个模块已全部跑通”的结论。正式页面的登录、点击、轮询、结果布局及团队可见性仍须发布候选后单独验收。

更完整的模型协议诊断见 model-runtime-fix-20260917.md；取消竞态修复见 cancellation-fix-20260917.md。既有 live-verification-20260917.md 为本轮修复前的历史基线，保留其失败记录。
