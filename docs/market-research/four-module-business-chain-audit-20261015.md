# 四模块业务链路细拆审计（2026-10-15）

本轮修复进展见 [修复与验收记录](cross-category-repair-acceptance-20261015.md)；本文保留修复前诊断证据。
后续复核：[跨类目最终检查](./cross-category-final-check-20261015.md)。六组虚拟类目与一个目录边界检查共 125 个检查点，96 符合预期、29 未通过；新增分类误判、目录套用、币种和德语识别问题。原文中的现有缺陷未因这次检查而修复。

## 范围和证据边界

本轮只检查：原始 ZIP／业务说明 → 数据来源 → 分析生成 → 保存 → 接口 → 页面。覆盖默认、人工修订、历史报告路径。没有修改业务代码，没有重新采集，没有调用供应商或翻译模型，没有发布、重启 31900 或 32900。离线集成测试使用临时 PostgreSQL 和模拟连接器，不使用业务库。

- 原始档案：`C:/Users/EDY/Desktop/Amazon-竞品数据分析-团队分享版.zip`；本轮实算 SHA256：`4a1b68549dafc3a78cc92df7fb9b0bae084c847c9825b742ce82d1f47be20b9f`。
- 核对工作树：`C:/Users/EDY/.codex/worktrees/market-research-favorites-v2/feat-voc-positioning-skill-execution`，HEAD `bcef3037`。
- 本轮只读 `/api/health`：32900 为 `38cfa257c529cfb68a86d572c236af40367e7ba0`，hash `bf8fce4caa3c2164ace8aa6f1b861f1627079a9415dcf186cefc4e448cb0a360`；31900 为 `253366e876728a6c9bc35bb9dda2c1b00575b87c`，hash `bb59d5e09647dd760c26f5d3f8b299a50cc05e71667354232ea304aba7fd0862`。
- 浏览器实际只读核对：US／Floor Lamps／节点 `228013:495224:3736561:1063294`／2026-09。
- 总览任务 `a9eaaf04-9acd-4978-9428-73f7ac251a03`；形态任务 `4e32df59-8e19-4d51-bb52-8fd1a10b9aee`；关键词任务 `360a350e-0d52-4758-9ab4-2af79592933a`；评论任务 `a389e6b7-819f-4763-bdb7-18717f206931`。
- 生产历史人工修订未新建、未覆盖。人工分支以代码追踪、SSR 虚拟数据复现和临时数据库测试验证；不能把它描述为所有组织、站点、历史版本均完成真实验收。

证据级别：**页面**＝32900 已显示；**源码**＝可到达的调用链；**复现**＝虚拟输入复现输出；**风险**＝结构缺口已定位，但未证明某份生产报告已经受损。

## 1. 结果与优先级

P1：优先修复，会漏掉已有结论、给出错误业务判断或混淆版本。P2：输出完整性、状态说明、回归和文档缺口。没有发现需要立即停服的 P0。

