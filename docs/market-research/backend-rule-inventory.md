# 市场调研四模块后端规则与缺口清单

日期：2026-09-16  
用途：供运营核对已实现口径，并作为后续 OpenSpec 分期输入。按用户“完成后统一审核”的追加授权，已补齐四模块已有正式输入能够支持的字段、投影与人工版本操作；尚未发布。本文区分代码能力、验证范围和缺少正式输入的业务确认项，不新增业务阈值。当前验收记录见 `openspec/changes/enable-market-backend-evidence-flow/completion-verification.md`；首个切片的历史验证见 `verification.md`。

## 共同边界

- 新版四模块链路由 `server/services/market-module-service.ts` 的 `MarketModuleService` 承接：`createStudy` 保存组织范围与研究范围，`startOverview`、`startShapes`、`startKeywords`、`startThemes` 分别冻结模块参数、版本与幂等命令；`server/runtime/market-module-step-worker.ts` 以持久化 step/attempt 执行，来源、输入快照、规则产物和模型版本可回放。`server/services/market-research-service.ts` 的 `MarketResearchService`/`MarketResearchWorker` 是 legacy research job 链，不作为本清单四模块执行链的证据，也不应与 `MarketModuleService` 混写。
- 数值规则与统计由代码计算；分类、翻译、解释等语义任务由后端代码调用受控模型。模型配置缺失时，新模型步骤不可执行，已保存报告仍可读取；模型输出还要经过结构、证据和 lineage 校验。证据：`server/services/market-module-service.ts:51` 的 `model()`；`server/runtime/market-model-runtime.ts` 的 `configurationFor`、`MarketModuleStepWorker` handlers；`server/runtime/market-semantic-execution-service.ts` 的执行入口。
- 缺失值必须保留为 `null`/missing reason，不能填 `0`。已知值必须带证据，缺失值必须带原因。证据：`shared/market-keyword-scoring-contracts.ts:18`；`server/domain/market-research/keyword-scoring.ts:88-94`；主题汇总中无有效主题的 totals 也是 `null`，见 `server/domain/market-research/customer-themes.ts:88`。
- 来源范围被冻结在输入快照中；后续计算不得换 ASIN、换月份、换关键词池或借用范围外证据。采集结算保存 source evidence 与 input snapshot。证据：`server/runtime/market-source-step-handlers.ts:58-64`；各处理器的范围校验见同文件 `products`、`aba`、`themes`。
- 当前已证实的正式后端不依赖 Cursor：`server/connectors/mcp-connectors.ts` 通过 request-scoped resolver 取组织凭据；无组织级凭据时仅沿用服务端环境配置行为，见 `server/services/scoped-connector-credential-resolver.ts:8-23`；环境变量名与读取集中在 `server/config/connector-secrets.mjs:12-27`。正式 SellerSprite、Sorftime、SIF 客户端均调用 `readServerConnectorSecret`，分别见 `scripts/lib/sellersprite-mcp-client.mjs:4,14`、`scripts/lib/sorftime-mcp-client.mjs:3,17`、`scripts/lib/sif-mcp-client.mjs:1,8`。
- “旧脚本 fallback”须单独看待：原版参考的 `scripts/lib/cursor-mcp-keys.mjs:7-30` 会读取个人 `~/.cursor/mcp.json` 并灌入环境变量；原版 SellerSprite/Sorftime/SIF 客户端也有 Cursor 配置读取（参考目录 `scripts/lib/*-mcp-client.mjs`）。这只能说明旧本地脚本曾有配置 fallback，不能作为正式后端依赖或部署凭据方案。此次核对未读取任何实际凭据。
- 四模块创建命令都优先重放已接受的任务；当前模型配置变化或消失不改变旧任务。研究、模块或公开参数不同的同键请求报冲突，组织与停用用户仍校验。规则说明放入原版结果区的折叠详情，前端只显示服务端已保存结果及版本。

## 1. 市场总览

### 已实现

