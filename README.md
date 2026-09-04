# Amazon Product Opportunity Insights

The application runs as two ordinary local Node.js processes: a vinext Web app
on port 3001 and an internal Agent Service on port 3100. Codex and Cursor are
not runtime dependencies.

## Prerequisites

- Node.js `>=22.13.0`

## Quick Start

```powershell
npm install
Copy-Item .env.example .env
```

Choose one long random local value for `AGENT_SERVICE_PROXY_TOKEN` in `.env`,
then use the stack launcher or two terminals. The stack launcher loads `.env`,
starts the Agent Service first, waits for `http://127.0.0.1:3100/health`, starts
the Web process, and then waits for
`http://127.0.0.1:3001/api/health`.

```powershell
# Build first for production mode, then run both local processes.
npm run build
npm run stack:start
```

For development with file watching:

```powershell
npm run stack:dev
```

## 本机正式栈与钉钉登录

本项目当前用于业务测试的正式启动器使用两个端口：

- `31900`：Web 入口，浏览器、局域网用户和钉钉回调只访问这个端口。
- `31901`：内部 Agent Service，只监听 `127.0.0.1`，不能提供给用户或配置为钉钉回调。

在 VS Code 中从当前代码目录运行：

```powershell
& C:\Users\EDY\AppData\Local\Programs\Python\Python313\python.exe .\launcher\main.py
```

正式启动器从代码目录之外读取受保护配置：
`C:\Users\EDY\Amazon-Product-Opportunity-Insights.runtime\formal-stack.env`。
不要把该文件、数据库连接串、代理令牌或钉钉 AppSecret 提交到 Git。

本机钉钉开发应用需要配置：

- 应用首页：`http://127.0.0.1:31900/`
- “接入登录”回调：`http://127.0.0.1:31900/api/auth/dingtalk/callback`
- 应用可见范围：先只加入开发测试账号
- 权限：只开通当前登录用户及企业成员基础信息所需的最小权限
- “接入分享”：本登录方案不需要配置

在受保护的 `formal-stack.env` 中加入：

```dotenv
DINGTALK_ENABLED=1
DINGTALK_CLIENT_ID=<开发应用的 AppKey 或 Client ID>
DINGTALK_CLIENT_SECRET=<开发应用的 AppSecret 或 Client Secret>
DINGTALK_CORP_ID=<开发应用所属企业的 CorpId>
DINGTALK_AGENT_ID=<开发应用的 AgentId>
DINGTALK_LOCAL_ORGANIZATION_ID=<系统现有 organization UUID>
DINGTALK_REDIRECT_URI=http://127.0.0.1:31900/api/auth/dingtalk/callback
```

`DINGTALK_LOCAL_ORGANIZATION_ID` 来自系统数据库已有用户的
`organization_id`，不是钉钉 `CorpId`。可在数据库管理工具中执行以下只读查询，复制
唯一一条有效管理员记录的 UUID；如果返回多条，不要猜测，应先确认本系统实际使用的组织：

```sql
SELECT DISTINCT organization_id
FROM users
WHERE role = 'admin' AND status = 'active';
```

本机 HTTP 回调还要求现有正式配置保持
`AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1`，且不得把
`NODE_ENV` 设置为 `production`。配置完成后重启正式栈：钉钉客户端工作台内
打开系统会自动尝试一次免登；Chrome/Edge 会显示“使用钉钉登录”；现有管理员邮箱
密码入口始终保留。

服务器上线时必须新建独立的正式钉钉应用，并把首页、回调和
`DINGTALK_REDIRECT_URI` 全部替换为服务器 HTTPS 域名。正式 AppSecret 只放服务器
Secret 配置。先限制应用可见范围并完成小范围验收，再逐步开放。回滚时设置
`DINGTALK_ENABLED=0` 并重启，邮箱密码登录不受影响。

Manual two-terminal startup remains available:

```powershell
# Terminal 1: vinext Web app on http://127.0.0.1:3001
$env:AGENT_SERVICE_INTERNAL_URL = "http://127.0.0.1:3100"
$env:AGENT_SERVICE_PROXY_TOKEN = "replace-with-the-same-long-random-token"
npm run dev -- --port 3001
```

```powershell
# Terminal 2: Agent Service on http://127.0.0.1:3100
$env:AGENT_SERVICE_PROXY_TOKEN = "replace-with-the-same-long-random-token"
$env:AGENT_SERVICE_TRUSTED_ORIGINS = "http://127.0.0.1:3001,http://localhost:3001"
$env:AGENT_SERVICE_BODY_LIMIT_BYTES = "1048576"
$env:AGENT_SERVICE_REQUEST_DEADLINE_MS = "10000"
$env:AGENT_SQLITE_PATH = (Join-Path $PWD "data\agent-service.sqlite")
$env:AGENT_SQLITE_BUSY_TIMEOUT_MS = "5000"
npm run agent:dev
```

