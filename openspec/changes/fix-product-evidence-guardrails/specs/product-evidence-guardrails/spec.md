## Purpose

为现有 VOC、机会评分和新品定义提供一致的证据边界，避免搜索相关性、缺失数据和类目模板被误认为已验证产品事实，同时保留有依据的分析、原始来源及历史报告，方便业务识别结论与待验证事项。

## ADDED Requirements

### Requirement: Product facts require scoped evidence
系统 SHALL 区分属性存在、明确不存在与未知，保留来源及 ASIN；类目名称和相关搜索词 MUST NOT 单独证明具体产品属性。

#### Scenario: Snow scooter search term
- **WHEN** 雪地产品只有 scooter 搜索词而无轮组证据
- **THEN** 轮组属性为未知，分析不得生成确定的轮组配置要求

#### Scenario: Missing versus explicitly absent
- **WHEN** 一项规格缺失，或原始规格明确说明不带该部件
- **THEN** 前者为未知，后者为明确不存在；有直接正向规格时能够确认存在

### Requirement: Conditions and contradictions survive analysis
系统 SHALL 保留否定、适用条件和所属 ASIN；已知冲突 MUST NOT 合并为无条件建议。

#### Scenario: Negative scenario and audience
- **WHEN** VOC 表示不适合冰面、仅适合成人或不推荐三岁以下使用
- **THEN** 这些限制保留，冰面及被排除人群不作为无条件推荐

#### Scenario: Conflicting keyword audience
- **WHEN** toddler 搜索词与产品 VOC 的幼儿限制冲突
- **THEN** 保留搜索信号来源，产品定位显示限制或待验证，不覆盖 VOC

### Requirement: Unknown scores and distinct metrics
系统 SHALL 将无依据评分表示为未知并说明原因；综合分缺项时 SHALL 待验证，不补默认分、不按剩余权重归一化。搜索量、ASIN 覆盖、评论比例与启发式权重 MUST 分开呈现。

#### Scenario: Missing commercial evidence
- **WHEN** 没有可行性、溢价或成本证据
- **THEN** 对应评分未知，综合分不得依靠默认值给出高分或立项通过

#### Scenario: No review denominator
- **WHEN** 只有关键词覆盖或旧汇总权重，没有可验证的评论样本分母
- **THEN** 不显示为真实评论提及率，不直接相加不同产品的百分比

#### Scenario: Complete score inputs
- **WHEN** 所有既有加权维度都有有效依据
- **THEN** 保持原加权公式，需求分仍不构成立项批准

### Requirement: Recommendations respect evidence strength and scope
三个分析入口 SHALL 采用一致的有依据、待验证、冲突语义。证据 ID 合法只是必要条件；错项目、错 ASIN 或错输入版本的结果 MUST NOT 被当作当前结果。无法可靠判断的语义 SHALL 待验证。

#### Scenario: Durability pain without engineering evidence
- **WHEN** VOC 仅说明不耐用
- **THEN** 可建议调查失效位置，但指定 PU、密封轴承或连接结构不作为已验证必选方案

#### Scenario: Evidence removed or out of scope
- **WHEN** 支持结论的证据被删除或来自另一输入范围
- **THEN** 该结论降为待验证或被拒绝，页面仍能显示其他有效条目

#### Scenario: Positive supported evidence
- **WHEN** 当前置物灯规格明确包含层板且相关 VOC 有对应使用反馈
- **THEN** 系统可输出有依据的层板相关分析，不将所有结果一律降为待验证

### Requirement: Compatibility and bounded delivery
系统 SHALL 保留原始资料与存档报告；新校验仅接入当前三个入口及必要直接消费者。旧派生内容 MUST NOT 冒充原始证据。发布 MUST 遵守正式栈活动任务检测。

#### Scenario: Historical analysis
- **WHEN** 用户查看旧存档或重新计算
- **THEN** 存档不静默改写，重新计算遵循当前输入与规则；未知旧版本不可充当新结论的原始依据

#### Scenario: Active analysis during deployment
- **WHEN** 正式栈检测到活动分析拒绝发布
- **THEN** 不强制中断活动任务、不绕过检查，报告待发布状态
