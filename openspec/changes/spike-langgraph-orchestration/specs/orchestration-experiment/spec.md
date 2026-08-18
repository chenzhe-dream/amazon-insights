## Purpose

定义隔离的 LangGraph 编排实验，使其能与现有静态编排在相同 fixture 下比较确定性、恢复、可观察性和成本，而不影响生产行为。

## ADDED Requirements

### Requirement: 编排实验与生产路径隔离

实验 SHALL 使用独立入口、fixture provider 和临时存储，并且不得被生产启动、Web API、Worker 或构建路径导入执行。

#### Scenario: 生产服务启动
- **WHEN** Web 和 Agent Service 使用正式启动命令运行
- **THEN** 系统继续只加载已批准的静态编排器，不加载 LangGraph 实验模块

#### Scenario: 实验执行
- **WHEN** 研发人员显式运行隔离 spike 命令
- **THEN** 实验只使用非生产 fixture、临时状态和受控资源

### Requirement: 两种编排使用相同 fixture

实验 SHALL 让静态编排和 LangGraph 原型使用相同版本的输入快照、Skill、provider 响应、时钟、ID、失败注入和预算。

#### Scenario: 比较完整成功路径
- **WHEN** 两种编排执行同一个完整输入 fixture
- **THEN** 实验规范化并比较业务结果、节点轨迹、报告版本和所有模型调用，而不是比较不同 demo 输出

#### Scenario: fixture 版本不一致
- **WHEN** 任一运行的输入或 Skill digest 与实验清单不匹配
- **THEN** 系统拒绝把该运行纳入比较结果

### Requirement: 实验验证确定性与恢复

实验 SHALL 重复运行固定场景，并在每个节点边界注入崩溃，以比较结果确定性、状态恢复、幂等和重复调用。

#### Scenario: 模型响应后进程崩溃
- **WHEN** 编排器已经获得固定模型响应但尚未完成下一个节点
- **THEN** 实验记录恢复是否重复模型调用、重复费用或发布冲突报告

#### Scenario: 同一 fixture 重复运行
- **WHEN** 相同版本、固定种子和固定 provider 响应被重复执行
- **THEN** 实验要求业务结果与规范化状态轨迹一致，并公开任何非确定差异

### Requirement: 实验记录完整成本

实验 SHALL 记录每次模型调用、修复重试、Token、估算费用、墙钟时间、检查点和持久化写入，并与静态基线同时报告。

#### Scenario: LangGraph 自动重放节点
- **WHEN** 恢复或重试导致节点再次执行
- **THEN** 实验把额外调用、Token、费用和延迟计入 LangGraph 结果，不得从报告中省略

### Requirement: 实验输出可复现建议

实验 SHALL 输出包含工具版本、fixture digest、环境、度量方法、阻断项和 `adopt|do-not-adopt|needs-more-evidence` 建议的版本化报告。

#### Scenario: 任一恢复场景重复付费调用
- **WHEN** LangGraph 原型在已提交响应后无法避免重复模型费用
- **THEN** 报告将该行为标记为采用阻断项或明确要求后续解决证据

### Requirement: 生产采用必须由后续 change 批准

系统 SHALL 在新的 OpenSpec adoption change 明确批准生产依赖、迁移、回滚和发布门槛前继续使用静态编排器。

#### Scenario: spike 建议采用 LangGraph
- **WHEN** 实验报告结论为 `adopt`
- **THEN** 该结论只允许创建后续 change，不得直接修改生产依赖或运行路径