Keep the default loopback host for local development. Browser code calls the
same-origin vinext route under `/api/agent/v1/*`; the Web process adds the
internal token and its trusted origin. Direct requests to Agent Service
`/v1/*` without both values are rejected. `GET /health` remains public for a
local process supervisor. `GET /api/health` on the Web process probes Agent
Service with a two-second bound and returns only `ok` or `degraded`; it does not
return the internal Agent URL.

The Agent Service exclusively owns the configured database. Empty
`AGENT_DATABASE_URL` selects the persistent SQLite file at `AGENT_SQLITE_PATH`;
startup applies checksum-verified migrations and enables foreign keys, WAL
mode, and the configured busy timeout on every SQLite connection. A non-empty
`AGENT_DATABASE_URL` must be a `postgres://` or `postgresql://` URL; invalid
values fail closed during Agent Service startup. Tests use databases under the
operating system temporary directory rather than writing into the repository.

Production deployments must not set
`AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1`,
`AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1`, or
`AGENT_AUTH_ALLOW_INSECURE_PRIVATE_NETWORK_COOKIE=1`, or
`AGENT_VOC_LOCAL_FAKE=1`. Those flags are only for explicitly configured local
development or private-LAN testing.

The non-watching Agent Service command is:

```bash
npm run agent:start
```

Stop either process with `Ctrl+C`. The Agent Service stops accepting new work,
allows bounded in-flight handlers to finish, closes idle connections, and then
exits.

## Agent Service status

The Web-side client and `GET /v1/capabilities` expose separate failure states:

- missing Web proxy URL/token: `CONFIGURATION_ERROR` / `Agent Service is not configured`;
- port 3100 not running: `AGENT_SERVICE_UNAVAILABLE` / `Agent Service is unavailable`;
- missing storage, OpenAI, or connector configuration: capability has
  `configured: false` and a public reason;
- a successfully opened SQLite repository reports storage as available;
- configured but not-yet-available connector/runtime components: capability has
  `configured: true`, `available: false`, and no credential value.

For a local capability check, call
`http://127.0.0.1:3001/api/agent/v1/capabilities` through the Web process. Do
not expose port 3100 publicly.

This starter does not use `wrangler.jsonc`.

## Included Shape

- edit site code under `app/`
- `.openai/hosting.json` declares optional Sites D1 and R2 bindings
- `vite.config.ts` simulates declared bindings for local development
- `db/schema.ts` starts intentionally empty
- `examples/d1/` contains an optional D1 example surface
- `drizzle.config.ts` supports local migration generation when needed

## Workspace Auth Headers

OpenAI workspace sites can read the current user's email from
`oai-authenticated-user-email`.

SIWC-authenticated workspace sites may also receive
`oai-authenticated-user-full-name` when the user's SIWC profile has a non-empty
`name` claim. The full-name value is percent-encoded UTF-8 and is accompanied by
`oai-authenticated-user-full-name-encoding: percent-encoded-utf-8`.

Treat the full name as optional and fall back to email when it is absent:

```tsx
import { headers } from "next/headers";

export default async function Home() {
  const requestHeaders = await headers();
  const email = requestHeaders.get("oai-authenticated-user-email");
  const encodedFullName = requestHeaders.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    requestHeaders.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? decodeURIComponent(encodedFullName)
      : null;

  const displayName = fullName ?? email;
  // ...
}
```

## Optional Dispatch-Owned ChatGPT Sign-In

Import the ready-to-use helpers from `app/chatgpt-auth.ts` when the site needs
optional or required ChatGPT sign-in:

- Use `getChatGPTUser()` for optional signed-in UI.
- Use `requireChatGPTUser(returnTo)` for server-rendered pages that should send
  anonymous visitors through Sign in with ChatGPT.
- Use `chatGPTSignInPath(returnTo)` and `chatGPTSignOutPath(returnTo)` for
  browser links or actions.
- Pass a same-origin relative `returnTo` path for the destination after sign-in
  or sign-out. The helper validates and safely encodes it.
- Mark protected pages with `export const dynamic = "force-dynamic"` because
  they depend on per-request identity headers.

Dispatch owns `/signin-with-chatgpt`, `/signout-with-chatgpt`, `/callback`, the
OAuth cookies, and identity header injection. Do not implement app routes for
those reserved paths. Routes that do not import and call the helper remain
anonymous-compatible.

SIWC establishes identity only; it does not prove workspace membership. Use the
Sites hosting platform's access policy controls for workspace-wide restrictions,
or enforce explicit server-side membership or allowlist checks.

Use SIWC for account pages, user-specific dashboards, saved records, and write
actions tied to the current ChatGPT user. Leave public content anonymous.

## Useful Commands

- `npm run dev`: start local development
- `npm run web:start`: start only the production Web process on `127.0.0.1:3001`
- `npm run agent:dev`: start the Node Agent Service with file watching
- `npm run agent:start`: start the Node Agent Service without file watching
- `npm run stack:dev`: start Web plus Agent Service in local development mode
- `npm run stack:start`: start Web plus Agent Service in production mode after build
- `npm run smoke:stack:postgres`: run the real PostgreSQL dual-process restart smoke
- `npm run test:agent`: run the Agent Service test suite
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
