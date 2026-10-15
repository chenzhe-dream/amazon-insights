# 原始 ZIP 与 32900 业务输出核对

核对日期：2026-10-15。范围：市场调研四个子模块；重点为商品形态及价格带。只读页面、源码、ZIP 和定向测试，未采集供应商、未修改报告或标注、未发布或重启 31900/32900。

## 证据身份

- 原始 ZIP：`C:/Users/EDY/Desktop/Amazon-竞品数据分析-团队分享版.zip`。
- SHA256：`4a1b68549dafc3a78cc92df7fb9b0bae084c847c9825b742ce82d1f47be20b9f`。直接读取 ZIP，不将旧提取目录当成相同版本。
- 32900 `/api/health` 与 32901 `/health` 均为 `9f5306509a1a120467be5c96931b0545d0cec0c3`，hash `6503c5dc3d598b0c09817fb145c0fc1e33c0f5e5a613ba96cfe86419884e1beb`。
- 31901 只读身份仍为 `253366e876728a6c9bc35bb9dda2c1b00575b87c`，未发布。
- 起始 Chrome 标签 171318121：`themeView=shapes`，类目为空、无 `shapeRun`，只有 `themeRun` 和收藏参数；实际显示“等待指定类目节点”。它不是一个已打开的形态报告。
- 随后在独立标签读取已知历史形态任务 `4e32df59-8e19-4d51-bb52-8fd1a10b9aee`：US、Floor Lamps、节点 1063294、2026-09、100 件。未点击筛选、重新采集或编辑。
- 页面证据：`.runtime/shape-original-conclusion-audit-20261015.png`。这是当前真实保存报告，不是模拟图。

## 最终结论有没有接上

**原版规则已经接上；当前报告因缺数据没有生成五维评分。**

真实页面七区均可见，底部标题变成“市场结构综合结论”，徽标为“综合结论待补数据”，原因是：`B0GQTGDTF9 缺少 近6个月 销量，当前结论数据不足`。页面仍展示 100 个商品、毛利分布和已知汇总。该提示是当前首先命中的缺口，不代表全报告只有这一项缺口。

当前链路：

`MarketShapeSection` → `referenceHistory !== undefined` → `MarketShapeReferencePanel` → `MarketShapeReferenceView` → `buildReferenceConclusions` → 数据条件通过时 `buildMarketStructureSynthesis` → `ReferenceSynthesisConclusion embedded`。

关键文件：
- `app/market-shape-section.tsx:308`：新版/旧版分流。
- `server/services/market-shape-read-service.ts:103` 附近：Sorftime flow 返回 referenceHistory/referenceRevision。
- `app/market-shape-reference-panel.tsx:49,108`：已保存来源与修订转换成报告。
- `app/market-shape-reference/view.tsx:102,216-220`：构建结论及底部展示。
- `app/market-shape-reference/conclusions/index.ts:38-46,126-130`：逐商品检查必需周期，再决定 ready/insufficient。

旧任务另一条链是 `MarketShapeReport` → `MarketShapeFinalConclusion`（保存的结构解释），不应与原版五维规则混称。只有读取当前任务并确认展示分支，才能判定具体页面。

### 与原版计算文件的核对

去除 CR 换行差异后：
- 形态销量、形态价格结构、上架年龄三个分析文件与 ZIP 相同。
- 综合分析文件只有结果版本字面量 1.0.0→2.0.0、缺毛利由 Number(null) 改为 NaN 两处差异；主要评分规则保留。
- 品牌分析的年度缺失从 0 改为 null。
- 外层适配增加范围、缺失周期、上市日期及毛利校验，因此不能声称输出与原版所有输入情形完全一致。

## 商品形态七区及子输出对照

| 原版业务区 | 当前接线 | 当前真实报告 | 差异类型 |
|---|---|---|---|
| 类目销量看板、销量/金额、三类集中趋势 | ReferenceView、CategoryComboChart、MonopolyTrendChart | 已显示；平均/中位价等未知有原因入口 | 来源缺口，不是整区遗漏 |
| TOP销售、图片、趋势、人工形态、毛利准入 | TOP表、ProductTrend、ReferenceMarginConclusion | 100件；毛利分布可见，准入结论因近6月缺口受阻 | 子输出遗漏见 S-01 |
| 上架年份分析与新品准入结论 | 年份表及 ReferenceListingYearConclusion | 表存在，结论受缺口限制 | 数据条件 |
| 形态销量占比、趋势、优先级 | 表、MetricBars、ReferenceShapeSalesConclusion | 表存在，结论受缺口限制 | 展示简化见 S-04 |
| 形态×价格带、结构分析和开发方向 | ShapePriceBandTable、ReferenceShapePriceConclusion | 表存在，结论受缺口限制 | 已接线，不能把无结论判为丢模块 |
| 品牌×价格带与品牌布局 | AggregateTable、ReferenceBrandPriceConclusion | 表存在，结论受缺口限制 | TOP10品牌布局遗漏见 S-02 |
| 类目商品链接调研·最终结论 | 更名“市场结构综合结论”，内部五维规则 | 已显示缺口卡，未生成评分 | 子输出遗漏见 S-01/S-03，名称映射须明确 |

## 已确认的遗漏与差异

