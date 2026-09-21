## Purpose
让已有消费者反馈中明确指向同一对象和同一问题的不同表述形成可追溯的需求分组，避免重复条目影响竞品覆盖与需求排序，同时保留不同意图、适用条件和未知样本的边界。

## ADDED Requirements

### Requirement: Equivalent complaints retain original evidence
系统 SHALL 将有限已验证别名归到规范需求主题，保留原始主题、原文与 ASIN，并显示归并理由。
#### Scenario: Equivalent bulb lifetime complaints
- **WHEN** 两个 ASIN 分别反馈灯泡寿命极短和灯泡寿命问题
- **THEN** 显示一项灯泡寿命需求，覆盖两个 ASIN，可查看两种原始表述

### Requirement: Different entities and intents remain separate
系统 SHALL 保留不同部件、投诉与愿望、条件与未知状态的边界，未知标签不得凭相似度自动归组。
#### Scenario: Bulb and lamp body
- **WHEN** 数据包含灯泡寿命短、灯体寿命短、希望更换灯泡及待验证寿命
- **THEN** 不将这些内容合并为一个已确认的产品配置或投诉
#### Scenario: Related but different problems
- **WHEN** 反馈分别涉及加热不足与散香不足
- **THEN** 保留不同问题，不因可能存在因果关系而归并

### Requirement: Grouped counts and ranking remain trustworthy
系统 SHALL 按 ASIN 去重覆盖，不合计重叠不明的评论样本。同覆盖且无可比样本时 SHALL 使用稳定排序。
#### Scenario: Same ASIN has multiple synonymous review rows
- **WHEN** 同一 ASIN 有多个归并后的评论证据行
- **THEN** 只计一个竞品，样本无法确认独立时显示待核实而不相加
#### Scenario: Input order changes
- **WHEN** 相同证据以不同顺序输入
- **THEN** 需求分组及最终排序一致

### Requirement: Existing consumers show grouping explanation
三个现有证据视图 SHALL 展示规范主题、原始表述、分组类型与归并理由；商业评分缺项仍 SHALL 待验证。
#### Scenario: Inspect grouped demand
- **WHEN** 用户展开归并需求
- **THEN** 可查看原始表述及逐条来源，不把归并本身作为规格或商业立项证据