| ID | 优先级 | 问题 | 影响、证据和触发条件 |
|---|---|---|---|
| O-01 | P1 | 评分数图表总结把高 Review 档算成低 Review | 页面综合结论写 Review＜300 销量约 **5.2%**、门槛偏高；评分数图表写低 Review 约 **83.8%**、新品易进入。`reviewConclusion` 的正则把以 `50`、`100` 开头的 `500–1000`、`1000以上` 也匹配进低档。虚拟输入低档 5%、高档 95%，实际输出低档 **100%**。见下文证据 O1。 |
| T-01 | P1 | 评论人工修订后，主题译文可能错配 | 移除 ASIN 会按提及数重新排序并重新编号主题；翻译仍按基准报告 `group:序号:label` 取值。复现：删除 Assembly 所属 ASIN 后，Brightness 从序号 1 变成 0，页面错误显示德语 Montage（组装）。正文按 sourceThemeId 绑定，在该复现中仍正确。需修复主题标签／定义的稳定身份绑定，不必重采评论。 |
| K-01 | P1 | 关键词人工版主动隐藏完整综合分析 | 后端人工修订结果已包含 synthesis 和 14 项业务输出，组件却用 `!manual` 隐藏整个 ArchiveDemandSummary。因此人工版缺综合标题、W1–W5 完整叙述、14 项业务输出与其内需求簇；评分／开发方向仍存在。默认与人工历史版不等价。 |
| S-01 | P1 | 新版形态缺冻结修订的页面回放入口 | `referenceHistory !== undefined` 走自动草稿页面；旧版“形态报告版本”选择器只存在另一分支。新版从任务来源加当前个人／站点／类目草稿重算，草稿键不含 run、月份。存储和读取冻结修订的能力存在，但查看旧任务不能保证回到当时人工标注和结论。此为已确认接线缺口与回放风险，不等于数据库历史已丢失。 |
| O-02 | P2 | 原版 A+／视频的独立“机会点分析”未完整接入 | ZIP 的章节结构除三段解释外还有 opportunity；原版 A+ 章节实际给出内容覆盖、缺口、低内容高销量等机会判断。当前契约无该字段，页面只有三段，A+ 结论复用总体 newEntry，不能替代原本独立机会分析。 |
| O-03 | P2 | 图表总结“依据充分”判定弱于业务所需字段 | 商品需求仅有浏览趋势、退货率和搜索购买比均未知时，仍返回 status=ready、missing=[]，前端显示“依据充分”。虚拟输入已复现。总览、集中度等章节也使用各自宽松存在性判断，需逐章列出必需字段，不能只判断有行／有曲线。 |
| K-02 | P2 | 不带 originalEstimate 的旧／模型分支综合结论降级 | 有事实但缺兼容 estimate 时走 MarketKeywordDemandSummary；只显示“综合结论尚未提供”或需求簇条数，缺完整业务输出与开发方向。服务端目前仅 skipped 规则默认分支生成 automaticClassification/estimate；人工另行生成。需兼容既有分类和事实，不能直接拿当前自动分类替换历史模型判断。 |
| H-01 | P2 | 派生结论不是所有情况下都随历史报告冻结 | 总览 chapterSynthesis 在读取时按当前代码重算，位于 numbers，未纳入 reportHash；关键词 originalEstimate 也在读取时由事实／修订重算。已有输入和部分评分版本保护，但历史文字规则改变仍可能改变展示。应区分“原保存结果”与“按新规则重算”，记录派生规则版本或持久化结论。尚未证明历史样本已被实际改写。 |
| Q-01 | P2 | 回归测试缺关键分支，旧模拟响应过时 | 现有测试通过不覆盖 O-01／T-01／K-01。旧评论兼容测试 rules-v3 返回 category_report 风格对象给 category_products，触发 invalid-data，根本未到报告读取。只在临时副本改为该操作的数组响应后，v1/v2/rules-v3 全通过。业务测试文件本轮未修改。 |
| D-01 | P2 | 旧流程图和旧核对文档仍包含已过时的缺失描述 | `market-business-flow-20261015.md:66-84` 仍描述缺数据走简化汇总，底部又追加新版逐维结论；旧 ZIP 核对文档开头还引用旧部署和旧标题。需要统一现状图与历史记录，不能继续拿旧段落判定当前页面缺失。 |

### 不应误判为回归遗漏的项目

