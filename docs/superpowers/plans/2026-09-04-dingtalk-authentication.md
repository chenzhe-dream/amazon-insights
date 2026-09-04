# DingTalk Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add tenant-bound DingTalk workbench SSO and browser OAuth while preserving the existing password fallback, roles, sessions, and analysis runtime.

**Architecture:** The Web process owns browser redirects and delegates typed JSON requests to the loopback-only Agent Service. The Agent Service owns all DingTalk secrets, provider calls, tenant verification, atomic member provisioning, OAuth state consumption, and existing session issuance. SQLite and PostgreSQL implement one shared DingTalk authentication repository contract.

**Tech Stack:** TypeScript 5.9, React 19, Vinext/Next route handlers, Fastify 5, Zod 4, SQLite, PostgreSQL, Node test runner, `dingtalk-jsapi@3.2.9`.

## Global Constraints

- Public browser traffic and DingTalk callbacks use Web port `31900`; Agent port `31901` remains loopback-only.
- Only identities verified against configured `DINGTALK_CORP_ID` may authenticate.
- Automatic provisioning always creates `role=member`; it never creates or promotes an administrator.
- Existing email/password login remains available as an administrator fallback.
- Client Secret, auth codes, access tokens, raw OAuth state, and full cookies never appear in client data or logs.
- Local development may use the existing explicit insecure-cookie compatibility flag; production requires HTTPS and Secure cookies.
- No analysis, VOC, image, SellerSprite, review, or job-queue behavior changes.

---

### Task 1: Typed DingTalk configuration and HTTP contracts

**Files:**
- Modify: `shared/agent-contracts.ts`
- Modify: `server/config.ts`
- Modify: `app/lib/agent-service-client.ts`
- Modify: `.env.example`
- Test: `tests/agent/auth-config.test.ts`
- Test: `tests/agent/auth-routes.test.ts`

**Interfaces:**
- Produces: `DingTalkAuthenticationConfig`, `loadDingTalkAuthenticationConfig(env)`, `DingTalkPublicConfigResponseSchema`, `DingTalkWorkbenchLoginRequestSchema`, `DingTalkOAuthStartRequestSchema`, `DingTalkOAuthCallbackRequestSchema`, and matching response schemas.
- Configuration is a discriminated union: `{ enabled: false }` or a complete enabled record. Partial configuration throws a generic configuration error naming missing variable keys but never values.

- [ ] **Step 1: Write failing configuration and contract tests**

```ts
assert.deepEqual(loadDingTalkAuthenticationConfig({ DINGTALK_ENABLED: "0" }), {
  enabled: false,
});
assert.throws(
  () => loadDingTalkAuthenticationConfig({ DINGTALK_ENABLED: "1" }),
  /DingTalk authentication configuration is incomplete/,
);
assert.equal(
  DingTalkWorkbenchLoginRequestSchema.safeParse({ code: "A".repeat(32) }).success,
  true,
);
assert.equal(
  findHttpContract("POST", "/v1/auth/dingtalk/workbench")?.path,
  "/v1/auth/dingtalk/workbench",
);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts`

Expected: FAIL because the DingTalk loader and schemas do not exist.

- [ ] **Step 3: Add strict schemas, types, route registry entries, and client route types**

```ts
export const DingTalkPublicConfigResponseSchema = z.discriminatedUnion("enabled", [
  strictObject({ enabled: z.literal(false) }),
  strictObject({
    enabled: z.literal(true),
    clientId: z.string().trim().min(1).max(200),
    corpId: z.string().trim().min(1).max(200),
    agentId: z.string().trim().min(1).max(200),
  }),
]);
export const DingTalkWorkbenchLoginRequestSchema = strictObject({
  code: z.string().trim().min(1).max(2_000),
});
export const DingTalkOAuthStartRequestSchema = strictObject({
  returnPath: z.string().trim().min(1).max(2_000),
});
export const DingTalkOAuthCallbackRequestSchema = strictObject({
  code: z.string().trim().min(1).max(2_000),
  state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export const DingTalkOAuthStartResponseSchema = strictObject({
  authorizationUrl: z.url(),
  expiresAt: DateTimeSchema,
});
export const DingTalkOAuthCallbackResponseSchema = strictObject({
  user: UserSchema,
  returnPath: z.string().trim().min(1).max(2_000),
});
```

