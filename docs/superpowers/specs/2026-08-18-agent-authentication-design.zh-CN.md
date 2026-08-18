# Agent 认证设计

> 中文阅读版，以英文原稿的技术标识与本文件相同；若翻译歧义以已审批设计决策为准。

## 目标

定义 OpenSpec 4.3 针对 vinext Web 代理和 Node Agent Service 的认证及最小授权边界。每个受保护的业务请求都必须同时证明：请求经过了受信任的 Web 代理，并且属于一个有效的组织用户会话。实现必须保留一个显式、仅限回环地址（loopback）的 fixture smoke 逃生通道，同时不能削弱非回环或生产部署。

本设计细化现有的 `access-control` capability。它不实现代码、测试、migration、UI、部署或 PostgreSQL 支持。

## 范围

OpenSpec 4.3 将实现：

- 通过本地 CLI 进行一次性的首位管理员初始化；
- 使用每用户独立 salt 的 scrypt 密码存储与验证；
- 登录、登出、当前会话以及受保护请求的认证；
- 通过 HttpOnly cookie 携带、可撤销的服务端不透明会话；
- 相互独立的 Agent Service 代理 token 与用户会话检查；
- 按规范化 email 和客户端 IP 分别执行有界的内存登录限流；
- 针对公开健康检查、经代理认证的 capability 发现以及最小仅管理员 connector probe 的显式路由策略；
- 针对受保护业务路由和管理路由的 `admin` 与 `member` 授权；
- 针对 fixture smoke 和本地不安全 cookie 的显式、仅限回环地址的兼容标志；
- 脱敏错误、安全事件以及聚焦的认证/授权测试。

OpenSpec 4.3 将不实现：

- 重新设计登录页面或更广泛的应用 UI；
- 添加邀请、公开注册、密码重置邮件、SSO、MFA 或账号恢复；
- 添加 connector secret 编辑、secret 轮换或通用密钥管理 UI；
- 实现 PostgreSQL、分布式会话或分布式限流；
- 在现有单组织 `admin`/`member` 模型之外改变项目共享；
- 让 Web 进程替代 Agent Service 授权；
- 削弱现有的 `x-agent-proxy-token` 边界。

## 信任边界

### 受保护请求流程

```text
Browser
  Cookie: __Host-agent_session=<opaque token>
      |
      v
vinext proxy
  - receives the HttpOnly cookie
  - overwrites trusted client-IP metadata from the browser socket
  - adds x-agent-proxy-token from server-only configuration
  - forwards cookie + proxy token to Agent Service
      |
      v
Agent Service
  1. verifies x-agent-proxy-token
  2. hashes and verifies the session cookie
  3. loads active user + organization + role
  4. applies route authorization
```

这两个凭据证明不同的事实，不能互相替代：

- `x-agent-proxy-token` 证明请求经过了获授权的 vinext 服务器实例。它不标识用户。
- session cookie 证明一个活跃的组织用户已完成认证并拥有当前角色。它不授权调用方绕过 vinext 代理。

每个受保护的 Agent Service 路由都要求两项检查。只携带有效用户 cookie、但未携带代理 token 的直接请求会被拒绝。只携带有效代理 token、但没有有效用户会话的请求也会被拒绝，下面明确定义的登录和 anonymous-loopback capability/smoke 情况除外。`/health` 是唯一不要求任一凭据的路由，并且它不是业务路由。

浏览器绝不会收到 `x-agent-proxy-token`。vinext 代理必须移除浏览器提供的该 header 值，并设置来自仅服务端配置的自身值。对于受信任的客户端 IP header，它同样必须覆盖，而不是追加。只有代理 token 验证成功后，Agent Service 才信任转发的客户端 IP metadata。

### 认证端点例外

- `POST /v1/auth/login` 要求代理 token，但不能要求已有用户会话。它只接受请求 body 中的规范化 email 和 password。
- `POST /v1/auth/logout` 要求代理 token，并在 cookie 存在时消费所提供的 cookie。它撤销匹配的会话并清除 cookie；对于已经不存在或已撤销的会话，返回幂等的已登出响应。
- `GET /v1/auth/session` 要求代理 token。对于有效会话，它返回最小的已认证用户视图；否则返回脱敏的未认证响应。
- `GET /health` 公开访问，既不要求代理 token，也不要求用户会话。它只返回固定的最小存活形态，例如 `{ "status": "ok" }`；不暴露配置、依赖、用户、connector、构建 metadata、错误或 secret。
- `GET /v1/capabilities` 始终要求有效的代理 token。它允许已认证的 `member` 或 `admin`，也允许受限的 anonymous-loopback smoke 模式。三类调用方收到相同的脱敏 capability 摘要；响应不包含 secret、账号身份、角色策略、凭据状态详情或可变的管理配置。
- `POST /v1/connectors/:connectorId/probe` 同时要求有效的代理 token 和已认证的 `admin`。它是 4.3 中最小的仅管理员授权证明。
- 首位管理员初始化不是 HTTP 路由。它只能通过一次性本地 CLI 使用。

