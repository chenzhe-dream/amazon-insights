# 真实模型执行诊断与有界修复（2026-09-17）

## 现有证据与边界

本切片只负责模型超时/输出校验诊断接线，不修改请求计量、batch-meter、取消数据库逻辑或前端，不发布。暂不执行付费请求；后续真实验证由主测试者统一协调单次请求。

真实 status.json 显示：关键词有一次成功（61.836秒，1986输入/980输出tokens），另有90秒左右超时；主题有28.986、57.850、48.401秒成功，也有约60秒超时及一次两次尝试后的输出校验失败（81.766秒，合计6239输入/6893输出tokens）。这些记录证明提供商可调用但延迟/输出可靠性未达标，不能把全部失败归为凭据无效或简单延长时间就保证成功。

Runtime将每任务timeout设为min(基础配置timeout,任务timeout)：关键词90秒，其余本次总览/主题60秒。Relay chat请求已经reasoning_effort=low、verbosity=low、SDK maxRetries=0；SkillRunner仅transient错误自动重试，timeout本身不会触发重试；输出格式/证据校验失败最多一次repair。两次attempt不等于两次timeout，不能只看总时长就猜测原因。无法由本地审计证明中继实际接受了reasoning设置，也无法由usage为空证明供应商未收费。

## 确认的诊断缺陷

SkillRunner已有安全validationLogger，记录initial/format-repair、错误数量、schema路径及错误码，排除原始值和任意错误文本。VOC runtime已接入，但market runtime和runner均未透传，导致真实MODEL_OUTPUT_ERROR无法定位是字段、枚举、引用还是修复失败。

## 修复计划

1. 先添加市场runtime集成回归：初始和repair均返回无效结构时日志出现两次，任务正常失败且usage保持记账；任意原始输出内容不进入日志。
2. MarketSemanticRunnerConfiguration增加可选validationLogger并注入SkillRunner；createMarketModelRuntime options/config透传。createAgentService市场runtime使用既有外部logger或app安全warn。
3. 补充日志回调抛错不改变分析结果及repair次数的回归；不修改timeout、模型、reasoning、重试上限或identity预算。
4. 运行定向runtime和SkillRunner回归，更新验证证据。只在已收集具体安全诊断后提出有依据的输出修复，避免盲目重试。

## 实施与验证

- 已完成 market runner -> runtime options/config -> Agent Service 的 validationLogger 透传，runtime日志额外带task，用于区分模块；只传递SkillRunner已清洗的schema诊断，默认使用带market-model组件标记的app.warn。
- 未修改modelFor/timeout、模型名、reasoning、重试上限、预算或配置身份计算。未修改通用SkillRunner的校验标准及修复授权。
- 红测 `model-diagnostic-red.log`：原代码实际调用2次，但期待的initial/format-repair日志为[]，明确复现市场接线缺失。
- 修复后 `model-diagnostic-final.log`：market-model-runtime与skill-runner合计 **74/74通过**，包括安全日志透传、恶意原值不进日志、logger抛错不改变repair次数/usage记账、单次timeout终止且不盲目重试、现有重启/抢占/生命周期回归。
- Targeted ESLint通过。类型检查结果另行记录。

### 对真实输出失败的进一步证据

`themes-model-audit.json` 中agent run `81a98c32-9e87-44a4-8033-02781f754f0f` 的attempts_json为initial(model-output, settled)、format-repair(model-output, settled)，transientRetryCount均0。usage完整，6239输入/6893输出tokens，两次合计81.766秒。说明初始输出与修复均被结构/证据校验拒绝，旧日志缺少诊断路径；并非两个timeout。

### 后续单次付费验证提案（未执行）

由主测试者集中协调，只针对上述失败主题冻结输入运行一个batch，注入新增安全validationLogger；保持实际模型、reasoning=low、60秒单次限制及原有至多一次repair。最多初始+一次repair，失败后收集安全issues，不扩展到其余主题，也不重新采集来源。本子任务当前没有发起任何额外付费请求。

## 安全业务校验规则标识补齐

仅接日志还不足以定位证据错误：semantic-validation中的fail将规则名置于Zod自定义message，安全摘要会删除message，使repair和日志只收到custom及空路径。已复现并补齐静态白名单ruleId：例如market-invalid-span、market-foreign-span、market-member-partition-mismatch；未知ruleId和原始message/输出值仍丢弃。没有放宽span、成员或目录校验。

通过独立 `market-semantic-validation-rules/v1` 进入legacy/shape/keyword discovery配置哈希；overview综合与keyword reconciliation/explicit通过父配置继承，保证修复诊断语义不在同一配置身份下静默变化。未修改skill内容、正式timeout、模型或reasoning。

