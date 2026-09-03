## Context

本设计以 exact `b159c06ce5b1bb503da4f644bfebb86c1c977cdd` 为只读规划基线。当前认证由服务端可撤销 Session Cookie、`AuthenticationService` 和集中 `classifyRoute` 组成：未认证请求返回 401，角色不允许返回 403；SQLite 与 PostgreSQL 的初始 schema 都已有 `sessions.created_at/expires_at/revoked_at/last_seen_at`，但 `last_seen_at` 目前只在创建时写入空值并在认证查询中读取，没有更新路径。成功登录创建一条 session，因此现有 session 历史可同时作为登录历史。

当前 runtime repository 已按专用 capability/store 逐步拆分，但核心认证仍穿过较大的 `repository.ts`、SQLite repository 与 PostgreSQL core store。Task 12 仍可能改变最终稳定 HEAD；实施前必须重新基于其最终稳定提交检查合同与接线点。本切片不得依赖“共享分析历史”，也不得占用 Plan02/03 的迁移号或把新合同、页面逻辑塞进 `app/page.tsx`。

## Goals / Non-Goals

**Goals:**

- 让 admin 通过独立页面查看全部内网账号的可解释会话/近期活动状态。
- 用服务端时钟、当前 principal 和原子节流更新现有 `last_seen_at`，保证 SQLite/PostgreSQL 语义一致。
- 将公开 DTO 限制在产品确认字段内，在 repository 边界即丢弃 session id、token hash 等敏感材料。
- 通过新增专用合同、service、repository capability 和 UI 模块控制与并行计划的冲突面。

**Non-Goals:**

- 不设计 platform-admin、组织切换、跨组织汇总或新的 organization 产品语义。
- 不提供账号创建、角色变更、禁用/启用、密码修改、会话撤销或踢下线操作。
- 不把“近期在线”解释为 WebSocket 在线、浏览器连接存活或人员实时在场；它只表示五分钟内存在合格活动证据。
- 不新增表、列、索引、迁移、第三方依赖、部署步骤或共享分析历史集成。

## Decisions

### 1. 使用独立 presence capability，现有认证与组装点只做窄接线

新增 `shared/admin-user-presence-contracts.ts`、`server/db/admin-user-presence-repository.ts`、`server/services/admin-user-presence-service.ts`、专用 routes，以及 `app/admin/users` 与浏览器 helper。`RuntimeAgentRepository` 暴露一个 `adminUserPresence` capability；PostgreSQL 使用独立 store，SQLite 在构造期用现有 database handle 组装同一 capability。`server/app.ts`、`server/auth/authorization.ts`、共享 API registry、`app/auth-session-gate.tsx` 及其中现有的 `AuthIdentityControl` 只增加必要接线。

备选一是把聚合与心跳方法直接继续堆入 `AuthenticationService`、`AgentRepository` 和 PostgreSQL core store；它会扩大认证核心与并行计划的冲突面。备选二是创建独立 presence 表；它重复现有 session 事实、引入迁移与一致性问题。两者均不采用。

### 2. 共享严格合同固定为两个小接口

`POST /v1/auth/activity` 接受严格空对象并返回 `{ ok: true }`。请求不接受 user id、session id 或客户端时间；认证 principal 是唯一写入主体。

`GET /v1/admin/users` 返回：

```text
{
  asOf,
  recentActivityWindowSeconds: 300,
  users: [{
    account, displayName, role, accountStatus, presenceStatus,
    loginCount, lastLoginAt, lastActivityAt, validSessionExpiresAt,
    recentLogins: [{ loggedInAt, lastActivityAt, expiresAt, invalidationReason }]
  }]
}
```

`presenceStatus` 是 `disabled | recently-online | valid-session-idle | never-logged-in | session-expired`；`invalidationReason` 是 `account-disabled | revoked | expired | null`。所有对象使用 strict schema。`account` 使用当前唯一邮箱；不公开内部 user id 或 organization id。用户按规范化账号升序，最近登录按 `created_at DESC`，相同时间以仅在 repository 内部使用的稳定键打破平局，但该键不得进入 DTO。

备选是继续扩展巨型 `shared/agent-contracts.ts` 内的定义；采用独立合同文件后只在现有 API registry 做窄导入/重导出，可减少热点文件冲突，同时保留统一合同测试。

### 3. 单一 `asOf` 驱动聚合和五分钟边界

route 调用 service 时只生成一次可注入的服务端 `asOf`。repository 以该时刻读取当前组织的全部用户、全历史计数/最大时间、有效会话摘要以及每个用户最近 10 条 session。公开层的有效会话定义与认证一致：账号 active、`revoked_at IS NULL` 且 `expires_at > asOf`。

service 按以下顺序计算唯一状态：

1. 账号 disabled：`disabled`。
2. 任一有效会话的 `last_seen_at` 位于 `[asOf - 300s, asOf]`：`recently-online`。
3. 存在有效会话：`valid-session-idle`。
4. 登录次数为 0：`never-logged-in`。
5. 其他情况：`session-expired`。