- **形态最终结论已接上**：本轮 32900 实见“类目商品链接调研 · 最终结论”、总体判断、4 项核心指标、5 个分析维度、机会和风险。数据不足时只暂停相应评分／总分，各维有证据内容继续展示。
- **关键词默认版有总结和开发建议**：本轮实见 W1–W5、综合、14 项业务输出、需求簇；评分与开发建议位于折叠区域。人工版缺失另列 K-01。
- **评论摘要存在**：主题行有来源摘要，样本 ASIN 表有 Customers Say 总览摘要。它们不是整个类目的开发结论，也不是原始逐条评论。
- **评论类目级执行摘要／最终开品结论**：本页当前没有，ZIP 原页面也没有。完整 VOC skill 的七段交付包含它们，但属于另外的完整 VOC 工作流；应列为“待确认业务扩展边界”，不能说成拆架构时确定漏迁了两个现成 UI。
- **跨四模块统一结论**：ZIP 有定义文件，但未找到页面调用；不能因文件存在就宣称原版已经上线。
- 17/20 评论、关键词参考月无搜索量、形态个别历史月缺失是来源覆盖问题；本轮没有补造数据，也不把它们全部计为组件缺失。

## 2. 原版和业务说明基线

下列 ZIP 路径是档案内部路径，不是当前代码。本轮直接读取 ZIP，并将所需 TS/TSX 规范化换行到 `.runtime/four-module-zip-audit/` 用于定位。

| 模块 | 原版实现证据 | 业务说明与要求 |
|---|---|---|
| 总览 | `app/sellersprite-market-report.tsx` 的 ReportSection；`app/lib/sellersprite-market-report-analysis.ts`、`sellersprite-market-overview-synthesis.ts` | `亚马逊市场总览综合分析规则.md:917` 起；`.cursor/skills/amazon-market-overview-synthesis/SKILL.md:925-1035`：综合结论、机会风险、最终一句话，不能仅串联各模块数据。 |
| 形态 | `app/market-research-section.tsx`；listing-age、shape-sales、shape-price、brand-price、market-structure 的 analysis/conclusion 组件 | `.cursor/skills/analyze-amazon-shape-price-band/SKILL.md:8,31-51`：人工形态、历史销量，四步结构，主流带→变化→效率→开发方向。 |
| 关键词 | `app/market-traffic-keyword-section.tsx:910` 调用需求报告；`product-keyword-demand-report-section.tsx:139-157` 综合、五维、需求簇 | `.cursor/skills/amazon-keyword-demand-analysis/SKILL.md:145` 开发方向；`analyze-amazon-keyword-demand/SKILL.md:131-151` 固定输出、12 语义维度、总体结论、研究优先级。五维、词义分类和业务输出是不同层级，不能仅有分类标签就视为全部满足。 |
| 评论 | `category-customers-say-insight-panel.tsx`：主题“评论摘要”和样本“总览摘要”；`market-category-review-insight-section.tsx` | `amazon-voc-insight/SKILL.md:157-163` 的执行摘要和开品结论属于完整 VOC 七段交付。未发现这七段与当前类目 Customers Say 页面之间已有调用链。 |

## 3. 五层链路逐项核对

### 3.1 市场总览

| 层 | 已核对链路 | 结论／边界 |
|---|---|---|
| 来源 | `overview-flow.ts:34` 按月份规划；`shared/market-overview-distribution-contracts.ts:6-10,35-39` 定义 research/statistics、价格、评分数、星级、上架时间／趋势、品牌／卖家／类型／国家、A+、需求趋势、商品集中度 | 来源按组织、研究、站点、类目、月份、币种和请求身份校验；行业需求及外部趋势单独绑定，不把关键词页的另一个报告随意混入。 |
| 补充来源 | `market-overview-industry-demand-step.ts`；`market-overview-external-collector.ts:43` 的 Sorftime category_trend 和 SellerSprite competitor_lookup | 行业搜索／销量／金额／毛利是独立证据维度；缺失应保留，不能靠总览主指标推成完整。 |
| 分析 | `overview-original-synthesis.ts` 适配原版六维综合；章节解释另由 buildChapterExplanations 生成；模型版另有 synthesis/report step | 六维综合已接；章节解释不是原版 report-analysis 的完整复用，O-01/O-02/O-03 即发生于这层。 |
| 保存 | `market-module-execution-store.ts:109,184` 保存 step/attempt；`market-analysis-snapshot-store.ts` 保存输入与目录；reader 核验来源、catalog、attempt、hash | 来源和执行结果可追溯；派生章节在 read 时重算，见 H-01。 |
| 接口 | `server/routes/market-modules.ts:41,53-56`：`GET overview/saved`；`POST studies/:id/overview`；`GET runs/:id/overview`；`GET runs/:id/reports/:attemptId/overview` | 查询、启动、指定历史 attempt 分开；本轮只使用已保存读取。 |
| 页面 | `market-overview-report-view.tsx` 分规则综合／保存模型综合；`market-overview-reference-sections.tsx:19-27,107` 展示 15 区及解释 | 页面 15 区齐备；齐备不代表章节判断准确。真实页面已验证 O-01 的矛盾。 |

