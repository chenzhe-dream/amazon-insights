## Context
<<<<<<< HEAD:openspec/changes/simplify-product-definition-presentation/design.md
当前 report 的 conclusion 兼作 VOC 原文载体，不能直接回滚规则或截断后当结论。页面已有 InlineReportText；ActionStepsCell 目前隐藏超限项。

## Goals / Non-Goals
改善新品定义阅读；保持七列表格及证据可追溯。非目标：重算分析、通用模型摘要、修改后台、其他页面改版、部署。

## Decisions
1. 新增纯展示 projection，只读取该行 ruleDecisionIds 对应的已保存、同范围 VOC 人群/场景判定。采用结构化行首标签，不推断商品适龄，不把搜索词变事实。不同商品以产品序号分别呈现，并在依据列保留序号与 ASIN 对应关系。
2. 仅 reported/supported 且标签可以从明确分隔字段提取时缩短。条件、限制、未知、冲突全文显式保留；无法安全摘要或缺少/重复引用时回退原结论，绝不补取实时数据。
3. 产品形态仅对逐 ASIN 完全相同的完整描述去重；异形态/条件不合并。
4. 长依据用现有三行原地展开。风险、适龄限制、待验证、验收条件不折叠。ActionStepsCell 加 opt-in expandable，其他页面保留原行为，新品定义可展开全部动作，限制项在折叠态也可见。
5. 报告对象、引文、决策引用、规则版本均不修改；无额外模型或数据请求。
6. 顶部人群/场景/形态卡片只在 card.value 与该行结论或 VOC 依据全文一致时复用其展示投影；不匹配时原文回退。摘要后的卡片仍能查看原文，产品序号对应关系可见，限制原文直接显示。
7. 风险、下一步验证、验收及其他带限定语的字段按现有分号/换行分段，保留原有分隔符和全部文字。顶部重复的长定义作为“查看完整定位原文”按需展开；定位卡片及风险字段的限制仍直接保留。原文一字不删，不从跨 ASIN 卡片拼装新结论。ASIN 分段同时支持英文与中文方括号。
8. 整页预览使用现有 React 页面及明确标注的样例数据；提供完整截图、顶部/中部/底部分区截图及可本地打开交互的独立 HTML。预览不访问生产服务。

## Risks / Trade-offs
自由文本或旧快照不一定能产生短结论；安全回退无损显示优先于凭空归纳。限制多时允许超过三行，不能以简洁为由删除边界。

## Validation
纯函数覆盖跨 ASIN/项目/站点/版本、重复/缺失引用、限制/冲突、原对象不变、无 trace 回退及不同形态。组件测试检查展开内容完整；浏览器测试键盘/折叠/移动端及七列表格。回归既有快照与隔离测试。
=======

See proposal.md for motivation. Shared rule-baseline contracts and a connector-free assembler already exist. The first business module to finish is market overview: its complete catalog already stores known metrics, real zeros, and gaps such as empty demand trend and unconfirmed concentration units. Semantic windows and synthesis remain later steps and are not the baseline.

## Goals / Non-Goals

**Goals:**

- Adapt the saved overview catalog into one rule baseline the existing assembler can normalize.
- Keep later shape, keyword, and theme adapters, persistence, and the Agent read boundary in this change, but implement overview first so it can be tested on its own.

**Non-Goals:**

- Changing overview public report JSON, page wait states, or the unpublished window-split default.
- Publishing or restarting the formal stack.
- Treating a missing semantic window as a failed baseline.

## Decisions

### 1. Overview baseline wraps the saved catalog

- **Choice:** `buildOverviewRuleBaseline` reads the catalog semantic record: known metrics become baseline metrics, gaps become null metrics with reasons.
- **Why:** The catalog is already the deterministic overview result. A second calculator would drift.
- **Alternative:** Recompute distributions inside the baseline. Rejected.

### 2. Finish overview before the other modules

- **Choice:** Tasks implement and verify overview before shape, keyword, theme, persistence, and the Agent boundary.
- **Why:** The operator will test overview before the other modules are adapted.
- **Alternative:** Adapt all four modules before any module is testable. Rejected for this pass.

### 3. Synthesis stays outside the baseline

- **Choice:** The baseline rule version is the catalog version. No synthesis payload is copied in.
- **Why:** A missing or failed AI window must not erase the numeric result or be reported as synthesis success.
- **Alternative:** Mark the baseline complete only after synthesis. Rejected.

## Risks / Trade-offs

- [Catalog metric ids are long and numerous] → Baseline limits match the complete-catalog bounds instead of dropping rows.
- [Other modules are specified later in tasks] → They stay unchecked until overview tests pass and the operator finishes that test.

## Migration Plan

1. Land the overview adapter and its fixtures in this worktree.
2. Leave historical overview flows and public report shapes unchanged.
3. Stop after overview so the operator can test. Persistence and the other modules follow the remaining tasks.
4. Rollback is reverting the overview adapter commit. Saved catalogs stay readable.

## Open Questions

- None for the overview slice. Frozen snapshot choice for full runtime replay belongs to the later persistence task.
>>>>>>> ae6e123c (feat: expose deterministic overview rule baseline):openspec/changes/split-market-rule-baselines/design.md
