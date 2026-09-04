# 钉钉统一身份认证设计

实施状态：已实现，等待本机钉钉开发应用凭证完成端到端人工验收。

日期：2026-09-04

状态：用户已确认，实施前自检通过

## 1. 目标

在不改变分析任务、指令分发、审核窗口和现有角色权限的前提下，为系统增加钉钉登录：

- 在钉钉 Windows/Mac 客户端工作台内打开系统时，自动发起免登。
- 在 Chrome、Edge 等普通浏览器打开系统时，提供“使用钉钉登录”按钮并走钉钉 OAuth 跳转。
- 仅允许指定企业 `CorpId` 下的在职成员登录。
- 第一次成功登录时自动创建 `member` 用户；绝不自动授予 `admin`。
- 保留现有邮箱密码登录，作为管理员兜底入口。
- 本机是开发环境，服务器是正式运行环境；两套环境使用两个独立的钉钉应用和凭证。

## 2. 已选方案与备选方案

### 已选：双应用、双入口、共用现有 Session

开发环境和正式环境分别创建企业内部 H5 微应用。钉钉客户端使用 JSAPI 获取一次性免登码，普通浏览器使用 OAuth 回调；两个入口最终都进入同一个后端身份交换服务，并签发系统现有的 HttpOnly Session Cookie。

选择理由：环境隔离清楚，开发回调不会影响正式用户，且现有鉴权、角色和会话逻辑可以继续复用。

### 未选：一个钉钉应用同时配置本机和正式回调

配置较少，但开发调试会直接影响正式应用配置，凭证泄漏和错误回调的风险更高。

### 未选：完全替换邮箱密码登录

界面最简单，但钉钉故障、配置错误或企业管理员误操作时将失去管理员应急入口，因此首版不采用。

## 3. 系统边界

钉钉只负责证明“当前用户是谁、是否属于指定企业”。系统自身继续负责：

- 用户状态：`active` / `disabled`
- 系统角色：`admin` / `member`
- Session Cookie、退出登录和会话失效
- 管理员用户状态管理
- 项目、分析任务、审核和数据权限

浏览器、User-Agent、前端传入的 `CorpId` 或显示名称都不能作为可信身份依据。只有后端通过钉钉接口验证后的企业成员身份可用于创建系统会话。

## 4. 组件设计

### 4.1 登录界面

现有登录卡片新增“使用钉钉登录”主按钮，并保留邮箱密码表单。

- 钉钉客户端容器：检测到钉钉 JSAPI 后，每次页面加载最多自动尝试一次免登；失败后停止自动重试并显示明确错误与手动重试按钮，避免循环跳转。
- 普通浏览器：点击按钮进入 OAuth 登录。
- 钉钉未配置：隐藏钉钉按钮，现有密码登录不受影响。

### 4.2 Web 公开路由

公开回调只由 Web 端口承接：

- `GET /api/auth/dingtalk/start`：生成一次性 `state`，浏览器只保存 HttpOnly、SameSite=Lax 的短期 Cookie，数据库只保存 `state` 摘要及过期时间，然后跳转到钉钉授权页。
- `GET /api/auth/dingtalk/callback`：在一个原子操作中校验并消费 `state`，校验安全的站内返回路径，把授权码交给内部 Agent 服务，成功后写入系统 Session Cookie，再跳回系统首页。
- `GET /api/auth/dingtalk/config`：仅返回前端允许知道的开关、Client ID、CorpId 和 AgentId；绝不返回 Client Secret。

本机开发回调：

`http://127.0.0.1:31900/api/auth/dingtalk/callback`

正式环境回调：

`https://<正式域名>/api/auth/dingtalk/callback`

`31901` 是回环地址上的内部 Agent 端口，不对用户或钉钉开放，也不作为回调地址。

### 4.3 Agent 身份交换服务

新增内部认证能力：

- 接收钉钉客户端 JSAPI 或 OAuth 产生的一次性授权码。
- 使用服务端 Client Secret 与钉钉通信。
- 验证授权码未过期、未复用，并验证返回用户属于配置的 `CorpId`。
- 读取稳定的企业成员标识和显示名称。
- 查找或原子创建本地用户与外部身份映射。
- 对已禁用本地用户拒绝登录。
- 使用现有 Session 服务签发 Cookie，沿用当前过期、注销和权限检查机制。

钉钉接口细节封装在独立 Provider 适配器中，路由和用户服务不直接依赖第三方返回字段，以便测试和后续升级。

## 5. 数据模型

新增外部身份表 `auth_identities`：

| 字段 | 含义 |
| --- | --- |
| `provider` | 固定为 `dingtalk` |
| `corp_id` | 已验证的企业 ID |
| `subject_id` | 企业内稳定成员 ID |
| `user_id` | 关联现有 `users.id` |
| `created_at` | 首次绑定时间 |
| `last_login_at` | 最近一次钉钉登录时间 |

`provider + corp_id + subject_id` 必须唯一。创建身份和用户必须在同一数据库事务中完成，以避免并发首次登录生成重复账户。

新增短期 OAuth 状态表 `oauth_login_states`，仅保存 `state` 的 SHA-256 摘要、Provider、过期时间和消费时间。回调必须原子地消费一次；已消费、过期或不存在的状态一律拒绝。明文 `state` 只存在于短期 HttpOnly Cookie 和钉钉跳转参数中。

现有 `users.email` 是必填唯一字段，而钉钉未必返回邮箱。首版规则如下：

- 有可信企业邮箱时保存规范化邮箱。
- 没有邮箱时生成稳定的内部占位地址，例如基于 `corp_id + subject_id` 摘要的 `dingtalk-<digest>@identity.invalid`。
- 界面优先显示钉钉姓名；占位邮箱不作为钉钉登录凭证，也不自动获得密码。