安全摘要与领域测试红测为2项规则标识缺失；修复后49/49通过。连同runtime及identity回归，`model-diagnostics-versioned-final.log`为 **67/67通过**（与此前74项存在重叠，不累加）；ESLint 0错误，现有unused变量警告12项。

## 单次180秒真实形态诊断（协调授权后执行）

主测试者明确批准使用新shape运行35643c43-50c7-47e0-b013-6191526fad5a的冻结binding，保持10商品、注册skill/prompt/schema、gpt-5.6、reasoning=low、verbosity=low、4000输出上限，只将本次诊断请求timeout设180秒。直接调用真实OpenAIProvider一次，SDK maxRetries=0，经正式resource governor；不走SkillRunner execute，因此不触发repair或隐含重试，不改变原任务状态。脚本具备结果文件存在即拒绝再次执行与二次物理请求拒绝保护。

脚本 `.superpowers/sdd/market-shape-single-diagnostic-20260917.ts`；结果 `.superpowers/sdd/market-live-fix-20260917/shape-single-180s-diagnostic.json`。只保存耗时、请求设定/hash、usage、finish_reason和安全校验结果，不保存模型原文或凭据。开始时间2026-09-17T01:59:08.667Z。此诊断无论返回结果如何，都不能作为原60秒任务通过的证明。

### 180秒诊断最终结果及中继契约异常

该唯一物理请求 **126619毫秒后返回**，finish_reason=stop，实际usage为prompt_tokens=3001、completion_tokens=8491，其中reasoning_tokens=7501，总tokens=11492。请求实际SDK body记录为max_completion_tokens=4000、reasoning_effort=low、verbosity=low。SDK的chat.create将body原样post到/chat/completions；本地SDK类型文档将max_completion_tokens描述为包含可见输出和reasoning的上界。

因此已证实：本次中继返回的completion usage超过所请求上界，且60秒低于本次实际完成时间。**不能据此直接放大正式timeout，也不能仅凭7501个reasoning tokens证明中继忽略low。** 可能是中继参数转换/兼容语义问题，尚未取得中继实现或原生上游证据。模型有效输出仅约990 tokens，延迟主要伴随高reasoning用量，但没有分阶段计时，不作精确耗时归因。

输出随后被领域schema拒绝：path=[products]、ruleId=market-invalid-schema。单次诊断没有repair，不算原任务成功。按初始约束未保存模型原文；进程结束后不能恢复products具体值，禁止凭空推测为哪个子字段错误或重新付费重放相同shape。

诊断还发现现有semantic-validation.parse把原生Zod问题压缩为首路径的custom invalid_schema，故当前日志无法区分products缺失、类型错误或数组大小违规。建议后续保留原生code/expected与安全路径、仍移除原值，并升独立diagnostics版本；尚未实现，避免正在执行的新身份发生漂移。

### 可控修复选项（待主任务统一决定，不自动追加请求）

1. 在adapter补充“实际output usage超过请求上限”的安全契约异常检测并保留真实usage，不伪造/截断记账，不把响应作为正常结果或触发format repair。此举可阻止错误成功，但无法追回供应商已产生费用。
2. 若要确认relay支持的reasoning/上限语义，用极小固定schema和固定输入、明确低输出上限，单独协调none/low对照；每个请求仍是实付，不能假设中继必然遵守上限。优先确认中继能力/映射，必要时使用支持所需参数的配置或原生传输，而非对所有业务任务增加timeout。
3. 输出schema诊断先补足后，再根据明确失败规则修复输出契约或提示；不放宽证据跨度、ASIN所有权或成员覆盖。

最新版本化回归后TypeScript检查通过（model-diagnostics-versioned-typecheck.log为空，进程exit0）。本子任务真实消耗仅上述1个物理请求，后续无追加付费。

## 第二阶段已授权实施：diagnostics/v2与微型协议探针

等待全部worker退出后，已将诊断升级为 `market-semantic-validation-rules/v2` 并通过前述身份计算传递。semantic-validation.parse现保留原Zod code/expected/path和多条问题，message统一为静态invalid_schema，再由安全摘要过滤未声明路径/任意ruleId/原值；不改变任何数据准入条件。新增红测实际为custom、期望invalid_type；修复后安全与领域50/50通过。这样后续products层问题可以区分类型、大小等，而不需要泄漏模型原文。

检查market-suggest-product-shape的SKILL、引用合同与MarketShapeSuggestionOutputSchema：未找到可证契约冲突。逐商品恰好返回一次、支持候选1至3个、requiresManualConfirmation=true、unknown枚举、同商品UTF-16跨度引文均一致。输出原文未留存，无法倒推旧失败细节，不进行猜测修复。