其他所有业务、报告、项目、运行、connector 和系统路由仍然同时受两项凭据及其各自路由角色策略保护。

## 首位管理员初始化

操作员从 Agent Service 部署环境调用一次性本地 CLI。CLI 接受数据库位置、规范化 email 和显示名称等非 secret 选项，但不得通过命令行参数接受 password。命令行可通过 shell history 和进程检查被观察到。

密码输入使用带确认的隐藏交互式 TTY prompt。除非未来另行评审并规定 secret 输入机制，否则 CLI 拒绝非交互式密码输入。它绝不打印 password、salt、派生 key、session token 或完整用户记录。

在一个数据库事务内，CLI：

1. 验证不存在任何用户；
2. 规范化并验证 email；
3. 生成密码学随机的每用户 salt；
4. 使用 Node scrypt 以及带版本、显式有界的参数派生 password hash；
5. 在单一组织中创建首位活跃 `admin`；
6. 追加一条脱敏的初始化 audit event；
7. 仅当所有步骤成功时才 commit。

如果已经存在任何用户，CLI 将 fail closed，且不更新、重置或提升账号。后续用户生命周期工作流不属于 4.3。

## 密码存储与验证

每条用户 password 记录都是带版本的编码，其中包含 scrypt 算法标识符、参数、随机 salt 和派生 key。每个用户都从操作系统密码学 RNG 获得独立 salt。password 绝不为了恢复而加密，也绝不以原始形式存储或记录日志。

验证过程只解析闭合的受支持编码，在执行工作前强制执行参数上限，派生候选 key，并以 constant time 比较固定长度字节。不受支持、格式损坏或成本过高的编码会使认证失败，且不暴露解析器细节。

对于未知 email、没有可用 password 的用户以及 disabled 用户，登录使用相同的有界 scrypt 操作，并对进程内持有的 dummy 记录执行验证。这可防止快速失败路径成为实际可用的账号枚举信号。对于未知 email、password 错误、缺失 password 和 disabled 账号，外部响应与状态完全相同。

## 会话模型

### Token 生成与持久化

登录成功会创建一个密码学随机的不透明 token，熵至少为 256 bits。原始 token 只在构造 `Set-Cookie` 响应所需的短暂时间内存在于内存中，随后只存在于浏览器 cookie 中。它绝不在 JSON 中返回、写入数据库、包含在 URL 中或记录到日志。

Agent Service 计算 `SHA-256(rawToken)`，并仅将该 digest 存储在现有的 `sessions.token_hash` column 中，同时存储 session ID、user ID、organization、创建时间、过期时间、撤销状态以及允许的 audit metadata。会话查找对所提供的原始 cookie 进行 hash，并按 digest 查询。

以下任一条件为真时，会话验证都会拒绝：

- cookie 缺失、重复、格式损坏或超出闭合的大小/字符边界；
- digest 没有匹配的会话；
- 会话已过期或已撤销；
- 被引用的用户不存在或已 disabled；
- 用户 organization 无效，或与受保护资源 scope 不匹配；
- repository 访问或严格 row 解析失败。

任何验证失败都不会回退到旧会话或缓存角色。禁用用户时会原子撤销该用户的当前会话；即使撤销被中断，active-user 检查也会独立拒绝未来请求。

### Cookie 配置档

生产环境和安全开发环境使用：

```text
Name: __Host-agent_session
Secure
HttpOnly
SameSite=Lax
Path=/
No Domain attribute
```

只有当 `Secure` 为 true 时才使用 `__Host-` prefix。这可防止 domain-scoped 或不安全 cookie 冒充生产会话。

纯 HTTP 本地开发要求单独的显式标志：

```text
AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1
```

