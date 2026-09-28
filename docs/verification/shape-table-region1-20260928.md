# 区域1：商品形态表格发布验收

2026-09-28。范围仅模块二商品表格，审核编号B1—B8。业务计算、数据源与采集流程未修改。

## 发布身份

- 基线：cf82834094af32f5bdbcfa2c347027c95e243381。
- 新代码：15c6255877c6b72ec7e74e60a58576f964cbb865。
- 来源哈希：51c2bcc022d3c4f0b364e08f3c3f798ab248d7e4ed5f77f659ebc80cc9a1836e。
- 制品：d437a7cdb66bbe11a1f7e1ac262771374a630e3341cc58485b04550d65dd6a10。
- 回滚引用：codex/rollback-before-shape-table-20260928。
- 发布方式：正式工作区快进，manage-formal-stack.ps1 -PublishCode；保留活跃任务检查。构建与发布成功，Web31900/Agent31901/PG58258健康。

## 验证

43项测试通过，npm run typecheck通过。测试文件：market-shape-reference-view、market-shape-product-trend-browser、market-shape-reference-editing-browser、market-shape-draft-panel-browser、market-shape-section-sorting-browser、market-shape-reference-rules、market-shape-reference-conclusions。

新增边界：移除确认/取消/恢复、刷新后排除状态和标注、窄列存储/调整宽度的固定列对齐、单月/零值/全缺失、14点预览与全历史详情。

正式测试入口：/?tab=market-overview&themeView=shapes&shapeRun=6fa89d01-707d-4ae8-8fa0-8d12de1ce4f8，1500×1000桌面。

- 140件商品，每行仅批量选择框；样本移除/恢复保留。
- 缩略图超过单元格边界0处，前五行约63.28px（原约125px）。横向滚动商品列固定。
- B07Z5NQPDS详情保留72个系列点；B0H392S15N单月可查看详情，并说明不能判断趋势。
- 页面及详情截图已查看。商品图片在加载后正常显示；未改变图片来源。
- 页面脚本错误0，报告写请求0，采集尝试数不变。临时测试用户已停用，会话撤销。

真实记录与截图：test-results/region1-online/result.json、table-left.png、table-trends.png、trend-full.png、trend-single.png。发布日志：test-results/region1-publish.log。

线上只读验收，移除/恢复/草稿写入在隔离浏览器测试中验证，未操作用户正式草稿。

## 未包含范围

模块一A1—A6仍待处理。下一块A1/A2紧凑版面及重复说明；之后原版字段/趋势/总结，来源空数据独立追因。本次不代表所有类目与所有任务均已验收。
