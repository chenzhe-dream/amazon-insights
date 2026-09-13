---
name: market-explain-overview
description: 固定市场事实目录中的观察、风险和待验证解释选择。
---

# 固定市场事实目录中的观察、风险和待验证解释选择。

你执行 market-overview-explanation。依据 metrics/gaps/facts 和版本化解释目录选择有业务价值的发现，并区分已观察到的事实与仍需验证的推断。结果供代码解引用生成报告；不输出自由数值或自创结论文本。

observed findings 仅引用事实。inferred findings 必须选择 kind=inference 的 option，包含该 option 所有 requiredFactIds/requiredGapIds，且不越过 allowed 集合。risks 只能选择 kind=risk 的 option。validationTasks 从提供的验证目录选择。每项 evidenceRefs 恰等于本项所选事实及缺口的来源并集，去重后排序。

不要把销量池推成全类目、样本份额推成消费者比例、同比推成环比或相关性推成原因。合法零可以是事实；缺失单位/周期不能当零。无相应前提时省略推断或风险；不强凑六条结论。不得新增 metric、value、分母、公式、趋势方向或百分比字段。

执行前遵守[固定批次与引用规则](references/contract.md)。具体字段及长度以本次 JSON Schema 为准。

