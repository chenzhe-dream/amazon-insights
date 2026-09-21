## Purpose
为管理员提供可追溯的本组织人员统计查看授权，明确区分页面是否展示、是否有权读取统计以及是否能配置其他人的模块，避免历史默认值意外授予访问权限。
## ADDED Requirements
### Requirement: Explicit scoped read access
系统 SHALL 仅向有效账号的已有合法查看者或明确授权且模块可见的人员提供本组织统计。授权 SHALL NOT 提供模块配置或人员管理能力。
#### Scenario: Grant and revoke
- **WHEN** 管理员为同组织普通用户明确授权并显示统计模块
- **THEN** 用户刷新后可读取本组织统计，但模块管理接口返回 403；撤销授权后统计接口立即返回 403
#### Scenario: Legacy and defaults
- **WHEN** 历史用户全部模块可见或新用户默认包含统计模块
- **THEN** 不产生统计授权，已有合法查看者及所有者保持资格
### Requirement: Safe configuration and audit
系统 SHALL 对授权与模块保存使用同一版本校验、事务及审计；批量模块更新和默认模块设置 SHALL NOT 隐式授权。
#### Scenario: Conflict or wrong organization
- **WHEN** 保存版本过期、人员属于其他组织或目标是受保护所有者
- **THEN** 拒绝修改且不产生部分授权
#### Scenario: Unspecified grant
- **WHEN** 客户端只保存模块，没有显式授权字段
- **THEN** 保留原授权，不因勾选统计模块而新增授权