The enabled config contains `clientId`, `clientSecret`, `corpId`, `agentId`, `localOrganizationId`, `redirectUri`, `oauthStateTtlMs: 300_000`, and provider endpoint constants. `localOrganizationId` must be a UUIDv4 and `redirectUri` must be an exact absolute HTTP/HTTPS URL without credentials or fragment.

- [ ] **Step 4: Update `.env.example` with blank non-secret values and secret warnings**

```text
DINGTALK_ENABLED=0
DINGTALK_CLIENT_ID=
DINGTALK_CLIENT_SECRET=
DINGTALK_CORP_ID=
DINGTALK_AGENT_ID=
DINGTALK_LOCAL_ORGANIZATION_ID=
DINGTALK_REDIRECT_URI=
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts`

Expected: PASS with no failed tests.

- [ ] **Step 6: Commit**

```bash
git add shared/agent-contracts.ts server/config.ts app/lib/agent-service-client.ts .env.example tests/agent/auth-config.test.ts tests/agent/auth-routes.test.ts
git commit -m "feat(auth): define DingTalk authentication contracts"
```

### Task 2: Persistent OAuth state and external identity mapping

**Files:**
- Create: `server/db/migrations/0025_dingtalk_authentication.sql`
- Create: `server/db/migrations/postgres/0025_dingtalk_authentication.sql`
- Modify: `server/db/repository.ts`
- Modify: `server/db/sqlite-repository.ts`
- Modify: `server/db/postgres/core-store.ts`
- Modify: `server/db/postgres-repository.ts`
- Test: `tests/agent/dingtalk-auth-repository.test.ts`
- Test: `tests/agent/postgres-dingtalk-auth-repository.test.ts`
- Test: `tests/agent/repository.test.ts`

**Interfaces:**
- Produces: `DingTalkAuthenticationRepository` with `createOAuthLoginState`, `consumeOAuthLoginState`, and `findOrCreateDingTalkUser`.
- Consumes: validated UUIDs, SHA-256 state hash, canonical timestamps, verified CorpId/member ID, and candidate/fallback email addresses.

- [ ] **Step 1: Write failing SQLite repository tests**

```ts
const created = await repository.createOAuthLoginState({
  stateHash: "a".repeat(64),
  returnPath: "/",
  expiresAt: "2026-09-04T08:05:00.000Z",
  createdAt: "2026-09-04T08:00:00.000Z",
});
assert.equal(created.returnPath, "/");
assert.equal((await repository.consumeOAuthLoginState({
  stateHash: created.stateHash,
  asOf: "2026-09-04T08:01:00.000Z",
  consumedAt: "2026-09-04T08:01:00.000Z",
}))?.returnPath, "/");
assert.equal(await repository.consumeOAuthLoginState({
  stateHash: created.stateHash,
  asOf: "2026-09-04T08:02:00.000Z",
  consumedAt: "2026-09-04T08:02:00.000Z",
}), null);
```

Add cases for expired state, concurrent first login, existing disabled user, existing admin role preservation, corporate-email collision fallback, and `member`-only first provisioning.

- [ ] **Step 2: Run SQLite tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-auth-repository.test.ts`

Expected: FAIL because migration 0025 and repository methods do not exist.

- [ ] **Step 3: Add equivalent SQLite and PostgreSQL migrations**

```sql
CREATE TABLE auth_identities (
  provider TEXT NOT NULL CHECK (provider = 'dingtalk'),
  corp_id TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_login_at TEXT NOT NULL,
  PRIMARY KEY (provider, corp_id, subject_id),
  UNIQUE (provider, user_id)
);

CREATE TABLE oauth_login_states (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider = 'dingtalk'),
  return_path TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);
