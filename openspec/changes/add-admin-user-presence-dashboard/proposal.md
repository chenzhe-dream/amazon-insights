## Why

当前内网部署的管理员无法判断团队账号是否从未登录、会话是否仍有效，以及用户最近是否仍在使用页面；现有 `sessions.last_seen_at` 已具备记录活动的存储位置，却从未更新。需要在不扩展多组织产品语义、不增加迁移、不暴露会话或凭据材料的前提下，补齐一个只读的管理员用户在线态看板。

## What Changes

- 新增仅现有 `admin` 可访问的独立 `/admin/users` 页面，以及 `GET /v1/admin/users` 只读接口；普通用户与未认证访问均 fail-closed。
- 在已认证且页面可见时，通过轻量 `POST /v1/auth/activity` 立即记录一次活动并每 60 秒续报；服务端以自身时钟、当前有效会话和至少 60 秒写入节流保证幂等、低写放大。
- 基于现有 `users` 与 `sessions` 聚合账号、显示名、角色、账号状态、登录次数、最后登录、最后活动和有效会话到期时间，并允许展开最近 10 条登录记录。
- 以固定优先级计算展示状态：账号已禁用；近期在线；会话有效但近期无活动；未登录；会话已失效。只有未撤销、未过期会话在服务端最近 5 分钟内的 `last_seen_at` 才构成“近期在线”证据。
- 响应和页面不得包含 Cookie、token、hash、session id、IP、密码或其他凭据；最近登录记录只公开登录时间、最后活动、到期时间和派生的失效原因。
- 复用既有 `sessions.created_at/expires_at/revoked_at/last_seen_at`，不增加或占用迁移编号。账号创建、改角色、禁用/启用、改密码和踢下线不在本变更范围。
- 实施前必须重新基于 Task 12 的最终稳定 HEAD；本能力只依赖认证用户与会话合同，不依赖或修改“共享分析历史”，以降低与 Plan02/03 的合并冲突。

## Capabilities

### New Capabilities

- `admin-user-presence`: 定义活动心跳、管理员用户会话聚合、在线态判定、隐私边界与独立管理页面访问门禁。

### Modified Capabilities

无。

## Impact

- API：新增 `GET /v1/admin/users` 与 `POST /v1/auth/activity`，并纳入共享严格合同和集中授权分类。
- 服务端：新增专用 presence contracts/service/repository capability 与路由；SQLite、PostgreSQL 复用现有列并保持一致语义，现有认证和 app 组装点仅做窄接线。
- Web：新增 `app/admin/users` 路由、专用组件和浏览器 helper；认证 gate 增加页面可见性心跳，identity 控件可增加管理员入口，但不修改 `app/page.tsx`。
- 验证：覆盖状态优先级与 5 分钟边界、心跳节流、撤销/过期、401/403、敏感字段缺失、SQLite/PostgreSQL 一致性和 UI 门禁。
- 数据库与部署：无迁移、无新依赖、无部署动作。
