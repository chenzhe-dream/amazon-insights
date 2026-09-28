# 模块一字段与行业需求趋势区域3

前一区域已获用户确认。此区域按原版能力补齐 A4 -> A5；原版总结 A3 在后一区域，外部商品需求空响应 A6 独立处理。

- [x] A4：对照原版 mapNiche 和三张 KPI 卡片，将已保存来源的 BSR、重量体积、头部与新品指标接回；字段保留来源和单位，按冻结 headTopN/newProductMonths 取值。历史报告摘要、快照和语义输入不改写，只增加只读展示投影。
- [x] A5：总览新版本拥有独立的行业关键词趋势链路。Sorftime 类目关键词前2页，原版过滤选择最多5词，SellerSprite keyword_research 补足，再 aba_research_trend 按月取 searches。原版 category seed 缺失时使用 product_node 查询名称，不把数字类目当关键词。
- [x] 保存与失败：新增版本化步骤，绑定本次类目/站点/报告；每次来源保留原响应与时间，成功/空/失败分别展示，基础报告保留；GET 只读，旧版本不暗中采集，不混用模块三任务。
- [x] UI：保留已验收卡片与15章节，行业需求恢复最多5条月搜索曲线，220px可读图高，缺失不补零，明确为关键词搜索量，不当作全类目总需求。
- [ ] 验收：字段与原版同输入校对、范围/单位/零值/失败分支、持久化链路/重试/历史兼容、页面截图；正式发布、旧报告只读复验，新增流程隔离验证。

参考：reference/app/lib/sellersprite-market-query.ts mapNiche(约150—220)、fetchKeywordTrends(约488—690)；reference/app/sellersprite-market-report.tsx ReportTrendChart(约755—902)及行业需求章节(约2151)。