只有当 Agent Service bind address 和每个受信任 Web origin 都是 loopback 时，该标志才会被接受。在该配置档中，cookie 命名为 `agent_session`，仍保持 `HttpOnly`、`SameSite=Lax`、`Path=/` 且没有 `Domain`，但省略 `Secure`。如果该标志不存在，则通过纯 HTTP 登录时不能签发不安全替代 cookie；操作员必须使用 HTTPS，或显式启用仅限回环地址的配置档。如果设置该标志时存在任何非回环 bind 或受信任 origin，则启动 fail closed，并发出脱敏的配置 warning。

清除 cookie 时，使用当前配置档完全一致的 name、path、security、SameSite 和 no-Domain attributes，并设置已过期的 maximum age。

## 认证模式与启动验证

默认在所有环境中使用 authenticated mode，包括本地 loopback。生产模式或任何非回环 bind/origin 始终要求用户会话。

只有同时满足以下全部条件时，legacy fixture smoke 才能仅省略用户会话层：

```text
AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1
```

- Agent Service bind address 是 loopback；
- 每个已配置的受信任 Web origin 都是 loopback；
- 请求通过有效的 proxy-token 边界到达；
- runtime 不是 production；
- 路由属于现有 fixture smoke surface，并且不暴露 admin 操作。

Loopback 指显式识别的本地主机/地址，例如 `127.0.0.0/8`、`::1` 或经过验证的 `localhost` origin。包括 `0.0.0.0` 和 `::` 在内的 wildcard bind、LAN 地址、公共名称以及混合的 loopback/non-loopback origin 列表都不属于 loopback。

如果没有 `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1`，除 `/health` 外的 loopback 请求都要求登录，或必须属于显式 login-route 例外。启用该标志后，`/v1/capabilities` 和 fixture smoke 仍然必须提供代理 token，而仅管理员路由仍对 anonymous smoke 不可用。该模式在启动期间解析一次；不能按请求启用。

如果 anonymous 标志在 production 中设置，或与任何非回环 bind/trusted origin 一起设置，Agent Service 会拒绝启动，并写入脱敏的 high-severity 配置 warning，其中只命名不安全标志和关闭原因，不包含 token、包含凭据的 origin 或其他环境值。它不得静默忽略不安全配置并以不确定模式继续运行。

`AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE` 与 `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK` 相互独立。前者控制已认证本地用户的 cookie transport；后者允许狭窄的匿名 fixture smoke 路径。启用任一标志不意味着启用另一个。

## 登录流程与限流

登录 handler 按以下顺序执行步骤：

1. 验证代理 token 和闭合的 request shape；
2. 规范化 email 和受信任客户端 IP；
3. 查询针对规范化 email 和客户端 IP 的有界内存 limiter；
4. 加载用户或选择 dummy password 记录；
5. 执行恰好一次有界 scrypt 验证；
6. 记录成功或失败，但不记录原始凭据；
7. 对于活跃且有效的用户，创建服务端会话并设置 cookie；
8. 否则返回相同的通用 invalid-credentials 响应。

实现为规范化 email 和客户端 IP 维护独立的有界 bucket；超过任一 bucket 都会以 `429 LOGIN_RATE_LIMITED` 拒绝尝试。这可以防止通过轮换一个维度轻易绕过另一个维度。limiter 具有显式 maximum entries 和 expiry cleanup，因而不受信任的输入不能导致无限内存增长。

在 4.3 中，rate-limit 状态仅在进程本地，并会在重启时重置。只有对于当前单 Agent Service 实例，这是可接受的。多实例或 hostile-internet 部署要求后续的分布式 limiter change；4.3 不声称具备跨实例强制能力。

对于 vinext 转发的请求，代理从其已接受 socket/受信任 hosting context 派生浏览器客户端 IP，移除浏览器提供的 forwarding header，并设置一个闭合的内部 client-IP header。只有在代理 token 验证后，Agent Service 才使用该 header。缺失或无效的 metadata 会映射到一个固定的 unknown-source bucket，而不是信任任意文本。

未知 email、disabled 用户、错误 password、格式损坏的已存储 hash 以及缺失 password 都消耗可比的验证工作，并产生相同的通用响应。response time、body、status、header 和 log wording 均不会有意揭示 email 是否存在。

## 授权

已认证 principal 是一个闭合对象，只包含 user ID、organization ID、role（`admin` 或 `member`）和 session ID。路由 handler 从 middleware 接收此 principal，不得从 request body、query parameter 或客户端 header 重构身份。

