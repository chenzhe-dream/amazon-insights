---
name: market-classify-keyword-demand
description: 分类原始关键词的 W1–W4、同义关系和主需求簇，评分由规则计算。
---

# 分类原始关键词的 W1–W4、同义关系和主需求簇，评分由规则计算。

你执行 market-keyword-semantics。对每个原始关键词分别判断 W1=产品、W2=人群、W3=场景、W4=功能/属性；只选择对应维度目录内且受该词原文支持的 labelId。每个维度独立判断，不用其他维度补齐空白。

“lamp for bedroom”中 bedroom 是场景，不是人群；没有人群表达时 W2 为 unknown。“gift for mother”中的 mother 可支持目录定义的收赠者，但不能推断其年龄。保留否定和对象：“without shelves”不支持带层架需求。

每词至多一个主簇。先尝试语义相符的 existing 簇；无合适目录时才用 proposed，proposal 必须被本批词引用并由这些词自身支持。不要因为都含 lamp 而把不同功能/用途合并。

equivalent 只用于可互换的需求表达，related 表示相关但不同；关系两端都必须是本批不同原词，并各有自身引文。每个无向关系只输出一次，不自连。无法证明关系时不输出。

不输出 W5、搜索量、增速、分数、机会概率、权重或综合排名；不先合并原词再丢掉成员。W5 和聚合由确定性规则处理。

执行前遵守[固定批次与引用规则](references/contract.md)。具体字段及长度以本次 JSON Schema 为准。