## 6. 自动开户与权限

- 后端验证得到的企业身份必须与 `DINGTALK_CORP_ID` 完全一致。
- 首次登录自动创建 `role=member`、`status=active` 的用户。
- 已存在身份只更新允许同步的显示名称和 `last_login_at`，不修改角色。
- `admin` 只能由现有管理员流程授予，钉钉身份、部门或职位均不能自动提升权限。
- 被系统管理员禁用后，即使钉钉仍在职也不能登录。

## 7. 配置与环境隔离

两套钉钉应用分别提供以下环境变量：

```text
DINGTALK_ENABLED=1
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_CORP_ID=
DINGTALK_AGENT_ID=
DINGTALK_LOCAL_ORGANIZATION_ID=
DINGTALK_REDIRECT_URI=
```

`DINGTALK_LOCAL_ORGANIZATION_ID` 指向系统现有的本地组织，钉钉首次登录创建的成员全部归入该组织；它不是钉钉 `CorpId`，两者不能混用。

OAuth 状态 Cookie 与系统 Session Cookie 沿用同一安全边界：本机 `127.0.0.1:31900` 可沿用现有的回环或局域网开发 Cookie 开关；正式环境必须使用 HTTPS、Secure Cookie，且启动时对不安全组合失败关闭。

开发环境写入本机未纳入 Git 的正式栈环境文件；正式环境写入服务器环境变量或 Secret 管理系统。Client Secret 不进入浏览器、不写入日志、不提交 Git，也不通过聊天传递。

## 8. 错误处理

用户可见错误使用稳定、非敏感文案：

- 授权取消：提示重新登录。
- `state` 不匹配或过期：拒绝请求并要求重新发起。
- 授权码过期或复用：拒绝请求并要求重新发起。
- 企业不匹配：提示“当前钉钉账号不在允许的企业内”。
- 本地用户已禁用：提示联系管理员。
- 钉钉服务不可用：保留密码登录入口，并提示稍后重试。
- 服务配置缺失：钉钉入口不启用，启动诊断只报告缺失字段名，不输出字段值。

日志只记录请求 ID、失败类别、Provider 和时间，不记录授权码、Access Token、Client Secret、完整 Cookie 或用户敏感信息。

## 9. 测试与验收

### 自动化测试

- 配置完整性与密钥脱敏。
- OAuth `state` 正常、过期、不匹配和重放。
- 授权码过期、复用、Provider 超时和异常响应。
- `CorpId` 匹配与不匹配。
- 首次登录原子创建 `member`，并发登录不重复开户。
- 再次登录复用同一用户且不改变角色。
- 被禁用用户拒绝登录。
- `admin` 永不由自动开户产生。
- 钉钉登录与密码登录签发相同安全属性的 Session Cookie。
- 钉钉客户端自动免登只尝试一次，失败后不循环。
- 未配置钉钉时现有密码登录回归测试全部通过。
- SQLite 与 PostgreSQL 两种仓储实现通过同一身份映射契约测试。

### 本机人工验收

1. 使用开发应用，在本机钉钉客户端打开 `http://127.0.0.1:31900/`，无需输入系统密码进入页面。
2. 在普通 Chrome/Edge 打开同一地址，点击“使用钉钉登录”，完成授权后返回系统。
3. 首次登录显示钉钉姓名，角色为 `member`。
4. 管理员禁用该用户后，钉钉登录被拒绝。
5. 钉钉暂时不可用时，管理员仍可使用现有邮箱密码登录。

### 正式环境验收

正式应用只配置 HTTPS 正式域名；验证钉钉工作台和普通浏览器两种入口后，再向业务用户扩大应用可见范围。

## 10. 用户需要完成的钉钉控制台配置

### 开发应用（现在准备）

1. 创建一个企业内部 H5 微应用，名称可用“Amazon Insights - Dev”。
2. 应用首页配置为 `http://127.0.0.1:31900/`。
3. 在“接入登录”中加入回调 URL：`http://127.0.0.1:31900/api/auth/dingtalk/callback`。
4. 为应用开通“当前登录用户/成员基础信息”所需的最小权限；不开放通讯录批量读取等无关权限。
5. 应用可见范围先只加入开发测试账号，并发布一个内部测试版本。
6. 记录 Client ID/AppKey、CorpId 和 AgentId。Client Secret/AppSecret 只保存到本机环境配置，不能发送到聊天或提交 Git。

### 正式应用（本机验收通过后）

1. 新建独立正式应用，名称可用“Amazon Insights”。
2. 首页和回调都改为服务器 HTTPS 域名。
3. 先只开放给小范围业务测试人员，验收通过后再扩大可见范围。
4. 正式 Client Secret 只进入服务器 Secret 配置，不复制开发环境密钥。

“接入分享”不是本次登录功能所需能力，首版不配置。

## 11. 非目标

- 不自动同步整个钉钉通讯录。
- 不根据钉钉职位或部门自动授予管理员。
- 不删除现有邮箱密码登录。
- 不允许普通浏览器通过探测本机钉钉进程实现静默登录。
- 不改动分析、VOC、图片、卖家精灵或任务队列逻辑。

## 12. 官方依据

- [身份验证（免登）概述](https://pre-open.dingtalk.com/document/development/sso-overview.md)
- [免登流程](https://pre-open.dingtalk.com/document/development/logon-free-process.md)
- [getAuthCode](https://pre-open.dingtalk.com/document/development/jsapi-get-auth-code.md)
- [OAuth2.0 鉴权](https://pre-open.dingtalk.com/document/connection/oauth2-0-authentication.md)
- [获取用户 token](https://pre-open.dingtalk.com/document/app/obtain-user-token.md)
- [查询用户详情](https://pre-open.dingtalk.com/document/solution/query-user-details.md)