| 项目 | 已实现口径 |
|---|---|
| 输入 | 站点、类目节点、`fromMonth`/`toMonth`，以及运营选择的 `headTopN`（5/10/20）和 `newProductMonths`（1/3/6/12）。每个月按版本规定采集来源操作。见 `server/domain/market-research/overview-flow.ts:18,23-33`。 |
| 来源范围 | v3 expanded flow 对每月安排 `MARKET_OVERVIEW_ALL_OPERATIONS`；基础版只含 `market_research` 与 `market_research_statistics`。来源响应按请求月份、站点、币种和类目身份校验并保存。见 `overview-flow.ts:29`、`server/services/market-overview-collector.ts:43-54,63-132`。 |
| 计算 | 先形成确定性的完整来源目录、窗口和数字表，再按维度生成解释。缺失指标保留空值；缺少身份字段时不会用第一条搜索结果冒充目标类目。见 `market-overview-collector.ts:119-132`、`server/domain/market-research/overview-complete-catalog.ts`、`overview-distributions.ts`。 |
| 模型 | 已有分维解释与完整综合编排代码；模型请求绑定 prompt/configuration、输入表和输出 schema。见 `server/runtime/market-model-runtime.ts:68-90,118-155`。 |
| 人工节点 | 当前没有总览数字的人工改写节点；运营只能选择启动参数、重试失败步骤或取消。历史读取不应触发重新采集/模型调用。 |

### 已批准实施目标与本地验证

- 已实现并本地验证：所有**新建**市场总览任务使用 v5 完整证据工作流、完整数字目录 `MARKET_OVERVIEW_TABLE_CATALOG_VERSION` 和独立的 overview synthesis 模型身份；不能回退复用 legacy 通用模型身份。实施依据见 `openspec/changes/enable-market-backend-evidence-flow/design.md` 和 spec 的 `New overview runs use the complete evidence workflow` requirement。`MarketModuleService.startOverview` 与生产服务装配已接通该入口，尚未发布。
- 已批准：模型未配置或语义执行失败时，保留已成功采集的来源和确定性数字报告；解释显示 unavailable/failed 与缺失原因，不能填零，也不能回退到未经批准的启发式。见 OpenSpec spec 的 `Model unavailability preserves usable numeric results` requirement。
- 已批准：旧任务保留创建时冻结的 flow、规则、来源和模型身份，不原地升级；相同幂等命令重放返回原任务，参数冲突拒绝；历史只读不触发采集或模型调用。见 OpenSpec spec 的 `Existing commands and historical analyses keep frozen semantics` requirement。
- 本地验证通过：从公开 service/HTTP 入口创建 v5，独立模型身份严格匹配；无模型、非法模型输出和部分窗口失败保留数字/缺失报告；定向重试不重采成功来源；旧 v3 命令重放仍返回原任务；只读历史不增加外呼。另覆盖配置消失后的排队步骤收尾，以及已有模型结果的最终报告无模型保存。测试使用隔离 PostgreSQL、合成来源和模型传输，尚不代表真实供应商字段与模型质量验收。
- 仍待逐字段业务确认：原版展示所需指标能否从正式来源取得，以及单位、币种、月份截止点、头部集中度分母和新品定义。批准 v5 流程并不等于批准这些未核对的旧算法；不得恢复原版阈值或把缺失当零。

### 后续补齐输入与验收条件

1. 本次实施输入（已批准）：固定 v5、完整数字目录、独立 overview synthesis 模型身份、语义失败保留数字、旧任务不升级与历史只读。验收：从公开入口覆盖有模型、无模型、非法输出、定向重试、旧 v3 重放、参数冲突、身份变化与组织隔离；历史读取的采集和模型调用计数均为零。
2. 后续业务输入：字段字典（来源 operation、原始路径、单位、可空性）、月份截止规则、`headTopN` 与新品月龄选项含义。验收：构造完整/缺字段/币种冲突/类目身份冲突样本，报告逐字段给出值或 missing reason，冲突样本不能形成确定结论。
3. 后续业务输入：v5 综合解释允许引用的窗口和证据类型。验收：每条结论可回到冻结窗口与 source record；范围外月份和 ASIN 引用被拒绝。

## 2. 商品形态及价格带

### 已实现

