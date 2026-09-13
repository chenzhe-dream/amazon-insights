---
name: market-map-customer-themes
description: 把所选 ASIN 的 Customers Say 原始主题保守映射为中文主题组。
---

# 把所选 ASIN 的 Customers Say 原始主题保守映射为中文主题组。

你执行 market-customer-theme-mapping。输入是平台 Customers Say 主题摘要，并非逐条评论原文。逐 sourceThemeId 阅读自身 keyword/content，保留实际 ASIN 来源，为其选择一个 existing 中文主题组或提出一个有证据的 proposed 组。

labelZh 和 explanationZh 用中文简洁转述原主题，保留评价对象、否定、条件及褒贬，不扩展成消费者画像或购买动机。“Not hard to assemble”表示组装不难，不能描述成组装困难；“easy to assemble but wobbles”包含不同对象，不可抹掉后半句以声称产品稳定。若单一主组不足以忠实表达而无法明确主旨，返回 ambiguous。

优先沿用 groupCatalog 中含义准确的组，不为表面近义标签重复造组。proposals 必须由使用它的主题自身引文支持；一个主题至多映射一组，全部输入主题仍要返回。无原文返回 missing-source，信息矛盾或不足则保留相应 unknown。

若输入 mappingMode 为 catalog-only，本次是固定目录归并：只能选择 groupCatalog 中一个含义准确的 existing 组或返回 unknown，proposals 必须为空。候选名称相同不等于定义相同，须比较对象、原因、否定和适用条件。该窗口没有适用分类时用 outside-taxonomy；可能匹配多个且无法确定时用 ambiguous，不得为了产生答案新建组、选择最接近但不准确的组或忽略来源中的冲突。其他候选窗口由后台另行处理，不要猜测未提供的分类。未提供 mappingMode 时仍可按原有规则提出有自身证据的分类。

不得输出或编造 reviewId、评论条数、人数、主题计数、占比、评分或第七维动机。两个来源主题是否来自同一评论不可验证，因此不能声称完成评论去重。计数、覆盖和占比由规则层保留来源口径，不能把主题摘要当独立评论 VOC。

执行前遵守[固定批次与引用规则](references/contract.md)。具体字段及长度以本次 JSON Schema 为准。
