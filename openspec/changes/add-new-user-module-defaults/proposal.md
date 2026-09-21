## Why
管理员需要统一设置新用户首次进入时可见的模块，避免逐人重复配置。新增模块必须自动进入管理列表，但由管理员主动决定默认开放。

## What Changes
- 增加组织级新用户默认模块 GET/PUT 和管理抽屉，版本校验与操作审计。
- 首次钉钉登录创建账号的事务内保存默认快照。本地账号按用户最新要求保持现状，不纳入本次默认策略和人员列表。
- 统一模块注册表驱动校验与界面；新增模块默认不勾选。
- 标记默认快照与个人配置来源；保留老用户和系统所有者行为。

## Capabilities
### New Capabilities
- `new-user-module-defaults`: 新用户默认可见模块设置、快照继承和注册表同步。
### Modified Capabilities

## Impact
shared contracts、PostgreSQL migration/store、钉钉账号创建入口、管理路由及 Web 代理、模块可见性页面。仅本地实施验证；不涉及模型、市场分析或正式发布。