```

The PostgreSQL version uses `TIMESTAMPTZ`, equivalent checks, foreign keys, and indexes. Neither table stores raw state, auth codes, tokens, or secrets.

- [ ] **Step 4: Implement the shared repository contract atomically**

```ts
export interface DingTalkAuthenticationRepository {
  createOAuthLoginState(input: OAuthLoginStateRecord): Promise<OAuthLoginStateRecord>;
  consumeOAuthLoginState(input: {
    stateHash: string;
    asOf: string;
    consumedAt: string;
  }): Promise<OAuthLoginStateRecord | null>;
  findOrCreateDingTalkUser(input: VerifiedDingTalkUserInput): Promise<{
    user: UserRecord;
    created: boolean;
  }>;
}
```

The identity operation runs in one transaction. It first reads an existing `(dingtalk, corpId, subjectId)` binding. Existing roles are never changed; disabled users are returned for service-level denial. A new user is inserted with `role='member'`, `status='active'`, then the identity and `auth.dingtalk-user-created` audit event are inserted. Email collisions use the deterministic `@identity.invalid` fallback and never bind to an existing account by email alone.

- [ ] **Step 5: Run SQLite tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-auth-repository.test.ts tests/agent/repository.test.ts`

Expected: PASS.

- [ ] **Step 6: Add and run the equivalent PostgreSQL contract tests when `TEST_POSTGRES_URL` is available**

Run: `npx tsx --conditions=react-server --test tests/agent/postgres-dingtalk-auth-repository.test.ts`

Expected: PASS, or an explicit environment skip when no PostgreSQL test URL is configured.

- [ ] **Step 7: Commit**

```bash
git add server/db/migrations/0025_dingtalk_authentication.sql server/db/migrations/postgres/0025_dingtalk_authentication.sql server/db/repository.ts server/db/sqlite-repository.ts server/db/postgres/core-store.ts server/db/postgres-repository.ts tests/agent/dingtalk-auth-repository.test.ts tests/agent/postgres-dingtalk-auth-repository.test.ts tests/agent/repository.test.ts
git commit -m "feat(auth): persist DingTalk identities and OAuth state"
```

### Task 3: DingTalk provider adapter

**Files:**
- Create: `server/auth/dingtalk-provider.ts`
- Test: `tests/agent/dingtalk-provider.test.ts`

**Interfaces:**
- Produces: `DingTalkIdentityProvider`, `RemoteDingTalkIdentityProvider`, `VerifiedDingTalkIdentity`, and typed provider failures.
- Consumes: enabled `DingTalkAuthenticationConfig`, injected `fetch`, and workbench/OAuth codes.

- [ ] **Step 1: Write failing provider tests with an injected fetch recorder**

```ts
const identity = await provider.exchangeWorkbenchCode("workbench-code");
assert.deepEqual(identity, {
  corpId: CORP_ID,
  subjectId: "employee-123",
  displayName: "测试成员",
  email: "member@example.com",
  active: true,
});
assert.equal(observedBodies.some((body) => JSON.stringify(body).includes(CLIENT_SECRET)), true);
assert.equal(JSON.stringify(identity).includes(CLIENT_SECRET), false);
```

Cover app-token acquisition, workbench code exchange, OAuth user-token exchange, OAuth `unionId` to enterprise `userId` resolution, member-detail lookup, nonmember rejection, inactive member rejection, timeouts, non-JSON, oversized bodies, and error sanitization.

- [ ] **Step 2: Run provider tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-provider.test.ts`

Expected: FAIL because the provider module does not exist.

- [ ] **Step 3: Implement the bounded provider adapter**

```ts
export interface DingTalkIdentityProvider {
  exchangeWorkbenchCode(code: string): Promise<VerifiedDingTalkIdentity>;
  exchangeOAuthCode(code: string): Promise<VerifiedDingTalkIdentity>;
}

export interface VerifiedDingTalkIdentity {
  corpId: string;
  subjectId: string;
  displayName: string;
  email: string | null;
  active: boolean;
}
```

Use the official application access-token endpoint, workbench auth-code endpoint, OAuth user-access-token endpoint, current-user endpoint, unionId-to-userId endpoint, and member-detail endpoint. Every response is size-bounded and schema-validated. Requests use `AbortController`; provider errors expose only stable categories: `invalid-code`, `not-member`, `inactive-member`, `tenant-mismatch`, and `unavailable`.

- [ ] **Step 4: Run provider tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-provider.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/auth/dingtalk-provider.ts tests/agent/dingtalk-provider.test.ts
git commit -m "feat(auth): verify DingTalk enterprise identities"
```

