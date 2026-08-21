## Why

当前三个智能体使用代码定义的静态依赖图和持久化任务状态，已经具备确定性调度、租约恢复和有限重试。LangGraph 可能简化更复杂的状态图，但引入框架依赖、隐藏状态、检查点语义和额外模型/运行成本；在没有同基准证据前不应替换生产编排。

本 change 只登记隔离技术 spike，用相同 fixture 比较两种编排，不授权生产采用。

## What Changes

- 规划与生产模块隔离的 LangGraph 原型，不修改现有静态编排器。
- 使用与静态编排相同的固定 fixture、假模型和失败注入，比较输出确定性、状态转换、重启恢复、重复执行和成本。
- 保存可复现的实验配置、结果摘要和采用/不采用建议。
- 任何生产依赖、数据模型或运行路径变更必须由后续独立 OpenSpec change 批准。

## Capabilities

### New Capabilities

- `orchestration-experiment`: 以隔离实验比较 LangGraph 与现有静态编排在确定性、恢复、可观察性和成本方面的行为，不影响生产任务。

### Modified Capabilities

无。

## Deferred / Non-Goals

- 不替换、包装或旁路生产静态编排器，不接入生产 UI、API、队列或数据库。
- 不添加生产运行依赖，不运行真实第三方连接器，不使用生产秘密或客户数据。
- 不以 demo 成功作为采用结论，不隐藏重复调用、Token、延迟或检查点成本。
- 未经后续 adoption change，不允许 LangGraph 进入生产构建、部署或功能开关。

## Impact

- spike 后续可位于隔离实验目录或独立包，并使用 fixture provider 与临时存储。
- 实验输出将为是否采用框架提供证据，但不改变当前 MVP。
- 如果实验不满足确定性、恢复或成本门槛，结论可以是保持现有静态编排。
