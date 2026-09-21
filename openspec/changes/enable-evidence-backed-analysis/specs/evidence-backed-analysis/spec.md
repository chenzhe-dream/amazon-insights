## Purpose
让现有 VOC 洞察和新品定义页面基于已经采集的产品规格、消费者反馈及搜索信号给出可追溯的结论和需求排序，同时保留未知信息、否定条件和商业判断的证据边界。

## ADDED Requirements

### Requirement: Current evidence retains provenance
系统 SHALL 使用当前选中 ASIN 的已就绪来源，保留来源、原文、可获得的采集时间与指标口径，不补造缺失数据。
#### Scenario: Cached record belongs to another ASIN
- **WHEN** 记录 ASIN 与当前输入不一致
- **THEN** 记录不得支持当前结论或增加需求覆盖
#### Scenario: Capture time unavailable
- **WHEN** 原始来源未提供时间
- **THEN** 展示时间未提供，而不是当前计算时间

### Requirement: Equivalent expressions preserve intent and conditions
系统 SHALL 支持有限明确同义表达，并区分现有功能、消费者愿望和工程建议。否定、条件、冲突与跨 ASIN 边界 SHALL 保留。
#### Scenario: Adjustable height has explicit specification
- **WHEN** 当前产品规格明确写可以调节高度
- **THEN** 高度可调可获支持，但希望高度可调不能证明现有功能
#### Scenario: Contradictory or conditional evidence
- **WHEN** 原文否定目标配置或仅在条件下适用
- **THEN** 无条件正面结论不得获支持

### Requirement: Demand ranking uses comparable evidence
系统 SHALL 按原始负评和未满足需求的竞品反馈覆盖排序，同 ASIN 去重。仅同样本口径、同 ASIN 集合及采集批次的有效评论样本可辅助排序。商业评分缺项 SHALL 继续待验证。
#### Scenario: Duplicate feedback and topic shares
- **WHEN** 一个 ASIN 多处重复反馈且只有 Customers Says 权重
- **THEN** 覆盖只计一个 ASIN，权重不转换为评论人数或提及率
#### Scenario: Missing feasibility
- **WHEN** 需求有证据但缺少成本及可行性
- **THEN** 需求可排名，商业总分仍为空

### Requirement: Existing views expose evidence
三个现有分析视图 SHALL 可展开查看需求的 ASIN、来源原文、判断理由、采集时间和缺项。
#### Scenario: Snow and candle products
- **WHEN** 分别分析雪地产品和融蜡灯
- **THEN** 展示各自证据与排序，搜索词不证明轮子、材料或其他产品配置