15 区清单：市场概览、行业需求及趋势、行业销售趋势、商品集中度、品牌集中度、卖家集中度、卖家类型、A+ 视频、卖家所在地、商品需求趋势、上架时间、上架趋势、评分数、评分值、价格分布。结构均有入口；重点差异为 A+ 独立机会段缺失、评分数误判、字段不齐却 ready。

人工分支：没有找到与关键词一样的“人工改写综合文字并保存版本”入口。评分规则复核是规则版本切换，不能算人工结论版本；本轮不把不存在的通用人工编辑能力认定为原版必需功能。

### 3.2 商品形态及价格带

| 层 | 已核对链路 | 结论／边界 |
|---|---|---|
| 来源 | `market-shape-sorftime-pool.ts:30,63`：category_products，兼容 category_report，分页 product_search；`market-product-history-collector.ts:114-137`：product_trend 的 SalesVolume／SalesAmount；`market-shape-category-collector.ts:46`：category_report/category_trend | 商品池、销量、金额、类目趋势分开保存；空值不自动补零。 |
| 分析 | `market-shape-reference-panel.tsx:49,94` → adapter → `view.tsx:104-105,139` → available-conclusions / synthesis-presentation | 按有效数据池分别分析，人工纳入／形态立即影响统计。局部筛选结论与全局最终结论范围应分别看标题和说明。 |
| 保存 | `market-shape-draft-store.ts:37,54-62` 保存当前草稿和幂等回执；`market-shape-reference-revision-store.ts` 保存 revision_json/hash、binding_json/hash | 当前草稿和冻结历史是两套对象；有保存不代表已经连到历史 UI，见 S-01。 |
| 接口 | `market-modules.ts:39,46,48-52` 查询、启动、读取、draft GET/PUT、revisions；前端 `readShapeReferenceRevision` 区分冻结参考修订 | 新旧 flow 分流存在；readReferenceRevision 目前主要用于无草稿时迁移个人最新旧修订。 |
| 页面 | `market-shape-section.tsx:308-324` 分支；`market-shape-reference/view.tsx:159` 起 | 实见七区，最终结论正常出现；新版缺修订版本选择，旧版才有版本控件。 |

七区与总结逐项：①类目销量看板（图表/指标）；②TOP 商品、人工形态、毛利准入结论；③上架年份、新品准入结论；④形态销量份额、上升/下降与切入建议；⑤形态价格四步分析与开发方向；⑥品牌价格机会、置信度、TOP10 品牌布局；⑦完整五维最终结论。上述结构本轮均在当前源码和 32900 找到，不再列为遗漏。

真实报告的有效样本分母不同：上架／品牌分析显示 94 条有效链接，形态份额分支显示 93 条，页面明确声明范围；最终综合仍保留缺 1 条近 3 月销量、总分不可计算。不能用分母不同直接判断丢商品，也不能用已知部分计算满分。

### 3.3 类目关键词洞察

