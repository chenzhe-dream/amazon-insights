# 市场来源回放样本

`floor-customers-say.json` 来自此前已保存的 Floor Lamps Customers Say 响应（原文件 `test-results/market-research-goal/real-source-samples/floor-theme-first.json`）。只保留 `payload.data`，不包含调用配置、凭据或请求元信息；19 个主题及其原始计数不变。

用于离线解析回归，不能证明当前供应商可用，也不能把主题提及数当作独立评论人数。测试文件必须跟随仓库保存，不依赖开发机被忽略的 `test-results` 目录。

`floor-customers-say-invalid-count.json` 是 2026-09-26 隔离真实验收中 Sorftime 为 `B07Z5NQPDS` 返回的原始 `payload.data`：第 2 条主题总提及 9、负面提及 76。用于验证矛盾数据拒绝、失败定位和定向重试，不能修正这些计数后冒充真实来源。原始商品主题全部保留；测试中的修复响应另为合成数据。