### Task 4: OAuth state, member provisioning, and session issuance service

**Files:**
- Create: `server/auth/dingtalk-state-cookie.ts`
- Create: `server/auth/dingtalk-authentication-service.ts`
- Modify: `server/auth/authentication-service.ts`
- Test: `tests/agent/dingtalk-authentication-service.test.ts`
- Test: `tests/agent/session-auth.test.ts`

**Interfaces:**
- Produces: `DingTalkAuthenticationService.publicConfig()`, `startOAuth(returnPath)`, `completeOAuth(input)`, `loginWorkbench(code)`, and `AuthenticationService.issueSessionForVerifiedUser(user)`.
- Consumes: Task 1 config, Task 2 repository, Task 3 provider, and existing session token/cookie primitives.

- [ ] **Step 1: Write failing service and state-cookie tests**

```ts
const started = await service.startOAuth("/");
assert.match(started.authorizationUrl, /^https:\/\/login\.dingtalk\.com\/oauth2\/auth\?/);
assert.equal(started.rawState.length, 43);

const completed = await service.completeOAuth({
  code: "oauth-code",
  state: started.rawState,
  cookieState: started.rawState,
});
assert.equal(completed.user.role, "member");
assert.equal(completed.returnPath, "/");
await assert.rejects(
  service.completeOAuth({ code: "oauth-code", state: started.rawState, cookieState: started.rawState }),
  /state/i,
);
```

Add tenant mismatch, constant-time cookie/query mismatch, disabled user, safe return-path validation, email fallback, existing admin role preservation, and identical password/DingTalk session profile cases.

- [ ] **Step 2: Run service tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-authentication-service.test.ts tests/agent/session-auth.test.ts`

Expected: FAIL because the service and verified-user session method do not exist.

- [ ] **Step 3: Implement OAuth state and identity completion**

```ts
async completeOAuth(input: {
  code: string;
  state: string;
  cookieState: string | null;
}) {
  assertMatchingOAuthState(input.state, input.cookieState);
  const now = this.now();
  const stored = await this.repository.consumeOAuthLoginState({
    stateHash: digestOAuthState(input.state),
    asOf: now.toISOString(),
    consumedAt: now.toISOString(),
  });
  if (!stored) throw new DingTalkAuthenticationError("invalid-state");
  const identity = await this.provider.exchangeOAuthCode(input.code);
  return { ...(await this.finishVerifiedIdentity(identity)), returnPath: stored.returnPath };
}
```

Generate 32 random bytes for state, store only SHA-256, use a five-minute TTL, and construct the official authorization URL with `client_id`, exact `redirect_uri`, `response_type=code`, `scope=openid`, and `state`. The deterministic fallback email is `dingtalk-<sha256(corpId + NUL + subjectId).slice(0,32)>@identity.invalid`.

- [ ] **Step 4: Reuse the existing session issuer**

Move only the common active-user session creation into `issueSessionForVerifiedUser`. Password verification remains exclusively inside `login`; DingTalk can call the issuer only after Provider verification and repository binding.

- [ ] **Step 5: Run service and existing password tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-authentication-service.test.ts tests/agent/authentication-service.test.ts tests/agent/session-auth.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/auth/dingtalk-state-cookie.ts server/auth/dingtalk-authentication-service.ts server/auth/authentication-service.ts tests/agent/dingtalk-authentication-service.test.ts tests/agent/session-auth.test.ts
git commit -m "feat(auth): issue sessions for verified DingTalk members"
```

### Task 5: Agent routes and Web OAuth bridge

**Files:**
- Create: `server/routes/dingtalk-auth.ts`
- Modify: `server/app.ts`
- Modify: `server/agent-service.ts`
- Modify: `server/auth/authorization.ts`
- Create: `app/api/auth/dingtalk/config/route.ts`
- Create: `app/api/auth/dingtalk/start/route.ts`
- Create: `app/api/auth/dingtalk/callback/route.ts`
- Test: `tests/agent/dingtalk-auth-routes.test.ts`
- Test: `tests/agent/dingtalk-web-routes.test.ts`
- Test: `tests/agent/auth-authorization.test.ts`
- Test: `tests/agent/proxy.test.ts`