| 层 | 已核对链路 | 结论／边界 |
|---|---|---|
| 来源 | `market-keyword-collector.ts:19,157,237`：Sorftime keyword_extends + keyword_trend；`market-keyword-aba-collector.ts:19-26`：SIF market_get_keyword_history，最多 10 词一批 | 扩展页量与参考月量不是同一个指标；SIF 补充目前明确限制 US，其他站点不能假装已有相同补充来源。 |
| 分析 | 冻结 facts → 默认词典分类／模型 reconciliation／人工分类 → rule report → original estimate | `market-module-service.ts:198-218` 明确显示默认 skipped 和人工均可生成估算分析；模型／部分旧版路径未统一。 |
| 保存 | `market-keyword-revision-store.ts:74` 保存 catalog_json/hash、父版本、修订号、幂等键；事实与分类身份绑定 | 人工修订不是覆盖原始事实。估算结果读取时重算，注意 H-01。 |
| 接口 | `market-modules.ts:37,42-45` query、start、read、revision save/read | 后端人工结果已返回完整分析；K-01 是前端隐藏，不是需要再次调用 MCP。 |
| 页面 | `market-keyword-report.tsx:101-105,123-143` 身份匹配后选组件；`market-keyword-original-estimate-report.tsx:180-224` | 默认完整；人工 `!manual` 抑制完整综合；缺 estimate 降级摘要。默认、人工、旧版必须分别验收。 |

输出清单：原词与来源指标、W1 产品、W2 人群、W3 场景、W4 属性、W5 变化、五维综合、需求簇、14 项业务输出、估算评分、6 个开发验证方向、验证优先级。默认都有相应位置，人工漏掉整段，旧分支有降级。

W2 无命中时当前明确“证据不足”，不再强行推断年龄／性别。估算分、P0–P3 研究优先级、最终立项决策不能混为一谈。

### 3.4 类目买家评论见解

| 层 | 已核对链路 | 结论／边界 |
|---|---|---|
| 来源 | 当前 Sorftime 商品池选样 → `market-customer-themes-collector.ts:47,121-122` product_customers_say；旧 flow 兼容 SellerSprite 商品池 | Customers Say 是采集当时主题，不是按所选历史月份返回的逐条评论。原始 customer_say 总览摘要和主题 content 都保留来源。 |
| 分析 | `customer-theme-flow.ts` → snapshot/rules/report；原版规则同名归并、1.2 倍正负阈值；模型版保留分类／reconciliation状态 | 不把主题提及率当独立评论发生率；异常主题隔离不污染有效分母。 |
| 保存 | attempt + input snapshot；`market-theme-selection-store.ts:63` 冻结 facts_json/hash、revision_json、base_attempt、父修订 | 移除／恢复用冻结事实重算，不补位、不重新采集。 |
| 接口 | `market-modules.ts:58-76` 任务、details、evidence、translations；`market-theme-selection.ts:24` 基准／样本修订读写 | `market-theme-report-service.ts:31-52` 核验 attempt、report、snapshot；译文按报告身份持久化并有文本缓存。 |
| 页面 | `market-theme-section.tsx:138,163` 选报告；`market-theme-insight-panel.tsx:51-90` 选样本修订；`market-theme-result-view.tsx:36-61` 两种摘要 | 基准、人工、历史入口都有；T-01 是样本修订组序号与基准翻译身份不一致。 |

输出清单：正面主题、负面／分歧主题、主题提及占比、覆盖 ASIN、主题评论摘要、样本 ASIN 总览摘要、异常/失败说明、分页完整证据、原文/译文、报告版本、样本版本。当前链路均存在。首页最多 12 组、每组 3 条不同摘要是明确标注的展示上限，不能称为源数据被删掉；完整证据另有入口。

## 4. 默认／人工／历史分支矩阵

