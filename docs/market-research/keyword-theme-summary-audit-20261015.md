# 关键词与买家评论总结专项核对

日期：2026-10-15。范围：原始 ZIP、候选工作树、32900 历史报告。只检查，未改业务代码、未重新采集、未发布 31900。

## 结论

此前“其余模块没有整块遗漏”的判断不足以覆盖不同报告分支，本记录补充具体证据。

| 路径 | 检查结果 | 性质 |
|---|---|---|
| 关键词默认原版规则报告 | 32900 已显示五维综合结论、W1–W5、14项业务输出、需求簇合成 | 已接通并实页核对 |
| 关键词评分与开发建议 | 默认折叠；展开后有估算评分、产品开发方向、验证优先级 | 隐藏在折叠区，不是缺失 |
| 关键词人工修订报告 | 数据含 synthesis 和14项业务输出，渲染却不包含综合结论和业务输出 | 已复现展示缺口；本轮未创建/修改真实人工版本 |
| 关键词无 originalEstimate 分支 | 有“五维综合结论”标题，但内容为分类统计或“综合结论尚未提供” | 降级展示，不能视为完整综合总结 |
| 类目评论页 | 正面/负面主题评论摘要、单个ASIN总览摘要均在；没有整类目综合结论 | 当前功能边界，不是折叠或缓存问题 |

## 原版 ZIP 证据

来源：`C:/Users/EDY/Desktop/Amazon-竞品数据分析-团队分享版.zip`，直接使用 zipfile 读取并规范化 CR 换行。

- `app/market-traffic-keyword-section.tsx:910` 实际调用 `AmazonKeywordDemandReportSection`。
- `app/product-keyword-demand-report-section.tsx:139-148` 输出“五维综合结论”、`synthesis.headline` 和 `synthesis.bullets`。
- `app/category-customers-say-insight-panel.tsx:56,252,321,350` 展示主题评论摘要、买家评论见解、样本总览摘要；组件没有整类目最终结论。
- `.cursor/skills/amazon-voc-insight/SKILL.md:157,163` 规定完整 VOC 分析的执行摘要与最终开品结论，包含共同问题、未满足需求、开发方向等。该业务规范不能等同于类目 Customers Say 页已实现的内容，也不单独证明此页曾有同名总结。
- `MarketResearchUnifiedConclusion` 在 ZIP app 的 TS/TSX 中只有定义文件引用自身，未找到页面调用；不能当作已上线后拆丢的模块。

## 当前代码链路及根因

关键词：`server/services/market-module-service.ts:198-204` 的读取服务在有 facts 且 semanticStatus 为 skipped 时构建自动分类和原版 estimate；其他语义分支没有同样的 estimate。

`app/market-keyword-report.tsx:101-105` 校验 factsId/classificationId 后选择原版报告或 DemandSummary；身份不匹配应继续拒绝复用，不应以取消校验解决缺总结。

人工版：读取/保存服务第211、218行都构建包含 synthesis、businessOutputs 的独立 estimate；`MarketKeywordRevisionReport` 第143行传入 `manual`，`app/market-keyword-original-estimate-report.tsx:210` 用 `!manual` 跳过 `ArchiveDemandSummary`，连带跳过综合结论、W1–W5文字结论和14项业务输出。人工页面仍展示归属统计和折叠开发建议，这些不能替代综合结论。修复时应展示当前人工版本自身结论，不能借用默认版。

评论：`app/market-theme-report.tsx` → `MarketThemeInsightPanel` → `MarketThemeTopicTable` / `MarketThemeSampleTable`；来源文本为主题 content 和样本 customerSay。报告合同 `shared/market-module-contracts.ts:22-32` 保存范围、计数、缺口与证据身份；现有展示链路没有整类目综合分析输出。若需要共同卖点、共同痛点、分歧、机会方向的类目总结，应作为新增的证据分析层，并绑定报告/样本修订；17/20部分来源仍需明确披露。

## 32900 实页证据

- 关键词：`360a350e-0d52-4758-9ab4-2af79592933a`，US / Floor Lamps / 2026-09。
  - 五维综合结论实际建议验证“floor lamp · 客厅 · 尺寸结构”。W2明确人群证据不足，没有推断家庭/年龄/性别。
  - 页面任务进度为趋势完成100/100（11词研究月份无搜索量），原版总结为已有有效历史趋势95/100。代码中前者是任务处理进度，后者过滤研究截止月后的数据和不可用数值后计数；两种计数口径需更明确解释，不能直接当作5个任务失败。本轮未逐词复核这5个成员。
  - 展开“评分与开发建议”后实际出现开发方向及验证优先级。
- 评论：`a389e6b7-819f-4763-bdb7-18717f206931`，US / Floor Lamps / 2026-09。
  - 已取得主题17/20，3个商品来源未返回主题：B0F3NZ12GL、B0GQT4YJ5F、B0F43M9KWW；1条异常主题被隔离。
  - 正负两栏均为主题摘要，下方有20个样本的总览摘要表；没有整类目综合结论。
- 只导航并展开显示控件，未点击查询、刷新采集、翻译或编辑。
- 页面文字留档：`.runtime/keyword-summary-audit-20261015.txt`、`.runtime/theme-summary-audit-20261015.txt`。

## 最小复现与回归

执行 `.runtime/check-keyword-summary-branches.tsx`，使用本地虚拟 fixture 渲染三条路径：

| 路径 | 综合结论标题 | 14项业务输出 | 开发方向 | 总结占位 |
|---|---|---|---|---|
| 自动原版 | 有 | 有 | 有 | 无 |
| 人工修订 | 无 | 无 | 有 | 无 |
| 无estimate | 有 | 无 | 无 | 有 |

人工数据本身有 synthesis 和14项输出，证明问题出在展示门控。

已有三个相关测试文件通过18/18：`market-keyword-original-estimate-view.test.tsx`、`market-theme-ui-parity.test.tsx`、`market-theme-original-ui.test.tsx`。日志 `.runtime/keyword-theme-summary-audit-tests.log`。现有人工版测试仅检查估算评分/标签和过期身份拒绝，没有断言综合结论，因此通过不代表缺口不存在。

建议修复顺序：先补人工版综合结论及14项输出；再明确旧语义报告降级状态；若要整类目评论总结，单独定义证据驱动输出并复用已有来源；不需为展示补齐而重新采集。
