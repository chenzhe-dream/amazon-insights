## Why

市场调研需求包含市场总览、商品形态及价格带、类目关键词洞察和类目买家评论见解。现系统的项目任务绑定竞品 ASIN，不能用作整个类目的研究范围；先建立独立类目任务并接通市场总览基础指标，为后续三模块提供接入边界。

## What Changes

- 新增美国站类目节点/路径、历史完整月份、CR5/10/20 和新品1/3/6/12月窗口的持久调研任务。
- 后端使用受治理的 SellerSprite connector 解析类目、获取 market_research 与 market_research_statistics，保存指标及来源哈希，保留未知、部分成功和失败状态。
- 新增市场调研导航中的市场总览页，支持创建任务、进度、历史结果、刷新恢复与有限重试。
- 本批交付市场总览基础指标。详细分布/趋势/综合评分及另三个模块列为后续增量，不用空白入口或竞品模拟数据冒充完成。

## Capabilities

### New Capabilities
- `market-research-overview`: 组织隔离的类目市场总览基础采集、任务历史与页面展示。

### Modified Capabilities

无。

## Impact

新增独立 shared schema、PostgreSQL capability/迁移0033、采集服务/worker、认证路由及浏览器代理合约；只在主页面增加导航与独立组件挂载。无新增依赖，不运行旧ZIP脚本，不修改已有生成数据，不自动重启或发布正式栈。
