# 四模块原版界面、分析方法与执行边界

本清单按 2026-09-16 跟进范围编写；不是先前发布的视觉验收，也不是重新启用完整 VOC 扩展。当前工作目录为 `integrate-xydc-variant-20260905`。只读原版根目录为 `C:/Users/EDY/.codex/project-notes/amazon-insights/ui-parity-20260914/reference/app`，下文「原版」路径均相对此目录；「当前」路径相对当前工作树。

## 分离原则与状态定义

原版提供布局和分析问题清单，当前后端保存的事实、范围、规则版本和模型输出具有数据权威性。原版文件不能整体搬入生产依赖图：其中存在采集、缓存、业务评分、客户端重新聚合及展示混合。

- **已映射**：当前有承担同一分析问题的结果/流程。仅表示职责对应，不表示算法、阈值、分母或结论相同。
- **缺数据**：已有字段或能力，但本次保存结果未取得、失败、不完整、单位/周期未确认；保留区块并展示具体原因。不能以 0、其他月份、其他样本代替。
- **缺能力**：当前生产契约/规则没有原版相同输出或查询能力；不是重试就一定可恢复。保留区块说明尚不支持，后续单独需求评审。

纯展示可以选择、排序、格式化已保存事实，或按明确分母展示可核对的统计；不能重新判定机会、情感、生命周期或凭图表生成业务结论。原版旧规则不能被称作当前模型的等价实现。

## 1. 市场概览

### 文件与符号对应

| 原版职责 / 文件与符号 | 当前职责 / 文件与符号 | 边界 |
| --- | --- | --- |
| `sellersprite-market-overview-section.tsx` 查询/展开，`sellersprite-market-report.tsx` 报告 | `app/market-research-section.tsx`、`app/market-overview-section.tsx` 任务与所选结果范围；`app/market-overview-report.tsx::MarketOverviewReport` 只读明细 owner | 查询/启动/重试仍走当前浏览器 API；展开已保存结果不重新分析 |
| `sellersprite-market-report.tsx` 卡片/图表/章节 | `app/market-overview-report-view.tsx::MarketOverviewReportView`，`app/market-overview-reference-sections.tsx`，`app/lib/market-overview-presentation.ts`；`app/market-overview-distributions.tsx::MarketOverviewDistributions`、`app/market-overview-distribution-chart.tsx::MarketOverviewDistributionChart` | 报告顺序、布局和空态；仅接收保存结果 |
| `sellersprite-market-report-analysis.ts::analyzeSellerSpriteMarketReport` | `server/domain/market-research/overview-expanded-catalog.ts::buildMarketOverviewExpandedCatalog`、`overview-complete-catalog.ts`；`app/market-overview-analysis.tsx::MarketOverviewAnalysis` | 后端证据目录及已保存语义解释，非复制浏览器分析 |
| `sellersprite-market-overview-synthesis.ts::buildMarketOverviewSynthesis`、`MARKET_SYNTHESIS_DIMENSIONS` | `server/domain/market-research/overview-synthesis.ts`；`server/services/market-overview-synthesis-input-service.ts::loadMarketOverviewSynthesisBasis`；`app/market-overview-synthesis.tsx::MarketOverviewSynthesis` | 原版 25/20/10/15/15/15 的六维加权分及 80/70/60/50/40 机会等级阈值不作为当前结果 |
| `sellersprite-market-price-analysis.ts::analyzePriceBands`、`priceBandOpportunityScore`、`priceBandEntryScore`、`buildPriceBandCostModel` | `server/domain/market-research/overview-distributions.ts` 保存价格分布；现有 overview synthesis 解释 | 分布与解释已映射；原版成本估计、利润阈值、进入评分无自动等价能力 |
| `api/sellersprite-market/route.ts`、`api/sellersprite-market-report/route.ts` → `lib/sellersprite-market-query.ts::fetchSellerSpriteMarketNiche/fetchSellerSpriteMarketReport` | `server/routes/market-research.ts`、`server/routes/market-modules.ts` → `server/services/market-overview-collector.ts::collectMarketOverview`、`market-overview-source-collector.ts::collectMarketOverviewSource`、`market-overview-distribution-collector.ts::collectMarketOverviewDistribution` | 原版采集和 `lib/mcp-response-cache.ts` 不进入浏览器；当前授权/供应商/快照在服务端 |

