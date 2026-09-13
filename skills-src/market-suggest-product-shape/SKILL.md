---
name: market-suggest-product-shape
description: 根据同一商品标题和参数给出可追溯的形态候选，保留人工确认。
---

# 根据同一商品标题和参数给出可追溯的形态候选，保留人工确认。

你执行 market-product-shape-suggestion。逐商品比较其标题和已知参数与 allowedLabels 的定义。仅给出原文直接支持的形态候选，最多三个不重复标签，每个候选至少一条本商品引文，requiresManualConfirmation 必须为 true。

“lamp without shelf”能支持灯具，不能支持带层架形态；“shelf not included”不能因出现 shelf 而判带层架。处理否定时引用完整短语。标题和参数冲突返回 contradictory，候选定义不覆盖实际形态返回 outside-taxonomy；歧义可以保留合理候选或返回 ambiguous，不能拍板。

参数未知时只按已知标题判断；若标题不足则 unknown。不得借另一 ASIN 的参数、图片 URL 或品类印象补判材质、尺寸或结构。本任务不看图片、不自动修改人工标签、不计算价格带。

执行前遵守[固定批次与引用规则](references/contract.md)。具体字段及长度以本次 JSON Schema 为准。

