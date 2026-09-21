# 扩展 ASIN 残留修复与验收

2026-09-16，规则 `product-structure/1.1.3`。已按用户指令于北京时间 15:23:54 正式发布，5.4 已完成；版本与健康证据见 release-verification.md，业务实机验收待用户执行。本文替代 additional-asin-validation.md 中针对旧版本的失败状态，不覆盖其证据。

## 已修复

1. **候选来源贯穿汇总。** VOC 原始主题、合并主题、功能分层及优先级携带决策引用；派生动作仅使用原候选的 ASIN 和具体需求。融蜡灯 B0CTJGJL2T 不再获得滑板车 B0BPXRVWYK 的后轮改进；同类产品独有的散香、配件需求也不跨 ASIN 推广。
2. **动作语义及用途条件。** 裸词“控制”不再触发握持/适龄；温控、故障控制保留各自问题。普通调光、照明不要求阅读用途，明确阅读用途仍需依据。B0DZFGTCLR 的无级调光动作恢复。补前轮、后轮、轮子条件；未知结构动作不再由任意无关需求支持。定时需求只能支持相应定时动作，不能替代眩光需求。
3. **原始问题不被主题名替换。** 动作由匹配到的本 ASIN 原文生成，避免“灯泡易坏”规范化后变成空泛“耐用性”而丢失依据，或被误套成机械连接方案。
4. **来源维度隔离。** 相同主题下的好评、差评、未满足需求分别保留引用。一个产品的好评不能支持其避坑结论，也不能用另一个产品的差评生成核心保留项。
5. **下游不重新放行核对提示。** 功能分层消费已有决策；优先级中的“核对……”提示保留原判定，不作为新建议重新打分。未采用建议仍能追溯原因。
6. **验收对应实际故障。** 电子耐久性问题不再仅因进入 durability 主题就自动要求承力结构循环载荷/连接件防松；未确认失效部位时按原问题的故障频次、使用时长、复现条件验证。

运行时修改限于 `shared/product-structure-rules.ts`、`app/lib/product-structure-analysis.ts`、`app/voc-positioning.ts`、`app/final-product-definition.ts`。保留其他工作树改动；没有修改评分公式、权限、数据库、采集或其他业务模块。运营说明继续读取共享规则与实际决策。

## 测试证据

- **扩展数据：36 ASIN / 8 类目 / 42 组合，42/42 通过。** 输入仍为上一轮保存快照，包含单品、同类及主动构造跨类组合；没有重新获取供应商数据。
- **原始残留断言：4/4 通过。** 保存了修复前 0/4 和修复后 4/4 证据。
- **有效输出保留：36/36 单品都有 supported 的原始 VOC 建议，最少 3 条；42 组合没有被误标为 supported 的待核对提示。** 数量仅作反整表清空检查，不代表全部建议经过人工业务确认。
- **原雪地 7 ASIN：7 项基础检查及 4 项语义/解释检查全部通过。** 原始输入校验值保持不变；未知关键词保留缺失状态。
- **相关自动化测试：95/95。** 规则/来源/界面模型等主矩阵 75，保存及权限回归 8，原聚合与关键词消费者 12。
- 全仓 `npm run typecheck` 通过；共享规则、适配器及新增测试的限定 ESLint 通过。
- 独立目录 `C:/Users/EDY/Amazon-Product-Opportunity-Insights.runtime/verification/structure-residual-20260916` 的 `npm run build` 通过，没有覆盖正式运行产物。
- 独立子智能审查的相邻缺陷均有可复现证据和回归，限定检查范围内无未解决发现。

规则一致性以固定 `tsx --test tests/agent/product-structure-rules.test.ts` 执行方式校验，指纹 `7c491ea5`。指纹含执行函数表示，不作为跨编译/不同入口的文件校验值。旧版本记录保留。

旧聚合快照曾出现两处摘要哈希变化，已与前次隔离构建中的真实旧代码逐字段比对：滑板车只新增来源/维度标记；灯具另外恢复了被阅读前提误挡的普通照明建议。原主题占比、角色、优先级与机会评分不变，再更新对应测试基线，未用删断言掩盖回归。

## 可复验材料

工作树 `.superpowers/sdd/structure-other-asins/`：`summary-before-repair.json`、`summary.json`、`results/*.json`、`residual-checks-green.log`、`output-retention-check.json`、`repair-matrix.log`、`persistence-regression.log`、`consumer-regression.log`、`typecheck.log`、`lint.log`、`legacy-projections-before.jsonl`、`legacy-projections-after.jsonl`、`residual-path-review.md`。`lineage-*-red.log` 与 `polarity-acceptance-red.log` 保留失败证据。

原雪地回放在 `.superpowers/sdd/structure-real-data-replay-fixed/`，查看本次重新生成的 `summary.json`、`semantic-checks.json`、`result.json`、`snow-preview.html`；`retest.md` 属于之前 1.1.2 的历史记录，不作为本次版本证据。

## 尚存边界

- 保存输入中 17/36 明确自标模拟/合成数据，其余本轮也未外部认证。这是算法回放验收，不等同真实买家需求或实物效果验证。
- B08B4GH4QL、原雪地 B0DP9H584S 的已有关键词快照为空，未填造。措辞笼统、来源不足或结构未知的候选仍可显示具体待核对原因。
- 词面规则有明确边界，不承诺任意同义表达、未知硬件或所有类目永久无误。后续出现新表达仍须保留原文、补反例并升版，不能绕开来源隔离。
- 本轮没有做线上端到端验收；历史已保存报告不会自动改写，发布后重新分析才使用新规则。