### 原版报告顺序和分析维度

| 原版章节/意图 | 当前保存依据 | 状态 / 不可替代内容 |
| --- | --- | --- |
| 市场概览：全样本、头部、新品规模/均价/销量/评分 | `shared/market-overview-report-contracts.ts` numbers/months/metrics；`sampleProducts/brands/sellers/totalUnits/totalRevenue/avgPrice/avgUnits/avgRatings/avgRating/newCount/newAvgPrice/newAvgUnits` | 已映射；字段空为缺数据；头部均价等不存在的指标为缺能力 |
| 行业需求及趋势：关键词搜索变化 | 已保存 overview evidence、analysis 与 synthesis 中的搜索需求证据 | 没有明确关键词月序列时，图表保持缺数据/未接入说明；不可把销量曲线当搜索曲线 |
| 行业销售趋势 | 相同范围完整月的 `totalUnits/totalRevenue` 和保存的分析窗口 | 已映射；周期/单位未知为缺数据；不宣称近 30 天数据 |
| 商品集中度 | `productConcentrationRaw`、现有商品相关证据 | 集中度已映射；原版完整 TopN 商品明细/份额图未返回时缺能力或缺数据，不由一个集中度生成明细 |
| 品牌集中度、卖家集中度 | `market_brand_concentration`、`market_seller_concentration` | 已映射；样本/新品分组保持源口径 |
| 卖家类型、A+视频、卖家所属地 | `market_seller_type_concentration`、`market_ebc_distribution`、`market_seller_country_distribution` | 已映射；缺数据按条目 status/issues 展示 |
| 商品需求趋势 | `market_product_demand_trend` 来源证据及语义输出 | 来源操作存在不等于已保存可直接绘图的完整序列；缺序列保留说明 |
| 上架时间、上架趋势 | `market_listing_date_distribution`、`market_listing_trend_distribution` | 已映射；不能混淆年龄分布与上架日历年分布 |
| 评分数、评分值、价格 | `market_ratings_count_distribution`、`market_rating_distribution`、`market_price_distribution` | 已映射；已确认的销量/链接/销售额份额分母不可互换 |
| 市场需求、竞争、成熟度、新品进入、产品机会、价格机会综合 | 已保存的 section analysis 和 overview synthesis | 问题已映射；原版固定分数及评级缺等价能力；不重算或伪装成当前模型分数 |

保留当前改进：所选行范围绑定、恢复 URL/历史只读读取、收起/重开复用结果、来源与单位标识、实际月份、失败/缺失项、证据引用、saved synthesis、多版本任务、请求幂等、共享收藏。

## 2. 商品形态与价格带

2026-09-24 流程校正：原版先按类目采集商品，再在 TOP 销售表逐条或批量标注形态；采集前不要求填写形态目录。当前本地规则版据此以空 `allowedLabels` 启动采集，在人工保存统计版本时把实际填写的形态名称写入该 revision 的标签与分组。未标注商品保留为未分类；未单独记录的判断依据明确标为未记录。既有带目录的任务与历史版本继续按保存内容读取，单纯查看报告不重新采集。