### S-01：形态×价格带毛利准入详情未渲染（业务输出遗漏）

ZIP `sorftime-category-dashboard-view.tsx:369` 和 `market-structure-synthesis-conclusion.tsx:16-54` 调用 `MarginShapeGuideCardList`；综合结论还展示按近6月销量的准入标签占比、优先+建议比例、可进入空间、链接口径及形态价格带指导。

当前 `conclusions/view.tsx` 的 ReferenceMarginConclusion 保留总体毛利卡和建议，ReferenceSynthesisConclusion 对 marginAccessDetail 仅输出 headline；没有渲染 shapeGuides、salesShareByLabel、accessibleSalesPct 等结构明细。总体标签数量不等于上述按销量的业务输出。

### S-02：TOP10品牌布局表未渲染（业务输出遗漏）

ZIP `brand-price-band-analysis-section.tsx:346` 实际调用 `BrandPriceOpportunityConclusion`；后者第72-95行展示近6月 TOP10 品牌的销量、份额、链接数、商品形态、价格带布局、布局类型。

当前 ReferenceBrandPriceConclusion 展示价格带机会卡和行动/风险，没有消费 result.brands 对应的 TOP10 布局表。品牌×价格带原始统计表不能替代布局类型与跨形态布局总结。

### S-03：嵌入模式漏掉综合结论置信度（展示遗漏）

ZIP 综合结论徽标包含样本范围、分数、置信度。当前置信度仍只写在非 embedded 的 LaunchSection badge；实际 ReferenceView 使用 embedded，并用“规则结论已生成”替代外层徽标。因此即使数据齐全，综合置信度也不会显示。品牌机会结论的外层置信度存在相同嵌入隐藏问题。

### S-04：形态上升/下滑分组被简化（呈现差异）

ZIP `shape-sales-share-conclusion.tsx:78-105` 有近6月占比、上升趋势、下滑趋势三个分组。当前保留表、条形图、逐形态 trendLabel/recommendation，没有原版两组单独清单。不能称趋势算法完全丢失；是否恢复独立分组应与 S-01/S-02 的真实遗漏分开。

### S-05：数据门槛是整组阻断，且只报首个缺口（鲁棒性/可解释性问题）

missingSales 发现一个商品缺必需周期即返回；同一近6月缺口可同时阻断毛利准入、年份、形态销量、形态价格、品牌价格和综合结论。当前样本确实触发此路径。

不应偷偷排除该商品、更换分母或补0。后续可先列全缺口和受影响维度，再评估有明确覆盖率的部分结论；这需要明确规则与版本，本轮未修改。

## 其余三模块的源码级对照

以下是直接 ZIP 与当前入口/组件的业务区核对，不等于本轮对每个交互重新做完整浏览器验收。

| 模块 | ZIP实际页面业务块 | 当前接线与结论 |
|---|---|---|
| 市场总览 | 15章节：概览、需求趋势、销售趋势、商品/品牌/卖家集中度、卖家类型、A+视频、所属地、商品需求、上架时间/趋势、评分数/值、价格；概览内综合评分/雷达 | MarketOverviewReferenceSections、MarketOverviewOriginalSummary 已接线。当前已有 MarketOverviewDemandTrend 和 industryDemand 保存合同/flow；不能继续沿用9月旧文档称“需求趋势尚未接入”。旧任务未采集该阶段仍可为空，不能当新功能丢失。 |
| 关键词 | 原词表/趋势、分类说明、W1-W5、综合结论、需求簇；原版估算逻辑 | MarketKeywordReport → OriginalEstimateReport 或 DemandSummary，五维和需求簇已接；当前另有14项业务输出、折叠评分/开发建议/验证优先级。供需比、SPR等真实输入的缺证不等于没有组件；估算与严格报告须区分，历史分支可能展示待验证。 |
| 买家评论 | CategoryCustomersSayInsightPanel：主题正负分栏、聚合、样本链接及移除/恢复 | MarketThemeInsightPanel、TopicTable、SampleTable、selection版本已接；按报告国家翻译属后续扩展。17/20是已保存来源覆盖缺口，本轮未补采。 |

边界：ZIP 的 MarketResearchUnifiedConclusion 虽有文件和“类目综合结论”文案，但在 ZIP app TSX 中没有调用方（只有组件定义），因此不把跨模块统一结论列为“原版页面拆分遗漏”。原版组件目录不是全部都已启用的业务流程。

## 流程图与验证

完整业务图见 [market-business-flow-20261015.md](market-business-flow-20261015.md)，同时标明来源、规则、原版子输出、缺口、历史分流，避免只画技术调度。

执行 `npx tsx --test tests/agent/market-shape-reference-conclusions.test.ts tests/agent/market-shape-reference-view.test.tsx`：33通过、0失败、0跳过，日志 `.runtime/shape-business-audit-tests-20261015.log`。这些测试证明现有规则/七区行为，**不证明 S-01/S-02/S-03 不存在**，目前断言没有覆盖所有原版子输出。

本轮仅补文档和流程图，没有把以上遗漏算成修复完成。建议下一步先补 S-01/S-02/S-03 的展示与针对性回归，再处理 S-05 的缺口汇总；保持来源与分母不变。
