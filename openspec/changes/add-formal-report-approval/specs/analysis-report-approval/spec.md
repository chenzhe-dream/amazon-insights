## Purpose

定义针对不可变 AnalysisReport 版本的正式人工审批契约，并与模型评分、智能体发布门槛和产品立项保持清晰分离。

## ADDED Requirements

### Requirement: 审批精确绑定报告版本

系统 SHALL 使用组织、`reportId`、`version` 和 `contentDigest` 的完整组合标识审批主体，并在每次状态转换前验证已保存报告完全匹配。

#### Scenario: 审核人批准一份报告
- **WHEN** pending-review 报告的 ID、版本和内容摘要与审批命令完全匹配
- **THEN** 系统只为该不可变报告版本追加 approved 事件

#### Scenario: 报告产生新版本
- **WHEN** 同一分析阶段保存内容不同的新报告版本
- **THEN** 新版本不得继承旧版本的 approved 状态，并需要独立提交审核

### Requirement: 审批使用闭合状态机

系统 SHALL 只允许 `not-submitted → pending-review → approved|rejected`、`approved → revoked` 以及被新版本替代时到 `superseded` 的已定义转换。

#### Scenario: 基于旧状态提交竞争决定
- **WHEN** 两个审批命令都声称从同一 pending-review 状态转换
- **THEN** 系统只接受第一个原子成功的命令，并拒绝另一个命令且不追加冲突事件

#### Scenario: 已拒绝报告被直接批准
- **WHEN** 调用方尝试把 rejected 报告直接改为 approved
- **THEN** 系统拒绝未定义转换并保持当前状态

### Requirement: 审批审计不可变

系统 SHALL 为每次提交、批准、拒绝、撤销和失效追加不可变事件，记录报告身份、前后状态、操作者、角色、原因、请求关联和时间。

#### Scenario: 审计人员查看历史
- **WHEN** 审计人员读取某报告版本的审批历史
- **THEN** 系统按追加顺序返回所有决定，不覆盖或删除旧事件

#### Scenario: 最新事件损坏或读取失败
- **WHEN** 系统无法严格解析审批事件或无法读取审计存储
- **THEN** 系统 fail closed 为未批准，不回退使用更早的 approved 事件

### Requirement: 审批执行职责分离

系统 SHALL 根据组织角色和职责分离策略授权提交、批准与撤销，并禁止模型、Worker 或无权限主体批准报告。

#### Scenario: 报告作者尝试自审
- **WHEN** 当前策略要求独立审核人且提交者尝试批准自己的报告
- **THEN** 系统拒绝审批并且不追加 approved 事件

#### Scenario: 跨组织审核人提交决定
- **WHEN** 操作者不属于报告所在组织
- **THEN** 系统拒绝命令且不得泄露报告或审批历史

### Requirement: 正式审批与质量评分分离

系统 SHALL 将正式报告审批与人工六维模型评分、智能体 release decision 分别保存和解释，任何质量达标记录均不得自动创建报告 approved 状态。

#### Scenario: 智能体通过发布门槛
- **WHEN** 某智能体候选通过自动评测和人工六维评分
- **THEN** 系统可以按 release decision 控制主结果，但目标 AnalysisReport 仍需单独正式审批

### Requirement: 报告批准不等于产品立项

系统 SHALL 在页面和导出中明确报告 approved 只表示该报告版本经过内部审核，不代表预算、专利、合规、供应链或产品立项已经批准。

#### Scenario: 已批准报告建议立项
- **WHEN** approved 报告包含建议立项结论
- **THEN** 系统继续显示尚未完成的独立业务门槛，不展示为公司已批准立项
