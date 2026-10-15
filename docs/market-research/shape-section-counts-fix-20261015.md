# 形态及品牌本区筛选链接计数修复

## 原因与口径

用户在32900看到形态、品牌筛选项全部为0链接。SectionFilter未向TopSalesMultiSelectFilter传递optionCounts，后者把缺失计数显示为0；不是实际商品池为空，也不是缺少Amazon跳转地址。

本区计数使用当前纳入统计的商品，按与局部筛选相同的形态/品牌键计数；不采用TOP表的搜索结果或局部已筛选集合，避免隐藏其他可选组数量。保留来源全集选项，已排除的组可以真实显示0。人工标注、移除及恢复后重新计算，来源数据及纳入状态不被筛选改变。

改动：SectionFilter的optionCounts改为必填；形态销量、形态价格带共用形态计数，品牌价格带使用品牌计数。

## 验证

- 浏览器回归先失败：未分类实际1链接却显示0；日志shape-section-counts-red-20261015.log。
- 修复后浏览器回归通过：覆盖三个下拉、局部筛选不清零其他选项、修改形态、移除/恢复、真实0链接。
- 既有规则、视图及编辑回归34/34通过。
- 未调整筛选器原有“全部时首次点击只选该项”的行为；测试按其原语义操作。
- 本次仅修复计数；上轮S-01/S-02/S-03等展示遗漏仍待实施，不将本次修复称为已补齐原版业务。

发布边界：仅32900候选；31900不发布。运行验证在更新后补充。

## 32900更新后真实验收

- typecheck与生产构建退出码均为0；代码提交a7457fd9。
- 32900/32901健康返回同一sourceCommit a7457fd987f3c8b7d279ae1ad238ba60e564fa19、sourceHash f2c7122a47f4be1afcf5a3630e084315aa1b70d88bd186a9a6bf2874e5f43e1e。
- 读取原形态任务4e32df59-8e19-4d51-bb52-8fd1a10b9aee，未重新采集、未修改人工标注或商品纳入。
- 实际TOP表100行核对：未分类87、氛围灯13；新形态价格带下拉分别显示87链接、13链接。
- 品牌下拉：Ambimall 6、Aokrean 1、BOBOMOMO 1、Brightech 2、GOEBLESON 6、Govee 9，与表格相符。
- 截图：.runtime/shape-filter-counts-live-20261015.png、.runtime/brand-filter-counts-live-20261015.png。
- 更新前旧dist备份在candidate-stack/rollback-section-counts-20261015/dist。
- 31901只读身份仍为253366e876728a6c9bc35bb9dda2c1b00575b87c，31900未发布。