主测试者随后授权恰好两个微型物理请求：同endpoint/gpt-5.6、严格单字段status='ok'、无业务数据，分别chat low/low +max_completion_tokens128、Responses reasoning low +max_output_tokens128。各30秒、SDK maxRetries0、正式governor及凭据；不修改正式transport，不使用repair。脚本与结果文件有重复执行/第二次同协议调用保护。

脚本 `.superpowers/sdd/market-tiny-protocol-probes-20260917.ts`，结果 `.superpowers/sdd/market-live-fix-20260917/tiny-protocol-probes.json`。usage缺失时不记为0或宣称免费；返回usage时仅使用当前配置费率记录估算，不等同供应商账单。

### 微型协议探针结果（恰好2次，已结束）

- chat：30,040毫秒超时；未返回HTTP状态/usage，费用未知，不能记为免费。
- Responses：23,040毫秒返回completed；严格schema验证通过，status=ok。usage为input55/output20/reasoning0，总75；本次output20不超过请求上限128。当前配置估算费用约$0.00175，不是供应商账单。

这是同endpoint/model下Responses对微型请求的成功证据，不证明较大业务批次必然成功，也不能由单次短输出证明提供商对任意请求一定强制上限。未修改正式transport；没有第三次微型请求。连同此前180秒诊断，本子任务共3个物理付费请求。后续真实业务验证由主测试者协调。

diagnostics/v2与runtime/identity定向回归最新 **68/68通过**，见model-diagnostics-v2-final.log（与前述测试数重叠，不累加）。

## 市场专用协议显式选择（新增授权切片）

新增 `server/runtime/market-model-config.ts` 的loadMarketModelRuntimeConfig(env)，复用原配置的已校验credentials、endpoint、模型、价格、预算及worker设置。AGENT_MARKET_MODEL_TRANSPORT未设置时保持原行为；仅显式responses-strict或relay-chat-json可改变市场协议。非法值静态报错，不输出凭据或环境值。

特别保留relay->Responses的原endpoint/key配对：不能通过替换AGENT_VOC_TRANSPORT后重载配置来切换，因为原loader的native Responses分支会把baseUrl置空，可能误把relay凭据发送至默认endpoint。由默认native切到relay时则重新使用既有URL验证器校验OPENAI_BASE_URL。

Agent Service只在市场runtime创建处使用新loader；VOC等既有调用继续使用原resolution.config。市场服务的各modelIdentity回调全部取自同一runtime实例，协议/provider/endpoint哈希进入现有身份计算，避免排队身份和执行身份不同。未改变正式env、前端、provider实现或timeout。

已增加默认不变、保留endpoint/凭据/预算、非法配置不泄漏、native身份变化且prompt身份稳定的回归；现有Agent Service PostgreSQL队列集成改为VOC relay基线加市场Responses override，验证相同身份的任务被正确消费且仅调用一次。首次运行新loader不存在的红测失败；实现后配置加runtime **20/20通过**，见market-model-config-green.log；后续新增native->relay地址校验用例另行记录最终验证。

最终配置定向 **5/5通过**（新增反向relay地址校验）；ESLint 0错误/警告；TypeScript全量noEmit通过，分别见market-model-config-final.log、market-model-config-lint.log、model-diagnostics-config-typecheck.log。

## 单商品原响应诊断与最小协议兼容修复

主测试者在单商品full runtime初始及repair均输出失败且安全issues为空后，明确授权最后一个60秒Responses请求并允许原模型响应仅保存在本地私有测试工件。绑定a3b84827-f162-413b-b0b8-7005015661a5、run2b7367f0-3f31-44e6-8c4d-272c3b17286c。独立probe ID、结果文件存在即拒绝重复、一次物理请求、maxRetries0、无repair；原注册输入/skill/schema，low/low、cap4000不变。

该请求 **8741ms** 返回completed，input1344/output393、总1737，未超4000。output_text是整段Markdown json围栏，故JSON.parse在Zod前失败，解释此前安全issueCount=0。原响应只保存在.superpowers/sdd/market-live-single-20260917/shape-responses-single-60s-raw-probe-20260917.body.json，日志不打印原文/密钥。诊断结果为同名.json；离线验证为同名.offline.json。

离线去除唯一整段围栏后，内部是合法JSON object，但顶层为schemaVersion/task/batchId/inputDigest/results/warnings；products缺失。原schema继续拒绝，安全问题为products的invalid_type(expected array)及根unrecognized_keys。因此围栏兼容本身不能使真实错误输出通过，禁止results→products猜测映射。

本地实际provider向Responses传递strict text.format；形态skill依赖“字段以本次JSON Schema为准”。真实响应违反该字段合同，证明请求方不能依赖此relay的strictformat提供充分保障，但尚无中继代码证据可证明其内部如何丢弃/转换schema。采用显式schema提示作为受控兼容补足，不声称已确认relay内部实现根因。