**Interfaces:**
- Produces public Web routes from the design and proxy-only Agent routes `/v1/auth/dingtalk/config`, `/workbench`, `/oauth/start`, and `/oauth/callback`.
- Consumes Task 1 contracts and Task 4 service.

- [ ] **Step 1: Write failing Fastify and Web route tests**

```ts
assert.deepEqual(classifyRoute("POST", "/v1/auth/dingtalk/workbench"), {
  kind: "proxy-only",
});
const started = await GET(new Request("http://127.0.0.1:31900/api/auth/dingtalk/start?returnPath=/"));
assert.equal(started.status, 302);
assert.match(started.headers.get("location") ?? "", /^https:\/\/login\.dingtalk\.com\//);
assert.match(started.headers.get("set-cookie") ?? "", /dingtalk_oauth_state=/);
```

Cover disabled configuration, invalid state, sanitized provider errors, Session Cookie forwarding, OAuth-state Cookie clearing, safe same-origin redirects, and secrets absent from responses/logs.

- [ ] **Step 2: Run route tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-auth-routes.test.ts tests/agent/dingtalk-web-routes.test.ts tests/agent/auth-authorization.test.ts tests/agent/proxy.test.ts`

Expected: FAIL because routes and classifications do not exist.

- [ ] **Step 3: Register proxy-only Agent routes and wire the service**

```ts
if (!dingTalkService) {
  return reply.status(503).send(publicError(
    "CONFIGURATION_ERROR",
    "DingTalk authentication is not configured",
    request.id,
  ));
}
```

The workbench and OAuth callback handlers serialize exactly the existing session cookie. Start serializes the short-lived OAuth state cookie. Callback always clears the OAuth state cookie. Add `code`, `state`, `authorization`, and DingTalk token fields to Fastify logger redaction paths.

- [ ] **Step 4: Implement three Web bridge routes**

Each route calls `createAgentServiceClient()` with the browser `cookie`, same-origin `origin`, and a request ID. Start returns a 302 to the validated DingTalk authorization URL. Callback forwards every safe `Set-Cookie` value and redirects only to the validated returned local path; failures redirect with one of the fixed codes `invalid_state`, `invalid_code`, `not_member`, `disabled`, or `unavailable`.

- [ ] **Step 5: Run route and proxy tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-auth-routes.test.ts tests/agent/dingtalk-web-routes.test.ts tests/agent/auth-authorization.test.ts tests/agent/proxy.test.ts tests/agent/auth-routes.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/dingtalk-auth.ts server/app.ts server/agent-service.ts server/auth/authorization.ts app/api/auth/dingtalk app/lib/agent-service-client.ts tests/agent/dingtalk-auth-routes.test.ts tests/agent/dingtalk-web-routes.test.ts tests/agent/auth-authorization.test.ts tests/agent/proxy.test.ts tests/agent/auth-routes.test.ts
git commit -m "feat(auth): expose DingTalk login routes"
```

### Task 6: Workbench JSAPI and login UI

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `app/lib/dingtalk-browser.ts`
- Modify: `app/lib/web-auth-session.ts`
- Modify: `app/auth-session-gate.tsx`
- Modify: `app/globals.css`
- Test: `tests/agent/dingtalk-browser.test.ts`
- Test: `tests/agent/web-auth-session.test.ts`
- Test: `tests/agent/auth-session-gate.test.tsx`

**Interfaces:**
- Produces: `readDingTalkPublicConfig()`, `requestDingTalkWorkbenchCode()`, `loginWithDingTalkWorkbenchCode()`, and a login-card state that attempts workbench SSO once per page lifecycle.
- Consumes `dingtalk-jsapi@3.2.9` and Task 5 routes.

- [ ] **Step 1: Install the pinned JSAPI package**

Run: `npm install dingtalk-jsapi@3.2.9 --save-exact`

Expected: `package.json` and lockfile record exactly `3.2.9`.

- [ ] **Step 2: Write failing browser and rendered-login tests**

```ts
assert.equal(isDingTalkContainer({ userAgent: "DingTalk/7.6.0" }), true);
assert.equal(isDingTalkContainer({ userAgent: "Chrome/140" }), false);
assert.match(rendered, /使用钉钉登录/);
assert.match(rendered, /管理员邮箱登录/);
```

