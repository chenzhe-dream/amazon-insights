## 1. 实施基线与冲突门禁

- [x] 1.1 在写实现前重新基于 Task 12 的最终稳定 HEAD，确认 worktree clean，并重新只读核对 `users/sessions` schema、认证 principal、集中 401/403 授权和 Web session gate；若关键合同漂移，先更新本变更 artifacts 并重新 strict validate。
- [x] 1.2 建立 allowed-path 检查，明确本切片不得新增或修改 migration、`app/page.tsx`、共享分析历史模块及 Plan02/03 专属文件；记录实施起点 commit。

## 2. 严格合同与状态算法

- [x] 2.1 先为专用 admin-user-presence 合同写 RED 测试：空心跳请求、`{ok:true}`、完整管理员响应、五种 presence 状态、三种失效原因、最近记录上限，以及所有对象拒绝未知/敏感字段。
- [x] 2.2 先为纯 presence service 写 RED 表格测试：从未登录、多会话、禁用优先、有效但无活动、五分钟边界前/等于/后、撤销/过期、撤销会话近期活动无效、最大登录/活动/有效到期时间和稳定排序。
- [x] 2.3 新增 `shared/admin-user-presence-contracts.ts` 与 `server/services/admin-user-presence-service.ts`，只在现有共享 API registry 做窄接线，使 2.1–2.2 GREEN；服务使用一次可注入的服务端 `asOf`，不接受客户端身份或时间。

## 3. SQLite 与 PostgreSQL repository capability

- [x] 3.1 定义专用 `AdminUserPresenceRepository`：读输入、聚合事实与读结果不含 token/hash/password/session id/IP；心跳写入可接收由已认证 principal 派生的内部 session id，仅用于原子定位且不得返回或记录；写结果为 `recorded | throttled | inactive`。为两种数据库准备同一逻辑 fixture/contract test harness。
- [x] 3.2 先写 SQLite RED：全用户/全历史摘要、每用户最近 10 条、账号范围、禁用/撤销/到期、`last_seen_at` 初次更新、60 秒前/等于/后节流、并发/重复请求幂等和失效竞态。
- [x] 3.3 用现有 SQLite database handle 组装独立 presence capability，使 SQLite 测试 GREEN；复用原表列且不创建、编辑或占用任何迁移编号。
- [x] 3.4 先写 PostgreSQL RED，复用 3.1 的等价 fixture，并额外证明条件更新在并发心跳下恰有一次写入、其余为 throttled，认证后撤销/到期返回 inactive。
- [x] 3.5 新增独立 PostgreSQL presence store 并在 runtime repository 窄接线，使 PostgreSQL 测试 GREEN；对等价输入断言 SQLite/PostgreSQL 的摘要、最近记录、状态输入和节流结果一致。

## 4. Agent API 授权与路由

- [ ] 4.1 先写 route RED：未认证 `GET /v1/admin/users` 为 401、member 为 403、admin 仅见本组织 allowlist 数据；未认证/失效心跳为 401，有效 admin/member 心跳成功，读取或合同失败不返回部分数据。
- [ ] 4.2 显式分类 `GET /v1/admin/users` 为 admin-only、`POST /v1/auth/activity` 为已认证 admin/member，并新增专用 routes/service 接线；route 只从 principal 派生 organization/user/session，inactive 心跳 fail-closed 为 401。
- [ ] 4.3 增加 API 否定断言，扫描成功与错误响应均不含 Cookie、token、hash、password、session id、IP、凭据、底层 SQL 或内部 organization/user id，并运行既有 auth authorization/session/password 回归。

## 5. 可见页面活动心跳

- [ ] 5.1 先写 Web helper/controller RED：认证且可见立即发送、持续可见 60 秒周期、隐藏暂停、恢复立即尝试、同 identity 单飞、401 触发现有认证失效、暂时失败等下周期、身份切换和卸载取消旧心跳。
- [ ] 5.2 实现专用 activity browser helper 与可见性 scheduler，并挂到 `AuthSessionGate` 的 authenticated 分支；保证请求体为空、不发送客户端时间或身份，且不修改 `app/page.tsx`。
- [ ] 5.3 运行 session gate、web auth、local agent fetch 与心跳定向测试，证明未认证页面、隐藏页面和已卸载页面不继续 POST。

## 6. 独立管理员用户页面

- [ ] 6.1 先写 UI 门禁 RED：未认证只进入登录 gate 且不 GET admin 数据，member 显示无权访问且不 GET，admin 才读取并展示五种状态、八个摘要字段和可展开的最多 10 条登录记录。
- [ ] 6.2 新增 `app/admin/users/page.tsx`、专用组件、样式和严格 browser helper；实现加载/空态/安全错误、时间展示和无敏感字段的展开记录，不把组件或合同塞进 `app/page.tsx`。
- [ ] 6.3 仅为 admin 在现有 identity 控件增加 `/admin/users` 入口，并添加组件/浏览器 harness 回归，证明 member/未认证直达 fail-closed、401 退出状态一致、页面无横向溢出且 UI 文本不含敏感材料。

## 7. 一致性与完成门禁

- [ ] 7.1 运行完整 affected suite：状态边界、五分钟阈值、60 秒心跳节流、禁用优先、撤销/过期、401/403、敏感字段缺失、SQLite/PostgreSQL parity、Web 心跳与 UI 访问门禁；确认 0 failure、0 unexpected skip。
- [ ] 7.2 对 changed files 运行 lint/typecheck，并执行一次 fresh production build；任何既有全仓噪声须与本切片失败分开记录，不得以局部成功替代必需门禁。
- [ ] 7.3 运行 `openspec validate add-admin-user-presence-dashboard --strict`、placeholder/矛盾/范围/歧义自审、`git diff --check` 和 allowed-path 审计；确认无 migration、无 `app/page.tsx`、无共享分析历史、无敏感样例值。
- [ ] 7.4 只提交经验证的本切片实现、测试和同步更新的 OpenSpec task 状态，随后停止；不得部署、操作真实浏览器、POST 到真实服务或 push，实际部署与发布必须取得独立授权。