| 模块 | 默认 | 人工修订 | 历史报告 |
|---|---|---|---|
| 总览 | 六维+15章可见；O-01/O-02/O-03 | 未提供通用人工改写结论；规则复核另算 | attempt读取和绑定检查存在；章节按当前代码派生，H-01 |
| 形态 | 七区+完整最终结论可见 | 草稿自动保存、各区重算；源码及现有测试覆盖 | 旧 flow 有版本选择；新 reference flow 无冻结修订选择，S-01 |
| 关键词 | 规则版完整，可见开发建议折叠入口 | 完整 payload 到前端后被隐藏，K-01 | 修订身份校验存在；人工历史仍受 K-01，缺 estimate 受 K-02 |
| 评论 | 两种摘要、正负面、缺口可见 | 冻结样本删/恢复重算；译文组号错配 T-01 | 报告 attempt 和样本 revision 分层选择；修正临时测试夹具后旧 envelope 校验通过 |

以上是分支审计覆盖，不表示对所有已存历史记录逐份跑过浏览器验收。

## 5. 重点缺陷证据与建议验收条件

### O1：高 Review 被误归低档（已复现）

- `server/domain/market-research/overview-original-synthesis.ts:102-108`：`/^(?:<|＜)?\s*(?:50|100)|50-100|100-300/` 无完整区间边界。
- `app/market-overview-reference-sections.tsx:19-27` 原样显示章节 conclusion。
- `.runtime/audit-overview-chapters.ts`：5% 的 `100-300` + 80% 的 `500-1000` + 15% 的 `1000以上`，输出低 Review 100.0%。
- `.runtime/chain-overview-dom-20261015.txt`：真实同一报告 5.2% vs 83.8% 的矛盾。
- 后续验收：规范解析区间上下界；开放区间、中文“以上”、单位、缺份额都测试；图表与综合同一阈值必须引用同一证据池。

### T1：修订主题的翻译身份漂移（已复现）

- `server/domain/market-research/customer-themes.ts:239-241` 按提及数排序。
- `server/domain/market-research/customer-theme-selection.ts:40-46` 重新 map index。
- `server/services/market-theme-translation.ts:31-45` 基准 aggregation 按 index 生成 itemId。
- `app/market-theme-insight-panel.tsx:46,51-56` 合用基准译文和修订 groups；`market-theme-result-view.tsx:44` 按 group.index 取译文。
- `.runtime/audit-theme-translation-revision.tsx` / `.log`：baseline assembly=0、brightness=1；修订 brightness=0；renderedAssemblyTranslationForBrightness=true。
- 后续验收：稳定 groupId／原文 hash 与修订身份校验；有映射和无映射两类主题；移除、恢复、历史切换和翻译完成回调都不能串组。正文目前按 sourceThemeId，不应无故清空或重译全部缓存。

### K1/K2：后端有，人工页面不显示；旧版兼容不足（已复现）

- `market-module-service.ts:211,218` 返回人工 estimate；`market-keyword-original-estimate-report.tsx:210` 的 `!manual` 隐藏完整摘要。
- `.runtime/check-keyword-summary-branches.tsx` / `.runtime/audit-keyword-branches.log`：默认综合=true、14项=true、开发=true；人工综合=false、14项=false、开发=true；人工 payload synthesis=true、businessOutputs=14；无 estimate 走占位。
- 后续验收：人工新修订和历史修订显示自己的综合与建议，factsId/revisionId 不匹配仍拒绝；不能展示默认自动版冒充人工版。

### S1/H1：历史需要冻结结果与当前工作草稿分开（已定位）

- `market-shape-section.tsx:308` 与 `:322` 分属互斥分支。
- `market-shape-reference-panel.tsx:49,60-66,94` 以当前 run 来源+远程草稿生成；仅空草稿时从本人最新参考修订恢复。
- `market-shape-draft-store.ts:37` 键含组织、用户、站点、类目，不含时间／任务。这是复用草稿设计，本身不应删除；缺的是显式历史视图。
- `market-overview-report-reader.ts:125-126` 派生 chapterSynthesis 到 numbers；关键词 estimate 同样即时派生。
- 后续验收：历史视图固定来源 attempt、修订 id、规则版本；显示明确版本标识；恢复历史到工作草稿应是单独动作，默认查看不覆盖当前草稿。用 A→修改为 B→打开 A 的用例验证，而非只测表里有 revision。