Test successful one-time automatic workbench login, JSAPI cancellation, JSAPI failure without a loop, OAuth button target, disabled configuration hiding the DingTalk entry, and password fallback unchanged.

- [ ] **Step 3: Run UI tests and verify RED**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-browser.test.ts tests/agent/web-auth-session.test.ts tests/agent/auth-session-gate.test.tsx`

Expected: FAIL because the browser adapter and UI controls do not exist.

- [ ] **Step 4: Implement the browser adapter and one-shot controller behavior**

```ts
export async function requestDingTalkWorkbenchCode(corpId: string) {
  const dd = await import("dingtalk-jsapi");
  const result = await dd.runtime.permission.requestAuthCode({ corpId });
  return DingTalkAuthCodeResultSchema.parse(result).code;
}
```

Container detection only chooses UX; it never authenticates. `AuthSessionGate` invokes the JSAPI at most once after the initial unauthenticated session result. Authentication succeeds only after the backend exchanges the code and `readWebSession` confirms the issued system session.

- [ ] **Step 5: Add the DingTalk button and restrained login styling**

The DingTalk button is primary when enabled. The password form remains under an “管理员邮箱登录” divider. Error copy distinguishes cancellation, enterprise mismatch, disabled user, expired login, and temporary unavailability without exposing provider data.

- [ ] **Step 6: Run UI tests and verify GREEN**

Run: `npx tsx --conditions=react-server --test tests/agent/dingtalk-browser.test.ts tests/agent/web-auth-session.test.ts tests/agent/auth-session-gate.test.tsx tests/agent/authentication-service.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json app/lib/dingtalk-browser.ts app/lib/web-auth-session.ts app/auth-session-gate.tsx app/globals.css tests/agent/dingtalk-browser.test.ts tests/agent/web-auth-session.test.ts tests/agent/auth-session-gate.test.tsx
git commit -m "feat(auth): add DingTalk login experience"
```

### Task 7: Runtime documentation and complete verification

**Files:**
- Modify: `README.md`
- Modify: `scripts/formal-stack.env.example`
- Modify: `docs/superpowers/specs/2026-09-04-dingtalk-authentication-design.md`
- Test: existing full suites

**Interfaces:**
- Produces exact local-development and production configuration instructions without committing real credentials.
- Consumes all prior tasks.

- [ ] **Step 1: Document the local development configuration**

Document the exact callback `http://127.0.0.1:31900/api/auth/dingtalk/callback`, Web/Agent port separation, how to find the existing system organization UUID, where to place noncommitted variables, and that “接入分享” is not required.

- [ ] **Step 2: Document production promotion**

Document a second DingTalk application, HTTPS-only callback, server Secret storage, restricted initial visibility, and a rollback that sets `DINGTALK_ENABLED=0` while retaining password login.

- [ ] **Step 3: Run contract, repository, provider, route, UI, and security suites**

Run: `npx tsx --conditions=react-server --test tests/agent/*.test.ts`

Expected: all tests pass, with PostgreSQL integration tests explicitly skipped only when their configured test service is unavailable.

- [ ] **Step 4: Run lint and production build**

Run: `npm run lint`

Expected: exit 0 with no lint errors.

Run: `npm run build`

Expected: exit 0 and a complete production bundle.

- [ ] **Step 5: Scan tracked files and build output for secret sentinels**

Run: `git grep -n -E "DINGTALK_CLIENT_SECRET=.+|appSecret[[:space:]]*[:=][[:space:]]*['\"][^'\"]+" -- ':!docs/superpowers/plans/*'`

Expected: no real credential values and no embedded secret literal.

- [ ] **Step 6: Mark the design implemented and commit**

```bash
git add README.md scripts/formal-stack.env.example docs/superpowers/specs/2026-09-04-dingtalk-authentication-design.md
git commit -m "docs(auth): explain DingTalk development and production setup"
```

- [ ] **Step 7: Review the final branch diff**

Run: `git status --short && git log --oneline --decorate -10 && git diff 2ea1b3f00d5e31fd0ec7711c90cbf3173faa249f...HEAD --stat`

Expected: clean worktree, focused DingTalk authentication commits, and no unrelated analysis/runtime files.