`member` 可以使用现有的团队业务 surface：创建并查看共享项目、启动并观察分析、读取报告、导出已授权结果，以及通过代理读取脱敏的 `/v1/capabilities` 摘要。`member` 不能运行 connector probe，也不能读取或修改 connector secret、用户角色、账号状态、认证配置或可变系统管理状态。

`admin` 包含 member 权限。在 4.3 中，`POST /v1/connectors/:connectorId/probe` 是最小的仅管理员状态操作；member 会收到 `403 FORBIDDEN`。其结果仍保持脱敏，并且绝不返回 secret 值。`GET /v1/capabilities` 被刻意设为非仅管理员：已认证 member 和 admin 收到页面所需的同一个只读摘要。尽管更广泛的 access-control capability 把 secret 编辑、用户邀请、角色管理 UI 和凭据轮换分配给未来 admin 工作流，它们仍然不在本次范围内。

授权顺序是 authentication、organization scope，然后是 role。缺失的业务资源和跨组织业务资源都返回该路由脱敏的 `404 NOT_FOUND`，使调用方无法区分资源是否存在。对现有同组织 admin 路由的角色失败返回 `403 FORBIDDEN`，且不披露 secret 配置或隐藏资源字段。

Anonymous loopback fixture smoke 获得专用的受限 principal 或等价的显式 mode marker。它绝不被视为 `admin`，绝不获得 user ID，只能通过有效代理 token 读取相同的脱敏 `/v1/capabilities` shape 和已批准 fixture smoke surface，并且不能调用 connector probe 或任何其他仅管理员操作。

## 错误与日志安全

认证响应使用闭合的公开 code 和固定 message：

- `AUTHENTICATION_REQUIRED`：受保护路由缺少会话或会话无效；
- `INVALID_CREDENTIALS`：所有登录凭据失败；
- `LOGIN_RATE_LIMITED`：有界登录节流；
- `FORBIDDEN`：已认证角色失败；
- 无效 `x-agent-proxy-token` 使用现有 proxy-authentication error。

响应绝不包含原始 cookie、session digest、password material、salt、scrypt output、proxy token、database row、stack trace、账号是否存在或 disabled 状态。

安全日志可以包含 event type、request correlation ID、规范化 route class、outcome code、成功查找后的 session ID、认证后的 actor user ID，以及单向有界 email/IP correlation fingerprint。日志不得包含原始 password、非必要的原始 email、cookie header、`Set-Cookie`、原始 session token、token hash、proxy token、CLI input 或完整环境值。

所有意外的 repository、parser 和 crypto error 都映射到安全的认证失败或安全的 service-unavailable 行为。原始 cause 保留在内部，并且在结构化日志记录前必须经过现有 redaction 边界。

## 配置契约

认证配置在启动时从严格 allowlist 解析一次。它至少解析：

- 固定边界内的 secure cookie lifetime 和 session lifetime；
- Agent Service bind address 和受信任 Web origin；
- production/development runtime classification；
- `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK`；
- `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE`；
- 位于实现上限内、固定且带版本的 scrypt 参数；
- 有界 login limiter window、threshold 和 maximum entry count。

按照共享配置约定，Boolean 标志只接受规范的启用值 `1`，或者不存在/`0`。空白、混合大小写或其他 truthy string 会使验证失败，而不是意外启用不安全模式。

配置摘要只暴露已解析 Boolean 和安全 mode name。它绝不回显 proxy token、cookie value、password material 或包含凭据的 origin URL。

## 测试策略

所有认证测试都使用临时 SQLite database、fake clock、必要时注入的确定性 random byte、fake network metadata 和 sentinel secret。它们不要求真实 API key、浏览器、email service、外部 identity provider 或 PostgreSQL。

### Admin bootstrap 与密码测试

- hidden-prompt CLI 恰好创建一个首位 admin，并拒绝第二次初始化；
- password 绝不出现在 CLI argument、output、log、database snapshot 或面向进程的配置中；
- 每个用户获得不同的随机 salt，并且正确/错误 scrypt 验证按规定运行；
- 格式损坏和成本过高的 password encoding 会 fail closed；
- 未知、disabled、缺失 password 以及 password 错误的路径都执行 dummy/real verification 边界，并返回相同的公开结果。

### 会话与 Cookie 测试