| 原版职责 / 文件与符号 | 当前职责 / 文件与符号 | 边界 |
| --- | --- | --- |
| `sellersprite-market-structure-section.tsx::SellerSpriteMarketStructureSection` → `sorftime-category-dashboard-view.tsx::SorftimeCategoryDashboardView` | `app/market-shape-section.tsx::MarketShapeSection` 任务/人工编辑；`app/market-shape-report.tsx::MarketShapeReport`、`market-shape-dashboard.tsx::MarketShapeDashboard`、`market-shape-product-table.tsx::MarketShapeProductTable` | 分离任务 owner 与纯报表 |
| `lib/shape-price-analysis.ts::buildShapePriceBandAnalysis/buildBrandPriceBandAnalysis/buildShapeAggregatesFromPriceBandRows` | `server/domain/market-research/shape-price.ts::analyzeShapePriceBands`；`server/services/market-shape-read-service.ts::marketShapePublicRevision` | 当前共同可比成员、保存分类、价格边界；不复制旧聚合规则 |
| `lib/shape-sales-share-analysis.ts::analyzeShapeSalesShare`、`lib/listing-age-sales-share-analysis.ts`、`lib/shape-price-band-structure-analysis.ts`、`lib/brand-price-opportunity-analysis.ts` | `server/domain/market-research/shape-structure.ts::buildMarketShapeStructure`；`app/market-shape-structure-report.tsx::MarketShapeStructureReport` | 保存品牌/年龄/价格结构的事实与分母 |
| `lib/market-structure-synthesis-analysis.ts::buildMarketStructureSynthesis`、`market-structure-synthesis-conclusion.tsx` | `server/domain/market-research/shape-explanation-catalog.ts::buildMarketShapeExplanationCatalog`、`shape-explanation-synthesis.ts`；`app/market-shape-explanation-section.tsx` 读取 owner → `market-shape-explanation-report.tsx` 展示 | 当前 scope/shape/price/brand/age/month 的证据化解释，不等价原版 heuristics |
| `api/sorftime-category-dashboard/route.ts` → `lib/sorftime-category-dashboard.server.ts::fetchSorftimeCategoryDashboard`；`api/sellersprite-shape-analysis/route.ts` → `lib/sellersprite-shape-analysis.ts::fetchSellerSpriteShapeAnalysis` | `server/services/market-product-pool-collector.ts::collectMarketProductPool`、`server/runtime/market-shape-selection-step.ts`，现有 shape flow/worker | 供应商/选样/采集由后端负责；不将原版 Top50–300 参数当当前已支持 |

| 分析维度 | 当前对应 / 状态 |
| --- | --- |
| 类目销量/销售额、Top3 Listing/品牌/卖家、自营、Top80% 价格、退货率 | 保存版本的共同可比销量趋势已映射。销售额、退货率、Top80% 等未入当前契约的字段为缺能力；不把选样销量标成全类目销量 |
| 商品表、形态销量与价格带、单链月均销量 | revision `selectedAsins/eligibleAsins/groups/bands/monthly` 已映射；未知价格/销量/月份为缺数据；完整共同成员分母保留 |
| 品牌 × 价格带、形态 × 品牌、上架年龄 | `MarketShapeStructure.segments.brands/ages` 已映射；品牌/上架日缺失及错误原因保留 |
| 历年/近 6 个月/不同时间窗口 | 当前保存实际研究月和共同成员；原版固定窗口没有被采集时缺数据，不能用现有任意窗口改名替换 |
| 利润进入判断、价格升级路线、形态机会排序 | 原版 `lib/sorftime-category-dashboard.ts::resolveSorftimeMarginEntryLabel/buildTopSalesMarginEntryConclusion` 等依赖利润字段和阈值；当前没有同义输出为缺能力。保存的解释可展示但不能声称等价 |

保留当前改进：人工形态分类/价格带确认、不可变 revision、来源策略提示、分页/列显示、共同可比范围、证据链、解释版本和失败重试。原版 `product-shape-vision.client.ts`、手工本地缓存与当前模型/人工 revision 不混用。

## 3. 流量关键词与需求