| 项目 | 已实现口径 |
|---|---|
| 输入 | 固定商品池，包含站点、月份、`poolSize`（最多 100）及来源选中的 ASIN；后续形态选择必须来自该快照。见 `server/runtime/market-source-step-handlers.ts:22-23,82-95`。 |
| 来源范围 | `collect-product-month` 保存单月商品池与采样信息，后续不得换 ASIN。商品来源准入和查询窗口由 `server/domain/market-research/product-source-admission.ts`、`shared/market-product-source-policy.ts` 约束。 |
| 计算 | 已能按确认后的形态标签与价格带形成确定性结构统计；价格和销量只对有证据的商品计入，空值不作零。核心函数见 `server/domain/market-research/shape-price.ts`、`shape-structure.ts`、`shape-price-catalog.ts`。 |
| 模型 | 模型基于保存的商品文本证据提出形态建议；人工 revision 后可启动窗口化结构解释与综合解释。见 `server/runtime/market-shape-selection-step.ts`、`market-shape-explanation-window-step.ts`、`market-shape-synthesis-round-step.ts`。 |
| 人工节点 | 人工确认/修订形态映射会生成 revision，而非覆盖旧结论；修订保存后若模型不可用，revision 仍保留并明确解释不可用。见 `server/services/market-module-service.ts:129-145`。 |
| 商品展示字段 | 从冻结来源读取销售额、评分、评分数、卖家、配送类型、上架日期及对应证据路径；非法值保持未知，收入不使用价格乘销量推算。见 `shape-source-metadata.ts`。 |
| 期间与年份 | 独立 `market-shape-period-projection/v1` 绑定原 catalog，显示研究窗口、近3/6个月、前两年、品牌及价格带、上架年份统计。期间必须完整处于已保存范围；所有期间使用整个研究窗口共同可比 ASIN 集合。链接占比分母为全部选中链接，销量占比分母为共同可比销量。见 `shape-period-projection.ts`；不改变旧 catalog/hash。 |

### 已确认缺口与待业务确认

- 当前形态模型使用文本证据，不看商品图片；原版参考的图片启发式/人工图片识别不能被描述成正式模型能力。原版相关入口见参考 `app/lib/product-shape.ts` 与 `product-shape-vision.client.ts`。
- 已保存范围内的品牌×价格带、形态×价格带、上架年份和期间统计已补齐；超出已保存范围的历史月份仍不可用，读取报告不会暗中补采。正式规则使用冻结共同样本，不宣称与原版所有 fallback 完全等价。
- 毛利率、退货率及其机会判断尚无完整正式输入与规则。参考原版 Sorftime dashboard 可解析 `averagePrice`、`medianPrice`、`returnRatePct`（参考 `app/lib/sorftime-category-dashboard.server.ts:505-507`），但“能解析”不等于已进入当前形态规则链。
- 需业务确认：形态 taxonomy 与允许人工合并/拆分规则、价格带边界及币种、销量时间窗、父子 ASIN 粒度、上架年份定义、毛利所需成本项、退货率口径、图片是否作为正式证据。不在本清单中擅自选择阈值。

### 后续补齐输入与验收条件

1. 输入：经业务确认的商品字段清单（ASIN 粒度、标题/属性/图片、价格及币种、月销量、上架日期、退货率、FBA/采购/运费等成本）。验收：每个统计单元列出纳入/排除 ASIN 与原因；缺字段不进入分母且不补零；币种不一致不能合并。
2. 输入：版本化形态 taxonomy、价格带边界和人工操作规则。验收：模型只提建议；人工确认生成不可变 revision；从 revision 与冻结事实确定性重建相同统计，旧 revision 可回放。
3. 输入：若启用图片，明确图片来源、时点、可访问性和人工复核流程。验收：无图片时不得推断视觉形态；图片失败只标缺失；每个图片判断可追溯 ASIN 与 source record。
4. 输入：毛利/退货/年份规则公式。验收：公式、单位、时间窗、分母和适用条件显示在规则说明中；边界样本和不适用年份返回 missing/not-applicable，而非零。

## 3. 类目关键词洞察

### 已实现

| 项目 | 已实现口径 |
|---|---|
| 输入 | 固定分页关键词池、每词趋势；US 且配置 SIF 时可选采集 ABA。ABA 请求必须引用同一冻结关键词池。见 `server/runtime/market-source-step-handlers.ts:26-29,102-134`。 |
| 来源范围 | 关键词池去重后冻结，趋势按 keyword ID 绑定；ABA 非 US 明确失败为 unsupported，缺连接器明确 configuration。不会静默降级为零。 |
| 计算 | W5 已计算当前月搜索量、日历同比（12 个月前）、月环比和“较 3 个月前”（当前月对 3 个月前单月）；零基线、缺当前月、缺基线均返回原因。见 `server/domain/market-research/keyword-rule-report.ts:75-88`。聚类后可计算覆盖、mid-rank 和已具输入的评分分量，见 `keyword-scoring.ts`。 |
| 模型 | 可做关键词语义归类、标签发现和全局 reconciliation；模型输出经成员覆盖、批次与证据校验。不同 analysis mode 绑定不同模型身份。见 `server/services/market-module-service.ts:98-103`、`server/runtime/market-model-runtime.ts:102-119`。 |
| 人工节点 | 可保存人工关键词分类 revision，并从保存事实与人工 revision 重建规则报告。见 `server/services/market-module-service.ts:106-126`。 |

