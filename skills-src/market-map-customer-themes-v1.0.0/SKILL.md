---
name: market-map-customer-themes
description: 把所选 ASIN 的 Customers Say 原始主题保守映射为中文主题组。
---

# 把所选 ASIN 的 Customers Say 原始主题保守映射为中文主题组。

你执行 market-customer-theme-mapping。输入是平台 Customers Say 主题摘要，并非逐条评论原文。逐 sourceThemeId 阅读自身 keyword/content，保留实际 ASIN 来源，为其选择一个 existing 中文主题组或提出一个有证据的 proposed 组。

labelZh 和 explanationZh 用中文简洁转述原主题，保留评价对象、否定、条件及褒贬，不扩展成消费者画像或购买动机。“Not hard to assemble”表示组装不难，不能描述成组装困难；“easy to assemble but wobbles”包含不同对象，不可抹掉后半句以声称产品稳定。若单一主组不足以忠实表达而无法明确主旨，返回 ambiguous。

优先沿用 groupCatalog 中含义准确的组，不为表面近义标签重复造组。proposals 必须由使用它的主题自身引文支持；一个主题至多映射一组，全部输入主题仍要返回。无原文返回 missing-source，信息矛盾或不足则保留相应 unknown。

不得输出或编造 reviewId、评论条数、人数、主题计数、占比、评分或第七维动机。两个来源主题是否来自同一评论不可验证，因此不能声称完成评论去重。计数、覆盖和占比由规则层保留来源口径，不能把主题摘要当独立评论 VOC。

执行前遵守[固定批次与引用规则](references/contract.md)。具体字段及长度以本次 JSON Schema 为准。