| 原版职责 / 文件与符号 | 当前职责 / 文件与符号 | 边界 |
| --- | --- | --- |
| `market-traffic-keyword-section.tsx::MarketTrafficKeywordSection`、`product-keyword-demand-report-section.tsx::AmazonKeywordDemandReportSection` | `app/market-keyword-section.tsx::MarketKeywordSection`；`market-keyword-report.tsx::MarketKeywordFactsReport/MarketKeywordRevisionReport`；`market-keyword-demand-summary.tsx::MarketKeywordDemandSummary`、`market-keyword-table.tsx::MarketKeywordTable`；`market-keyword-result-view-model.ts` | 当前 owner 保存任务/草稿；结果 view 仅使用保存 facts/catalog/ruleReport |
| `keyword-classifier.ts::classifyKeywordDetailed/classifyKeywords`、`lib/product-keyword-demand-analysis.ts::buildAmazonKeywordDemandReport` | `server/domain/market-research/keyword-reconciliation.ts`、`keyword-clusters.ts`、`keyword-rule-report.ts::buildMarketKeywordRuleReport`、`keyword-scoring.ts::scoreKeywordDemandClusters` | 原版 regex/产品家族词典不搬入；当前跨批语义归并、规则版本、人工校对为权威 |
| `api/sorftime-product-keywords/route.ts`、`trends/route.ts` → `lib/sorftime-product-keyword-search.server.ts::fetchProductKeywordSearch/fetchKeywordTrendsBatch` | `server/services/market-keyword-collector.ts::collectMarketKeywordPage/collectMarketKeywordTrend`、`market-keyword-aba-collector.ts::collectMarketKeywordAba` | 当前固定种子/页码词池、来源/月度证据；原版浏览器批量趋势补齐和 65s 重试不复制 |

| 分析维度 | 当前对应 / 状态 |
| --- | --- |
| 关键词规模、搜索量、CPC、趋势、年度搜索量 | facts 与明确月份的 saved evidence 已映射；未取得月份为缺数据；不补 0 或把不完整年当全年 |
| W1 What、W2 Who、W3 Where、W4 Which | reconciliation W1–W4 原词标签与人工 revision 已映射；未分类/未归并为缺数据。标签份额允许重叠，不解释成人口占比 |
| W5 How：同比、环比、较三个月前、季节/生命周期 | 当前 ruleReport/`keyword-comparison-months.ts` 明确基期；同比/三个月变化已映射。单月环比不得替代三个月变化。无验证诊断保持待验证 |
| 需求簇、PVS/机会评分、供需、ABA、SPR、建议竞价 | 当前 `keyword-pvs/2.0.0` 及来源证据已映射；输入缺失导致 unscored 为缺数据，不回退到原版分数 |
| 五维综合结论、开发建议和产品机会 | 保存的规则/语义结果可展示；原版正则标签和固定文本建议不是当前模型能力；没有保存结论时标明待验证 |

保留当前改进：人工分类草稿与整池保存、revision、跨批归并、明确词池覆盖、原词证据、复制/筛选/分页/列管理、历史恢复、错误重试、HTTP-safe request ID。`lib/sorftime-product-keyword-cache.ts` 的本地缓存不替代当前 run/revision 身份。

## 4. 类目评论主题

| 原版职责 / 文件与符号 | 当前职责 / 文件与符号 | 边界 |
| --- | --- | --- |
| `market-category-review-insight-section.tsx::MarketCategoryReviewInsightSection`、`category-customers-say-insight-panel.tsx::CategoryCustomersSayInsightPanel/TopicTable` | `app/market-theme-section.tsx::MarketThemeSection`；`market-theme-report.tsx::MarketThemeReport`、`market-theme-insight-panel.tsx::MarketThemeInsightPanel` 为分页读取 owner；`market-theme-result-view.tsx` 为纯表格/选择器 | 用户所选商品、已存分组与分页报告驱动结果，不重跑原版归类 |
| `lib/sorftime-category-customers-say.ts::aggregateCategoryCustomersSay`；panel 的 `buildDisplayInsight/localizeAggregatedTopics` | `server/domain/market-research/customer-themes.ts::aggregateCustomerThemes`、`customer-theme-mapping-rules.ts::calculateMarketThemeMappingRules`、`customer-theme-reconciliation.ts`；`server/services/market-theme-report-service.ts::MarketThemeReportService` | 原版按关键词小写合并/排除后重聚合/翻译/1.2 情感阈值不移植为浏览器业务规则 |
| `api/sorftime-category-customers-say/route.ts` → `lib/sorftime-category-customers-say.server.ts::fetchSorftimeCategoryCustomersSay` | `server/services/market-customer-themes-collector.ts::collectMarketCustomerThemes`；`market-theme-evidence-reader.ts::readMarketThemeEvidence` | 服务端采集、授权、源摘要和引用；不是逐条原始评论 |