已新增market专用schemaPromptMode='prompt-and-native'：chat保留原instructions及第二system schema指令；Responses在原instructions后追加两个换行和同一个JSON schema指令。两种协议均保留原strictformat。导出createRelayJsonSchemaInstruction供计量复用，布局为JSON.stringify({instruction:'Return only one JSON object that conforms exactly to this schema.',schemaName:format.name,schema:format.schema})。旧VOC默认duplicated与native的Responses请求不变。

allowSingleJsonFence默认false，market显式true；仅解包整个响应中的一个json或无语言标记围栏，内部必须JSON object；拒绝前后散文、多围栏、数组/null、任意抽取。原Zod/跨度引用校验、usage/cap保持生效。公开商品输出抽取为tests/fixtures/market-shape-relay-wrong-schema-20260917.json（不含响应元数据、凭据或内部reasoning）；回归要求真实results结构继续失败。

测试先行3项红测→修复后provider **26通过/1显式live跳过**，见model-schema-compat-red.log与model-schema-compat-green.log。未额外请求；本子任务迄今实际物理请求共4次（180秒诊断1次、微型协议2次、最后单商品1次）。计量和配置policy版本由主测试者同步，然后由主测试者继续真实验证；当前不能宣称四模块验收通过。

兼容修复后TypeScript全量noEmit通过（model-schema-compat-typecheck.log为空、exit0），provider/market-runner/测试文件ESLint通过（model-schema-compat-lint.log为空、exit0）。

### 合成集成测试随计量协议更新

显式schema提示加入完整请求后，旧synthetic-market-model/synthetic-resolved走未知model的UTF8上界，在10000输入限额前被拒绝，使等待fake provider进入的测试最终120秒取消。该旧失败保存在model-schema-compat-runtime-final.log，没有将其标为通过。

测试fixture改用已知gpt-5.6名称，所有请求仍注入synthetic client、不产生外部费用；生产限额不变。多批分区测试从9增至81个synthetic成员以继续覆盖多批执行；captured真实发送body的serializedBytes必须与meter吻合，estimatedInputTokens+512仍不超过10000。20条overview facts现在可进入1个window，保留完整20facts、-80%同比例事实及审计执行断言，不强制依赖旧byte计量的碎片数。1000输入限额拒绝和未知model保守fallback独立用例仍保留。

market-model-runtime、market-semantic-execution-service、market-semantic-batch-preparation、market-request-admission定向 **37/37通过**，见market-known-tokenizer-runtime-final.log。该数与此前runtime测试重叠，不累加成独立覆盖数。

相关fixture的旧any及未使用循环变量已改为明确合同类型和等价计数循环；三fixture ESLint通过，TypeScript全量noEmit通过（model-schema-compat-fixture-lint.log / model-schema-compat-fixture-typecheck.log均为空且exit0）。清理后batch-preparation独立复核 **7/7通过**，见market-preparation-clean-final.log。

## 形态候选单商品分批（7.5，2026-09-17）

新显式schema Responses下十商品仍60秒超时，而单商品已取得端到端成功及有限引文repair证据。主任务批准仅降低shape suggestion成员上限，已先追加design/spec/tasks再执行红绿回归。

`MARKET_SHAPE_SUGGESTION_BATCH_POLICY`固定maxMembers=1、plannerVersion=market-semantic-batches/shape-single-product-v2；其他任务保留market-semantic-batches/v1及原成员上限。shape policy进入legacy runtime配置指纹，因此旧配置任务在已有lineage检查处拒绝；没有扩大timeout、output cap、调用/日预算，也没有新增自动重试。

从每批10降为1后，原10商品需要10次初始请求而非1次；固定schema/prompt费用会重复。现有run/day预算仍可阻止剩余请求，并不能预先承诺10次全部成功。主题上限12未改动，其数据仍按12/12/1分批。

真实公开商品fixture回放验证10批、10成员恰好一次、商品参数/标题及sourceEvidenceByRef完全保持、重复计划逐字相等。另冻结旧v1真实10成员binding验证：原输入仍允许10商品，历史readMarketShapeRun使用的同一validateMarketShapeSuggestions成功校验旧绑定，没有调用新planner重算basisHash，fixture哈希保持不变。代码核查readMarketShapeRun和shape-price-flow直接读取保存的binding/manifest，不依据新planner常量重建历史ID。

红测3个规划/真实回放失败加1个旧配置身份未变化失败均已复现；最终规划、真实源重放、旧binding、身份、runtime队列和持久化分批 **36/36通过**，见shape-single-batch-final.log。TypeScript全量noEmit通过（shape-single-batch-typecheck.log为空、exit0），OpenSpec严格验证通过。本子切片零真实模型调用；完整10商品逐批真实验收由主任务在独立schema进行，不能以回放代替真实通过。