`lastLoginAt` 和 `lastActivityAt` 使用全部历史会话的最大值；`validSessionExpiresAt` 使用有效会话最大到期时间。最近登录的失效原因按 `account-disabled`、`revoked`、`expired`、`null` 派生。这样禁用优先、五分钟等号边界、多会话和撤销后近期活动均有唯一解释。

备选是让 SQLite/PostgreSQL SQL 直接生成最终状态字符串；那会复制业务优先级并增加方言漂移。最终状态集中在 service，数据库只返回无敏感字段的规范化事实与聚合值。

### 4. 心跳采用当前会话的原子条件更新

页面在认证状态且 `document.visibilityState === "visible"` 时立即调用一次心跳，然后每 60 秒尝试一次；隐藏时清除 timer，恢复可见时立即尝试并重新计时。helper 使用 in-flight guard、身份 key 和卸载取消，避免同一页面重叠请求或旧 session 跨身份续报。非 401 的暂时失败不阻断业务页面，下一周期重试；401 复用现有全局认证失效通知。

repository 的写入条件同时匹配 principal 的 session/user、账号 active、未撤销、未过期，以及 `last_seen_at IS NULL OR last_seen_at <= asOf - 60s`。一个并发请求推进到 `asOf`，其余返回 `throttled` 并对客户端映射为同样的 `{ok:true}`；若会话在认证后失效则返回 `inactive`，route 映射为 401。PostgreSQL 用单条条件更新/CTE 区分结果，SQLite 在现有序列化边界内完成等价判断和更新。

备选是只在 GET session 时更新活动；这会让后台轮询、页面隐藏与认证检查混为活动证据，也无法满足明确 60 秒可见心跳。客户端直接提交时间同样不采用，因为它可伪造且受本机时钟漂移影响。

### 5. 独立页面在角色确认前不获取管理员数据

`app/admin/users/page.tsx` 只组装 `AuthSessionGate` 与专用 client 组件。未认证沿用现有登录 gate；身份确认后，member 渲染固定无权访问状态且不调用 admin API，admin 才读取数据。页面展示摘要表与可展开的最近 10 次登录记录；只对 admin 在 identity 控件显示 `/admin/users` 入口。通用心跳挂在 `AuthSessionGate` 的 authenticated 分支，因此主页面和独立管理页都能获得活动证据，而无需修改 `app/page.tsx`。

备选是在现有巨型主页插入管理面板；这直接违反路由隔离要求并放大 Plan02/03 冲突，因此不采用。

### 6. 防御性授权和敏感字段控制

集中路由分类器显式把 `GET /v1/admin/users` 标记为 admin-only，把 `POST /v1/auth/activity` 标记为 authenticated admin/member。admin route 仍检查 user principal，service 只接收由 principal 派生的 organization/user/session 参数。repository 的 presence DTO 从类型上不包含 token hash、password hash、Cookie、IP 或 session id；心跳 session id 只作为写入参数存在，不会进入响应或日志。任何读取、映射或 strict schema 失败都返回统一安全错误，不发送部分列表。

## Risks / Trade-offs

- [“近期在线”可能被误读为实时在线] → UI 固定使用“近期在线/会话有效但近期无活动”措辞，并展示 `asOf` 与最后活动，不使用“当前在线人数”等强实时表述。
- [每个可见页面产生周期写入] → 客户端 60 秒单飞、服务端每会话至少 60 秒原子节流；多标签页重复请求大多成为无写入幂等成功。
- [长期 session 历史增加读取成本] → 使用集合查询聚合全历史指标，每个用户只物化最近 10 条详情；本切片不增加可能与其他计划冲突的索引或迁移，出现实际规模证据后另立变更。
- [SQLite 与 PostgreSQL 时间/并发语义漂移] → 所有输入先规范化为同一 UTC ISO 时间，状态在共用 service 计算，并以同 fixture 的 repository contract tests 锁定边界与并发结果。
- [Task 12 最终 HEAD 改变认证或 repository 接线] → apply 的第一道门是重基并重新只读核对认证合同；若关键前提改变，先更新本变更 artifacts，不直接套用旧文件路径。
- [管理员数据可见范围过大] → 保持现有单组织 principal scope，不新增跨组织枚举；响应采用 allowlist strict schema，并用敏感字段否定测试覆盖序列化输出与 UI 文本。

## Migration Plan

1. apply 前切换到 Task 12 最终稳定 HEAD，确认 clean worktree，并复核 `users/sessions` schema、集中授权和认证 principal 合同；本规划基线仅作为差异参考。
2. 先落严格合同与 RED 测试，再实现专用 repository capability、service、routes、心跳 helper 和独立页面；不创建或修改任何 migration 文件。
3. 在 SQLite 与 PostgreSQL 上运行同一合同/边界测试，再运行 API、UI 门禁、敏感字段、受影响回归、lint、build 和 strict OpenSpec 验证。
4. 本变更的实施提交保持与“共享分析历史”和 Plan02/03 的迁移/主页改动分离；任何合并冲突只在窄接线点解决。
5. 实际部署需另行授权。应用层回滚只需回退该实现提交：旧服务不再接收心跳，已有 `last_seen_at` 值作为无害历史数据保留，无 schema 回滚步骤。
