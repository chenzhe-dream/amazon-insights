# 第一批验证记录

- 已接通 Sorftime product_trend SalesVolume：rules-v2 自动为冻结商品池逐 ASIN 创建历史步骤；rules-v1 不变。
- 历史周期独立于研究范围，未改 SellerSprite 研究总量和人工修订。完整日历三/六个月及前两年总量缺月不出数，真实零保留。
- collector 4 项、历史流程隔离 PostgreSQL 1 项、既有形态流程含子用例 3 项、来源 worker 含子用例 13 项、四模块隔离集成 1 项全部通过。
- UI 静态4项、原版流程浏览器1项、来源 summary 2项通过；浏览器覆盖人工保存前后、历史值与周期合计、刷新、移动视口及无页面错误。
- 构建通过；大型 chunk 提示为既有非失败警告。OpenSpec strict 验证通过。
- 截图：test-results/market-shape-original-flow/historical-sales.png、desktop.png、mobile.png。
- 类目历史/集中度 KPI、来源七区预览、原版本地综合结论尚未实施；本轮不声称整个模块等价原版。
- 正式环境和真实来源验收结果在发布后追加，当前不得据隔离测试宣称真实采集成功。
