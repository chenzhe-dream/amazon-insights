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
then use that same value in both PowerShell terminals below. The commands set
the variables explicitly because `npm run agent:dev` does not load `.env` on
behalf of the standalone Node process.

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
npm run agent:dev
```

Keep the default loopback host for local development. Browser code calls the
same-origin vinext route under `/api/agent/v1/*`; the Web process adds the
internal token and its trusted origin. Direct requests to Agent Service
`/v1/*` without both values are rejected. `GET /health` remains public for a
local process supervisor.

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
- configured but not-yet-available connector/runtime: capability has
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
- `npm run agent:dev`: start the Node Agent Service with file watching
- `npm run agent:start`: start the Node Agent Service without file watching
- `npm run test:agent`: run the Agent Service test suite
- `npm run build`: verify the vinext build output
- `npm test`: build the starter and verify its rendered loading skeleton
- `npm run db:generate`: generate Drizzle migrations after schema changes

## Learn More

- [vinext Documentation](https://github.com/cloudflare/vinext)
- [Drizzle D1 Guide](https://orm.drizzle.team/docs/get-started/d1-new)