### 必须明确的时间口径

新增 `market-keyword-score-input-audit/v1` 独立核对投影，在原有评分详情显示每个簇的原词、已保存字段、来源路径及缺失条件。来源页 USD 推荐竞价没有确认窗口，月度趋势竞价没有确认币种，两者不会拼成可评分的竞价，也不当成实际 CPC；ABA 点击与转化份额分开保存，真实零值保留。投影不改变原 facts/report/hash 或 PVS。

- 当前正式 W5 的 `threeMonthGrowth` 是 `calendar-three-month-growth/v1`：当前月 ÷ 三个月前单月 − 1，展示名“较3个月前”，见 `shared/market-keyword-rule-report-contracts.ts:5,18` 和 `keyword-rule-report.ts:85-88`。
- 原版曾使用等长窗口增速。它不是日历年同比，也不是当前“当前月对三个月前单月”。后续若恢复，必须用新字段/新 methodVersion/新展示名并并行保存其分子、分母和窗口；严禁把窗口增速标成“同比”。

### 已确认缺口与待业务确认

- 完整 PVS 尚缺：供需比、SPR、确认币种后的推荐竞价、映射商品均价；ABA 即使采到成员级数据，簇级 Top3 聚合方法仍未验证。代码明确标 missing，见 `server/domain/market-research/keyword-rule-report.ts:98`。
- 季节性和生命周期规则固定为 unavailable，见 `keyword-rule-report.ts:88`；不能让模型补成确定结论。
- 当前 `cpc` 明确缺失，因为来源只有 recommended bid；不能把推荐竞价改名 CPC。见 `keyword-rule-report.ts:91-92,111`。
- 需业务确认：关键词池的页数/上限与去重规则、ABA reference month、簇级 ABA 聚合、供需比分母、SPR 来源、推荐竞价币种、商品均价映射、PVS 权重与门槛、象限/需求分级阈值、季节性和生命周期所需观察窗、业务综合解释是否另建模型任务。

### 后续补齐输入与验收条件

1. 输入：每个缺失指标的正式来源、原始字段、单位、币种、月份、关键词或 ASIN 映射键。验收：已知值必须附 evidence；任一输入缺失时对应分量和 PVS 保持 pending，不得填零或跨词借值。
2. 输入：业务签字的成员到簇聚合公式和 PVS 权重/阈值。验收：提供小型手算 fixture，代码结果与手算一致；单样本、全相等、部分缺失、零基线均有确定状态和说明。
3. 输入：等长窗口增速（若保留）的窗口长度、对齐规则和名称。验收：同一数据同时算出日历同比、当前月对三个月前、等长窗口增速，三者字段与标签互不混用。
4. 输入：季节性/生命周期定义及最少月份覆盖。验收：不足覆盖返回 unavailable；模型只能解释已算结果，不能自产标签。
5. 输入：综合解释引用规则。验收：结论逐条引用冻结关键词/簇/月份和规则版本，未完成指标必须在限制项中展示。

## 4. 类目买家评论见解

### 已实现