### O2/O3：章节机会段和证据充分性（已定位／复现）

- ZIP `sellersprite-market-report.tsx:1969-1995` 的 opportunity 渲染，`sellersprite-market-report-analysis.ts:151-215,332-344` 的 A+ 独立机会分析。
- 当前 `shared/market-overview-original-synthesis.ts:9-11` 无 opportunity；`overview-original-synthesis.ts:152` 附近复用 original.sections.newEntry。
- 同文件 `withData` 只由 hasData/missing 决定状态；商品需求只按 pageViews 检查 missing。
- 虚拟数据：2 个月浏览量，退货率／转化率未知，仍 ready/missing=[]；不能等同充分。
- 后续验收：恢复原版有依据的机会维度，缺字段逐项标注；不要照搬原版部分无条件乐观文案；用不同缺字段组合验证每一章，而非只断言有 15 个标题。

## 6. 本轮验证记录

| 项目 | 结果 | 证据 |
|---|---|---|
| 32900 四个指定保存任务 | 全部实际打开并读取页面；没有点击采集或翻译 | `.runtime/chain-{overview,shape,keyword,theme}-dom-20261015.txt` |
| 默认／人工／无 estimate 关键词 SSR | 复现 K-01/K-02 | `audit-keyword-branches.log` |
| 评论人工修订与旧译文 SSR | 复现 T-01，亮度正文保留，标签错配 | `audit-theme-translation-revision.log` |
| 总览区间与缺字段虚拟输入 | 复现 O-01/O-03 | `audit-overview-chapters.log` |
| UI 现有用例 | **45 passed，0 failed** | `.runtime/four-module-chain-ui-tests.log`；keyword-original-estimate-view、shape-reference-conclusions、shape-reference-view |
| 服务端／纯规则现有用例 | **37 passed，0 failed，1 skipped** | `.runtime/four-module-chain-server-tests.log`；overview-original-synthesis、synthesis-identity、binding-read、shape-draft-browser、keyword-original-estimate、theme-selection、theme-report |
| 原始旧评论报告测试 | v1/v2通过，rules-v3 在采样阶段失败 | `.runtime/audit-theme-legacy-diagnostic.log`；假连接器返回格式与 category_products 不符 |
| 临时修正模拟响应后重试 | **4 passed（含父用例），0 failed** | `.runtime/audit-theme-legacy-corrected-fixture.log`；仅改 `.runtime` 副本；验证读取历史未新增来源／模型任务 |

最初把 UI 测试与 server-only 测试统一加 react-server 条件，导致三个 UI 文件加载错误；已拆开运行，以上 45 项为正确环境结果。服务端跳过项要求本地保存实数响应及原版夹具，不能记作已通过。当前测试通过只证明已覆盖的断言，不否定本轮新增复现。

未执行：真实人工写入、批量改历史、跨所有站点全量验收、消耗 MCP 的缺口重采、模型翻译、任何部署。

## 7. 后续修复顺序（本轮未实施）

1. 先修 O-01、T-01：纠正错误业务判断和译文错配，加针对性回归。
2. 修 K-01、S-01：补人工综合展示、冻结历史入口，保证保存和查看的是同一版本。
3. 修 O-02/O-03/K-02：补章节机会分析与旧版完整输出，逐字段标注缺口。
4. 收敛 H-01 的派生版本策略，修 Q-01 测试夹具与断言，统一 D-01 业务图。
5. 评论类目级开发结论另立需求边界：若要纳入本页，应新增完整的证据→生成→保存→接口→页面链，不能以主题摘要拼接冒充完整 VOC 开品结论。

修复后仍先在 32900 验收。本轮结论不构成发布 31900 的验收通过。