- 原始 session token 只出现在 `Set-Cookie` 中；SQLite 只存储其 SHA-256 digest；
- 有效、缺失、格式损坏、已过期、已撤销和 disabled-user session 都产生闭合结果；
- logout 具有幂等性，会撤销 digest，并清除与当前配置档完全一致的 cookie；
- production cookie 为 `__Host-agent_session; Secure; HttpOnly; SameSite=Lax; Path=/`，且没有 Domain；
- insecure loopback cookie 使用 `agent_session`，绝不使用 `__Host-`，并且仅在显式 all-loopback flag matrix 下被接受；
- 任何响应或日志都不包含 sentinel password、cookie、session digest 或 proxy token value。

### 边界与启动测试

- 受保护路由分别拒绝仅 cookie 和仅 proxy-token 请求；
- login 接受没有先前 session 的 proxy authentication，而业务路由不接受；
- `/health` 在没有代理 token 或 session 的情况下成功，并且只返回固定的最小 liveness shape；
- `/v1/capabilities` 拒绝缺失/无效的代理 token，对已认证 member/admin 成功，并向受限 anonymous-loopback smoke 返回完全相同的脱敏 shape；
- 当 loopback flag 或任一 loopback/startup 前置条件缺失时，匿名 `/v1/capabilities` 失败；
- connector probe 仅对已认证 admin 成功，并拒绝 member 和 anonymous-loopback 调用方；
- anonymous loopback 默认 disabled；
- fixture smoke 路径仅在 anonymous flag、non-production runtime、loopback bind 和全 loopback trusted origin 同时为 true 时工作；
- wildcard、LAN、public、mixed-origin 或 production 配置与任一不安全 loopback flag 组合时，启动失败且只发出脱敏 warning；
- anonymous fixture smoke 不能访问 connector probe 或其他仅管理员路由。

### 限流与授权测试

- 重复失败会耗尽 email 或 IP bucket，并返回相同的有界公开 error；
- 更改 email 不能绕过已耗尽的 IP bucket，更改 IP 不能绕过已耗尽的 email bucket；
- limiter entry cleanup 和 maximum capacity 使内存保持有界；
- 浏览器提供的 forwarding header 会被覆盖，并且 Agent Service 在 proxy authentication 成功前忽略 client-IP metadata；
- member 业务和脱敏 capability 读取成功，member connector probe 失败，admin connector probe 成功，且跨组织访问失败而不泄漏资源是否存在。

## 发布与兼容性

认证以 fail closed 方式引入。在 4.3 之后，默认的本地和生产行为都要求登录。现有 fixture smoke 仅能在 all-loopback、non-production matrix 下通过 `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1` 使用；该兼容开关不是生产 rollback 机制。

Rollout 顺序：

1. 针对现有 `users` 和 `sessions` table 添加 repository 和 crypto contract；
2. 添加一次性 admin CLI，并在目标环境创建首位 admin；
3. 在聚焦测试保护下添加 auth endpoint、session middleware 和 role guard；
4. 配置 secure cookie transport 和 trusted origin；
5. 启用受保护路由，并验证 login/logout/session revocation；
6. 在这些 fixture 转换为 authenticated request 前，把 legacy fixture smoke 隔离在显式 anonymous-loopback flag 下。

如果 authenticated rollout 必须在本地暂停，操作员只能在全 loopback non-production 环境中临时使用 anonymous-loopback flag。非回环和 production 部署不能 rollback 到匿名访问；它们必须恢复到之前的 application build 或修复认证配置。现有 session 和 user row 保留在服务端，并且可以在不暴露原始 token 的情况下撤销。

任何 4.3 rollback 都不会删除 user、password hash、session 或 audit event。Schema 和行为变更必须保持可由先前 build 向后读取，或者受正常 deployment rollback procedure 保护。

## 验收边界

只有当代码计划保持以下全部 invariant 时，OpenSpec 4.3 才可进入实现：

- 在受保护路由上，proxy authentication 与 user-session authentication 保持独立且强制；
- `/health` 保持公开但只披露固定 liveness，而 `/v1/capabilities` 始终要求代理认证，并向获允许的调用方返回一个完全相同的脱敏摘要；
- 不持久化或记录任何原始 password 或 session token；
- production 和 non-loopback 部署不能启用 anonymous 或 insecure-cookie 兼容模式；
- loopback fixture 兼容性是显式、狭窄、非 admin 的，并且仍经过代理认证；
- unknown 和 disabled 账号不会形成实际可用的枚举捷径；
- `member` 可以读取脱敏 capability，但不能调用仅管理员 connector probe 或任何携带 secret 的操作；
- failure 和 log 保持脱敏；
- 实现不扩展到 UI redesign、invitation/email、key management 或 PostgreSQL。