| 分析维度 | 当前对应 / 状态 |
| --- | --- |
| 主题名称、提及次数/占比、覆盖 ASIN、摘要 | 保存 report/detail/evidence 已映射；整份报告分母不随分页重算；主题空/部分商品失败为缺数据 |
| 正向/负向主题两栏 | 展示已保存正负计数；同一主题可在两栏出现，不在浏览器用 1.2 阈值判定情感。当前无等价旧 sentiment 判定为缺能力 |
| 中文归类/解释和原文证据 | 当前模型/跨批归并及完整原文引用已映射；未归类保留原主题；模型失败不删除已取原文 |
| Top20/类目覆盖、单 ASIN 列表 | 当前明确请求数量、实际返回数量、不足和来源状态；不能把部分返回宣称完整 TOP20 或逐条评论覆盖 |
| 原版图片/商品标题和浏览器排除后重聚合 | 未保存元数据为缺数据/契约缺能力；排除不是改写当前保存版分母的授权，不在 view 重新汇总结论 |

保留当前改进：分页、迟到响应隔离、失败重读、attempt/reportHash 版本绑定、完整原文/字符范围引用、模型审计、unknown 分组、源覆盖与归并状态。四模块共享收藏继续使用 `app/market-shared-favorites.tsx` 和当前服务端收藏 API。

## 原版跨模块分析与静态资料

`market-research-analysis.ts::buildMarketResearchSnapshot`、`lib/market-research-unified-synthesis.ts::buildMarketResearchUnifiedSynthesis`、`lib/market-research-linkage.ts`、`market-research-unified-conclusion.tsx` 记录原版“概览→结构→关键词→主题→综合判断”的思路。当前四个模块各有保存范围和版本；不能仅凭页面相邻就把不同时间/样本拼成一份已验证综合结论。没有统一保存契约的跨模块评级为缺能力。

`sellersprite-market-overview-data.ts::sellerspriteMarketOverviewData`、原版缓存、独立预览 fixture/transport 只能用于只读比对或隔离测试，不是生产数据后备来源。示例截图和原版预览不证明当前后端支持其中的指标。

## 可执行导入边界

运行：`npx tsx --test tests/agent/market-presentation-boundary.test.ts`。

测试以真实 `app/market-research-section.tsx` 及四个任务 owner 为入口，用 TypeScript AST 解析静态 import、re-export、literal dynamic import、require 和 import-equals，再按当前 tsconfig 路径解析递归遍历本地运行时依赖。它不是只搜索禁止字符串：类型专用导入/导出不计运行时代码，混合导入中的值仍进入图，无法静态定位的动态导入直接失败。

两层约束：

1. 生产入口图不得到达 `server`、`app/api`、原版目录、tests/scripts/preview/fixture/provider/collector；外部运行时包限已审阅 React/Zod/Next 浏览器入口。每个指定纯展示文件必须确实被生产 owner 引用，避免只测孤立组件。
2. 指定纯 view（overview report view/sections/helper、shape report/dashboard/structure/table/explanation、keyword report/table/summary/rules/helper、theme result view）进一步不得到达浏览器 HTTP transport helper，或直接调用 fetch/XHR/WebSocket/EventSource。现有 read/task owner 可调用当前 transport；shared 的类型专用服务端引用不被当成浏览器执行。

边界测试保证依赖和职责边界，不证明所有内联数学都是正确业务模型，也不替代范围/未知值/只读恢复/交互回归。原版代码换名复制、别名间接调用等仍需代码审查；本次不修改 server、shared、供应商配置、数据库或只读参考目录。