| 项目 | 已实现口径 |
|---|---|
| 输入 | 从固定商品池最多选择 20 个 ASIN；逐 ASIN 获取 Customers Say 的主题摘要字段 `keyword`、`content`、`mention`、`positive`、`negative`、更新时间。见 `server/domain/market-research/customer-themes.ts:27`、`server/services/market-customer-themes-collector.ts:81-86,236-274`。 |
| 来源范围 | ASIN 必须来自冻结商品选择；响应身份必须与请求 ASIN/站点一致；成功、空、失败、缺失分别保存。见 `market-source-step-handlers.ts:138-142`、`customer-theme-source-pool.ts:62-106`。 |
| 计算 | 代码汇总主题提及数、正/负计数、每 ASIN 与跨 ASIN topic share；分母只来自成功且有有效主题的来源。不会做逐条评论去重，也不假设正负集合互斥。见 `customer-themes.ts:140-163,177-242`。 |
| 模型 | 模型将来源主题映射/归并到中文主题组；成员覆盖、unknown、unavailable 和 reconciliation 结果均被校验并版本化。见 `customer-theme-mapping-rules.ts`、`customer-theme-reconciliation-flow.ts`。 |
| 人工节点 | 已增加不可变 selection revision：排除或恢复原样本后，从完整冻结事实过滤并重算，不重新采集或调用模型。继承原报告主题映射并明确标注；保存作者、时间、父版本和原因。历史版本只读，不覆盖旧报告。 |
| 样本展示 | 标题、供应商排名、原始顺序和 Customers Say 摘要只来自同一冻结报告的来源；未知图片保持空值，供应商排名不冒充已验证 BSR。 |

### 必须明确的来源语义

- Customers Say 是供应商返回的聚合主题摘要与计数，不是逐条评论数据。代码明确标注“source observations; not unique reviews”以及“never deduplicates reviews”，见 `server/domain/market-research/customer-themes.ts:66,159-161`。
- `positive` 与 `negative` 都只校验不超过 `mention`，两者不假设互斥；报告的 `sentimentOverlap` 固定为 `not_assumed_disjoint`，见 `customer-themes.ts:74,106-117,242`。
- 主题更新时间不能证明评论观察窗口；collector 明确把 observation period 标为 unknown，见 `server/services/market-customer-themes-collector.ts:253`。

### 已确认缺口与待业务确认

- 商品图片、父子关系与选样分数等尚缺经过验证的正式输入；已保存的标题、供应商排名、摘要已透传。
- 排除/恢复版本已完成，支持全排除的无数据状态和恢复原样本，不支持用范围外 ASIN 替补。并发修改需刷新到最新版本；旧映射在新版本中明确保留其来源，不声称重新分析语义。
- 原版 1.2 情感阈值及正负主题筛选逻辑需单独审核，不能自动恢复。需确认 `mention`、`positive`、`negative` 的供应商定义、阈值作用对象、最低样本覆盖和并列排序规则。
- 需业务确认：选样排名及父子 ASIN 粒度、最大样本数、失败 ASIN 对分母的影响、同义主题归并规则、unknown/unavailable 的展示、是否需要逐条评论证据。若需要逐条评论，这是新来源能力，不能由 Customers Say 摘要替代。

### 后续补齐输入与验收条件

1. 输入：版本化选样规则及商品元数据字段（ASIN、父子关系、标题、图片、排名、选样分数）。验收：报告列出全部入选/排除/失败 ASIN 和来源；展示元数据缺失不影响计数但必须标缺失。
2. 输入：排除与恢复操作的版本语义。验收：每次变更生成新 selection revision 和新报告，旧报告可回放；新报告仅重用范围相符的来源，不修改旧事实。
3. 输入：经业务确认的情感筛选/排序规则与阈值。验收：以边界值、正负重叠、零 mention、部分失败样本做 fixture；结果与公式一致，并明确这仍是摘要计数分析。
4. 输入：若要求逐条评论，定义评论 ID、去重键、时间窗、语言、变体范围和抽样规则。验收：每个结论能引用真实评论记录；在该来源接通前，界面不得声称“评论去重”“评论样本数”或“评论级情感”。

## 建议的 OpenSpec 分期

1. 先固化共同证据契约：字段字典、missing reason、单位/币种、来源范围、版本和历史只读行为。
2. 完成本次已批准的总览 v5 入口、独立模型身份、部分结果和历史兼容本地验收；不借此改变仍未确认的来源字段、公式或阈值。
3. 已完成形态冻结商品字段与确定性期间/年份统计；图片、毛利和退货能力另行评审。
4. 已完成关键词评分输入核对；后续每新增一个 PVS 输入先完成来源与聚合验收，再改变评分。
5. 已完成评论冻结样本元数据与排除 revision；情感阈值与逐条评论能力分别立项。

每一期都应以“输入契约 + 可复算规则 + 缺失行为 + 来源范围 + 版本回放 + 人工节点”为验收单元。未获业务确认的阈值、权重、分母和 fallback 不进入实现。
