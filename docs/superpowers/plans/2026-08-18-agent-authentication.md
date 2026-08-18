# Agent Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete only OpenSpec 4.3 with one-time first-admin bootstrap, bounded scrypt passwords, revocable hashed sessions, secure cookies, bounded login throttling, and minimum `admin`/`member` authorization while retaining one explicit local fixture smoke path.

**Architecture:** The vinext route remains a same-origin proxy and proves server-to-server trust with `x-agent-proxy-token`; a separate opaque session cookie proves browser-user identity. Agent Service owns password verification, session persistence, route policy, and authorization. Stages A–D build and test the layers without protecting existing business routes; Stage E activates fail-closed route protection only after those layers are green.

**Tech Stack:** Node.js 22.13+ `node:crypto`, TypeScript 5.9, Fastify 5, Zod 4, SQLite `node:sqlite`, vinext route handlers, Node test runner through `tsx`.

## Global Constraints

- Complete only task 4.3; do not implement 4.4 or 12.2.
- Do not modify migrations `0001`–`0008` or create `0009`; existing `users.password_hash`, `sessions`, and `audit_events` are sufficient.
- Add no dependency. `package.json` may gain only `admin:init`; `package-lock.json` remains unchanged.
- Do not redesign UI or add invitation, public registration, reset/email, SSO, MFA, connector-secret editing, rotation, PostgreSQL, distributed sessions, or distributed limiting.
- `/health` remains public with the existing fixed `HealthResponseSchema` shape.
- `/v1/capabilities` always requires the proxy token and returns one identical sanitized shape to authenticated member/admin and explicitly allowed anonymous-loopback smoke.
- `POST /v1/connectors/:connectorId/probe` requires proxy token plus authenticated admin; member and anonymous-loopback receive `403 FORBIDDEN`.
- All other business routes require proxy token plus active server session. Neither credential substitutes for the other.
- Authenticated mode is default. `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1` is valid only outside production when bind and every trusted origin are loopback.
- `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1` is independent and valid only under the same all-loopback, non-production matrix.
- Secure cookies are `__Host-agent_session; Secure; HttpOnly; SameSite=Lax; Path=/` with no `Domain`. Insecure loopback uses `agent_session; HttpOnly; SameSite=Lax; Path=/`, no `Domain`, and no `__Host-` prefix.
- Raw passwords and raw session tokens never enter storage, logs, URLs, JSON, or CLI arguments. SQLite stores a versioned scrypt record and SHA-256 token digest only.
- Unknown, disabled, missing-hash, malformed-hash, and wrong-password login paths each perform one bounded scrypt derivation and return the same response.
- The first-admin command requires an interactive hidden password with confirmation and atomically refuses when any user exists.
- The principal contains only `userId`, `organizationId`, `role`, and `sessionId`; handlers never trust browser actor/organization/role data.
- Do not check 4.3 until Task 6 verification passes. Each stage gets one normal new commit; do not amend, rebase, push, reset, stash, or clean.

---

## Exact File Map

**Create:**

- `server/auth/password.ts` — bounded versioned scrypt.
- `server/auth/session.ts` — random token, digest, cookie parse/serialize.
- `server/auth/login-rate-limiter.ts` — bounded email/source buckets.
- `server/auth/authentication-service.ts` — login/authenticate/logout.
- `server/auth/authorization.ts` — principals, policies, guards.
- `server/routes/auth.ts` — login/logout/current-session routes.
- `server/cli/hidden-password-prompt.ts` — no-echo TTY input.
- `server/cli/init-admin.ts` — one-time local bootstrap.
- Tests: `tests/agent/auth-config.test.ts`, `password-auth.test.ts`, `session-auth.test.ts`, `auth-repository.test.ts`, `login-rate-limiter.test.ts`, `authentication-service.test.ts`, `auth-routes.test.ts`, `auth-authorization.test.ts`, `admin-init-cli.test.ts`.

**Modify:**

- `server/config.ts`, `shared/agent-contracts.ts`, `server/db/repository.ts`, `server/db/sqlite-repository.ts`, `server/app.ts`, `server/agent-service.ts`, `server/routes/analysis-runs.ts`, `server/routes/local-voc.ts`, `server/routes/connectors.ts`, `app/api/agent/[...path]/route.ts`, `app/lib/agent-service-client.ts`, focused existing tests, `package.json`, and finally the 4.3 checkbox.

## Stable Cross-Task Types

```ts
export type AuthenticatedPrincipal = Readonly<{
  kind: "user";
  userId: string;
  organizationId: string;
  role: "admin" | "member";
  sessionId: string;
}>;

export type AnonymousLoopbackPrincipal = Readonly<{ kind: "anonymous-loopback" }>;
export type RequestPrincipal = AuthenticatedPrincipal | AnonymousLoopbackPrincipal;

export interface AgentAuthenticationConfig {
  readonly mode: "authenticated" | "anonymous-loopback";
  readonly cookie: Readonly<{
    name: "__Host-agent_session" | "agent_session";
    secure: boolean;
    maxAgeSeconds: number;
  }>;
  readonly sessionTtlMs: number;
  readonly loginLimiter: Readonly<{
    windowMs: number;
    maxFailures: number;
    maxEntries: number;
  }>;
}
```

## Stage A — Config Matrix and Password/Session Primitives

### Task 1: Fail-Closed Modes and Crypto Boundaries

**Files:** Create `server/auth/password.ts`, `server/auth/session.ts`, and three Stage A tests; modify `server/config.ts`.

**Interfaces:** Produces `loadAgentAuthenticationConfig()`, `hashPassword()`, `verifyPassword()`, `createSessionToken()`, `digestSessionToken()`, `parseSessionCookie()`, `serializeSessionCookie()`, `serializeClearedSessionCookie()`.

- [ ] **A1 — Write config RED tests.** Assert default authenticated/secure mode with 28,800-second TTL, 900,000-ms window, 5 failures, 10,000 entries; assert each loopback flag independently; reject production, wildcard, LAN, mixed origins, and flag strings other than `0`/`1`.

```ts
const loopback = {
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
};
assert.equal(loadAgentAuthenticationConfig(loopback).mode, "authenticated");
assert.equal(loadAgentAuthenticationConfig({
  ...loopback,
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
}).mode, "anonymous-loopback");
assert.throws(() => loadAgentAuthenticationConfig({
  ...loopback,
  NODE_ENV: "production",
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
}), /Agent authentication configuration is invalid/);
```

- [ ] **A2 — Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts`. Expected: FAIL because the export is missing.

- [ ] **A3 — Implement exact config defaults and matrix.** Add `loadAgentAuthenticationConfig(env = process.env)` to `server/config.ts`. `canonicalFlag()` accepts undefined/`0` as false and `1` as true. `isLoopbackHost()` accepts `localhost`, `::1`, and `127.0.0.0/8`; wildcard, LAN, public, empty/mixed origin lists fail when either compatibility flag is enabled. Return the stable type above with:

```ts
return Object.freeze({
  mode: anonymousLoopback ? "anonymous-loopback" : "authenticated",
  cookie: Object.freeze({
    name: insecureCookie ? "agent_session" : "__Host-agent_session",
    secure: !insecureCookie,
    maxAgeSeconds: 28_800,
  }),
  sessionTtlMs: 28_800_000,
  loginLimiter: Object.freeze({
    windowMs: 900_000,
    maxFailures: 5,
    maxEntries: 10_000,
  }),
});
```

- [ ] **A4 — Verify config GREEN.** Re-run A2. Expected: PASS.

- [ ] **A5 — Write password/session RED tests.** Require distinct salts, correct/wrong verification, malformed/excessive-cost fail closed, 43-character base64url raw token, 64-character lowercase digest, duplicate-cookie rejection, exact secure/insecure cookie strings, symmetric clearing, and no `Domain`. Split `DUMMY_PASSWORD_RECORD` and assert exactly six fields, a 16-byte decoded salt, and a 32-byte decoded derived key. Inject a counting scrypt deriver into `verifyPassword()`, verify the dummy record returns false for a submitted password, and assert the deriver ran exactly once; a parser-fast-fail is not acceptable.

```ts
const first = await hashPassword("correct horse battery staple");
const second = await hashPassword("correct horse battery staple");
assert.match(first, /^scrypt-v1\$16384\$8\$1\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
assert.notEqual(first, second);
assert.equal(await verifyPassword("correct horse battery staple", first), true);
assert.equal(await verifyPassword("wrong password", first), false);

const token = createSessionToken(() => Buffer.alloc(32, 7));
assert.match(token.rawToken, /^[A-Za-z0-9_-]{43}$/);
assert.match(token.tokenHash, /^[0-9a-f]{64}$/);
```

- [ ] **A6 — Verify primitive RED.** Run `npx tsx --conditions=react-server --test tests/agent/password-auth.test.ts tests/agent/session-auth.test.ts`. Expected: module-not-found failure.

- [ ] **A7 — Implement bounded scrypt.** Use this profile and fixed non-secret dummy record:

```ts
const PROFILE = Object.freeze({
  N: 16_384, r: 8, p: 1, keyLength: 32, saltLength: 16, maxmem: 67_108_864,
});
export const DUMMY_PASSWORD_RECORD =
  "scrypt-v1$16384$8$1$YWdlbnQtYXV0aC1kdW1teQ$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
```

The dummy salt is the base64url encoding of the exact 16-byte text `agent-auth-dummy`; its 43-character key field decodes to 32 zero bytes. The key is intentionally not a valid password result, but the complete record must pass the closed parser and reach scrypt.

`hashPassword(password)` enforces 12–1,024 characters, uses `randomBytes(16)`, async `scrypt`, and the exact six-field encoding. `verifyPassword(password, encoded, derive = derivePassword)` parses the closed regex, checks exact N/r/p and decoded lengths before derivation, invokes the injected/default async scrypt deriver once, calls `timingSafeEqual`, and returns false for parsing/crypto failure without exposing the cause. The optional deriver is a test seam; production always uses the Node scrypt-backed default.

- [ ] **A8 — Implement session primitives.** `createSessionToken()` calls `randomBytes(32)`, base64url-encodes raw bytes, and hashes raw text with SHA-256. `parseSessionCookie()` accepts exactly one profile cookie matching 43 base64url characters. Serializers emit exact attributes:

```ts
`${profile.name}=${raw}; Max-Age=${profile.maxAgeSeconds}; Path=/; HttpOnly${
  profile.secure ? "; Secure" : ""
}; SameSite=Lax`
```

- [ ] **A9 — Verify Stage A.** Run `npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/password-auth.test.ts tests/agent/session-auth.test.ts tests/agent/service-security.test.ts`. Expected: PASS; business routes are not protected yet.

- [ ] **A10 — Commit.** `git add server/config.ts server/auth/password.ts server/auth/session.ts tests/agent/auth-config.test.ts tests/agent/password-auth.test.ts tests/agent/session-auth.test.ts && git commit -m "feat(auth): add authentication primitives"`. Expected: one commit and clean status.

## Stage B — Existing-Schema Bootstrap and Sessions

### Task 2: Atomic First Admin and Hashed Session Repository

**Files:** Create `tests/agent/auth-repository.test.ts`; modify `server/db/repository.ts` and `server/db/sqlite-repository.ts`; verify migrations unchanged.

**Interfaces:**

```ts
export interface AuthenticationUserRecord {
  readonly user: UserRecord;
  readonly passwordHash: string | null;
}
export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
}
export interface ActiveSessionPrincipalRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly organizationId: string;
  readonly role: "admin" | "member";
}
export interface AuthenticationRepository {
  createInitialAdmin(input: InitialAdminInput): Promise<UserRecord | null>;
  findAuthenticationUserByEmail(email: string): Promise<AuthenticationUserRecord | null>;
  createSession(session: SessionRecord): Promise<SessionRecord>;
  findActiveSessionPrincipalByTokenHash(input: { tokenHash: string; asOf: string }): Promise<ActiveSessionPrincipalRecord | null>;
  revokeSessionByTokenHash(input: { tokenHash: string; revokedAt: string }): Promise<boolean>;
  revokeUserSessions(input: { userId: string; revokedAt: string }): Promise<number>;
}
```

`InitialAdminInput` contains `id`, `organizationId`, `email`, `displayName`, `passwordHash`, and `createdAt`, all strings. `AgentRepository` extends `AuthenticationRepository`; all current methods remain unchanged.

- [ ] **B1 — Write repository RED tests.** Use temporary SQLite to prove: exactly one initial admin and one `auth.first-admin-initialized` audit event; repeated and concurrent bootstrap return null without mutation; email lookup is case-insensitive; raw token bytes are absent from the database file; active session resolves role/org; expired, revoked, disabled-user, and malformed rows fail closed; revoke is idempotent; revoke-user affects every active session.

```ts
const first = await repository.createInitialAdmin({
  id: ADMIN_ID,
  organizationId: ORGANIZATION_ID,
  email: "admin@example.com",
  displayName: "First Admin",
  passwordHash: PASSWORD_RECORD,
  createdAt: NOW,
});
assert.equal(first?.role, "admin");
assert.equal(await repository.createInitialAdmin(SECOND_INPUT), null);
```

- [ ] **B2 — Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/auth-repository.test.ts`. Expected: compile failure for missing repository methods.

- [ ] **B3 — Implement atomic bootstrap.** Inside the repository's serialized immediate transaction execute:

```sql
INSERT INTO users (
  id, organization_id, email, display_name, password_hash,
  role, status, created_at, updated_at
)
SELECT ?, ?, ?, ?, ?, 'admin', 'active', ?, ?
WHERE NOT EXISTS (SELECT 1 FROM users)
```

When `changes !== 1`, return null and insert no event. On success append `audit_events` action `auth.first-admin-initialized`, target type `user`, target ID admin ID, metadata `{"role":"admin"}`. Return `mapUser()` only; never add password hash to ordinary `UserRecord`.

- [ ] **B4 — Implement auth lookup and sessions.** Private email lookup selects `password_hash`. Active lookup uses:

```sql
SELECT s.id AS session_id, u.id AS user_id, u.organization_id, u.role
FROM sessions s
JOIN users u ON u.id = s.user_id
WHERE s.token_hash = ?
  AND s.revoked_at IS NULL
  AND s.expires_at > ?
  AND u.status = 'active'
```

Validate token hash as lowercase 64-hex and timestamps/roles through closed parsers. Session inserts accept only digest, never raw token.

- [ ] **B5 — Verify GREEN and migration safety.** Run `npx tsx --conditions=react-server --test tests/agent/auth-repository.test.ts tests/agent/repository.test.ts tests/agent/sqlite-migrations.test.ts`. Then run `git diff --exit-code HEAD -- server/db/migrations`. Expected: tests PASS and diff exits 0 with no output.

- [ ] **B6 — Commit.** `git add server/db/repository.ts server/db/sqlite-repository.ts tests/agent/auth-repository.test.ts && git commit -m "feat(auth): persist admins and sessions"`. Expected: no migration in commit.

## Stage C — Authentication Service and Limiter

### Task 3: Generic Login Outcomes and Dual-Dimension Throttling

**Files:** Create `server/auth/login-rate-limiter.ts`, `server/auth/authentication-service.ts`, `tests/agent/login-rate-limiter.test.ts`, and `tests/agent/authentication-service.test.ts`.

**Interfaces:**

```ts
export type LoginResult =
  | Readonly<{
      status: "authenticated";
      user: UserRecord;
      principal: AuthenticatedPrincipal;
      rawSessionToken: string;
      expiresAt: string;
    }>
  | Readonly<{ status: "invalid-credentials" }>
  | Readonly<{ status: "rate-limited"; retryAfterSeconds: number }>;

export class BoundedLoginRateLimiter {
  constructor(options: {
    windowMs: number;
    maxFailures: number;
    maxEntries: number;
    now?: () => number;
  });
  check(email: string, source: string): { allowed: boolean; retryAfterSeconds: number };
  recordFailure(email: string, source: string): void;
  recordSuccess(email: string): void;
}

export class AuthenticationService {
  constructor(options: {
    repository: AuthenticationRepository & Pick<AgentRepository, "findUserById">;
    limiter: BoundedLoginRateLimiter;
    sessionTtlMs: number;
    now?: () => Date;
    createId?: () => string;
    createToken?: () => Readonly<{ rawToken: string; tokenHash: string }>;
    verify?: typeof verifyPassword;
  });
  login(input: { email: string; password: string; source: string }): Promise<LoginResult>;
  authenticate(rawToken: string | null): Promise<AuthenticatedPrincipal | null>;
  logout(rawToken: string | null): Promise<void>;
  findPublicUser(userId: string): Promise<UserRecord | null>;
}
```

- [ ] **C1 — Write limiter RED tests.** Five failures exhaust either independent bucket; changing email does not bypass source; changing source does not bypass email; success clears only email; fake-clock expiry removes buckets; exceeding `maxEntries` evicts the oldest expired or least-recent bucket and never exceeds the bound.

```ts
for (let index = 0; index < 5; index += 1) {
  limiter.recordFailure("member@example.com", "203.0.113.7");
}
assert.equal(limiter.check("other@example.com", "203.0.113.7").allowed, false);
assert.equal(limiter.check("member@example.com", "203.0.113.8").allowed, false);
```

- [ ] **C2 — Verify limiter RED.** Run `npx tsx --conditions=react-server --test tests/agent/login-rate-limiter.test.ts`. Expected: module-not-found failure.

- [ ] **C3 — Implement bounded maps.** Store `Bucket { failures, windowStartedAt, lastTouchedAt }` under `email:${normalizedEmail}` and `source:${normalizedSource}`. `check()` expires old entries and denies if either count reaches `maxFailures`; retry is `Math.max(1, Math.ceil(remainingMs / 1000))`. `recordFailure()` increments both. `recordSuccess()` deletes only the email key.

- [ ] **C4 — Verify limiter GREEN.** Re-run C2. Expected: PASS.

- [ ] **C5 — Write service RED tests.** Prove unknown/disabled/missing-hash/malformed-hash/wrong-password all return `{status:"invalid-credentials"}` and invoke verifier once; successful login normalizes email, stores digest only, and returns raw token once; rate-limited requests do not query user or derive; expired/revoked/disabled sessions return null; logout hashes then revokes and is idempotent; repository/crypto errors return safe failure without raw cause. For at least the unknown-user and disabled-user cases, wrap the real `verifyPassword()` with its counting deriver seam and assert one underlying scrypt invocation against `DUMMY_PASSWORD_RECORD`; counting only the outer verifier call does not satisfy this test.

```ts
for (const fixture of ["unknown", "disabled", "missing-hash", "malformed-hash", "wrong-password"] as const) {
  const subject = serviceFixture(fixture);
  assert.deepEqual(await subject.service.login({
    email: "member@example.com",
    password: "submitted password",
    source: "203.0.113.7",
  }), { status: "invalid-credentials" });
  assert.equal(subject.verificationCount(), 1);
}
```

- [ ] **C6 — Verify service RED.** Run `npx tsx --conditions=react-server --test tests/agent/authentication-service.test.ts`. Expected: missing-class failure.

- [ ] **C7 — Implement service.** Normalize email with `trim().toLowerCase()`, invalid source to `unknown-source`, consult limiter before repository, and choose the stored record only for an active user with a supported hash; otherwise verify `DUMMY_PASSWORD_RECORD`. Perform exactly one verifier call. On success create session ID/token, compute ISO expiry from injected clock, persist only token hash, clear only email bucket, and return public user/principal/raw token. `authenticate()` hashes token and converts the repository record to `kind:"user"`. `findPublicUser()` returns active user only.

- [ ] **C8 — Verify Stage C.** Run `npx tsx --conditions=react-server --test tests/agent/password-auth.test.ts tests/agent/session-auth.test.ts tests/agent/auth-repository.test.ts tests/agent/login-rate-limiter.test.ts tests/agent/authentication-service.test.ts`. Expected: PASS.

- [ ] **C9 — Commit.** `git add server/auth/login-rate-limiter.ts server/auth/authentication-service.ts tests/agent/login-rate-limiter.test.ts tests/agent/authentication-service.test.ts && git commit -m "feat(auth): add login and session service"`.

## Stage D — Auth Routes and Cookies

### Task 4: Login, Logout, and Current Session Without Business Protection Yet

**Files:** Create `server/routes/auth.ts` and `tests/agent/auth-routes.test.ts`; modify `shared/agent-contracts.ts`, `server/app.ts`, and `server/agent-service.ts`.

**Interfaces:** Produces `registerAuthRoutes(app, service, config)` and `GET /v1/auth/session`. Stage D deliberately does not add the business-route session hook.

- [ ] **D1 — Write contract/route RED tests.** Add `INVALID_CREDENTIALS` and `LOGIN_RATE_LIMITED` to `ApiErrorCodeSchema`. Add:

```ts
export const SessionResponseSchema = strictObject({
  authenticated: z.boolean(),
  user: UserSchema.nullable(),
});
```

Register `GET /v1/auth/session` in `v1Contracts` and `AgentServiceV1Path`. Tests assert login needs proxy but no prior session; raw token appears only in Set-Cookie; invalid credentials share status/body; 429 has `Retry-After`; logout absent/revoked token is idempotent and clears exact profile; current session returns authenticated user or `{authenticated:false,user:null}`; secret sentinels never enter response/log.

```ts
assert.equal(response.statusCode, 200);
assert.equal(JSON.stringify(response.json()).includes(RAW_TOKEN), false);
assert.match(String(response.headers["set-cookie"]), /__Host-agent_session=/);
assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
assert.match(String(response.headers["set-cookie"]), /Secure/);
assert.doesNotMatch(String(response.headers["set-cookie"]), /Domain=/i);
```

- [ ] **D2 — Verify RED.** Run `npx tsx --conditions=react-server --test tests/agent/auth-routes.test.ts tests/agent/contracts.test.ts`. Expected: missing routes/contracts failure.

- [ ] **D3 — Implement route adapter.** `registerAuthRoutes()` parses `LoginRequestSchema`; uses trusted source header; maps rate limit to `429 LOGIN_RATE_LIMITED` and fixed text; maps all credential failure to `401 INVALID_CREDENTIALS` and `Email or password is incorrect`; serializes success cookie and returns only `LoginResponseSchema`. Logout parses cookie, calls idempotent service logout, and clears cookie. Session route authenticates cookie and uses `findPublicUser()`.

```ts
export function registerAuthRoutes(
  app: FastifyInstance,
  service: AuthenticationService | null,
  config: AgentAuthenticationConfig,
) {
  app.post("/v1/auth/login", loginHandler(service, config));
  app.post("/v1/auth/logout", logoutHandler(service, config));
  app.get("/v1/auth/session", sessionHandler(service, config));
}
```

- [ ] **D4 — Compose dependencies.** In `createAgentService()`, load auth config, create one `BoundedLoginRateLimiter`, create one `AuthenticationService` using the opened repository and injected clock, and pass both to `buildAgentApp()`. Register auth routes after the existing proxy hook. Keep other routes unchanged in this commit.

- [ ] **D5 — Verify GREEN.** Run `npx tsx --conditions=react-server --test tests/agent/auth-routes.test.ts tests/agent/contracts.test.ts tests/agent/service-security.test.ts tests/agent/capabilities.test.ts`. Expected: PASS; capabilities still works with proxy only until Stage E.

- [ ] **D6 — Commit.** `git add shared/agent-contracts.ts server/routes/auth.ts server/app.ts server/agent-service.ts tests/agent/auth-routes.test.ts && git commit -m "feat(auth): expose session routes"`.

## Stage E — Proxy Trust, Middleware, and Authorization

### Task 5: Activate Fail-Closed Business Protection Last

**Files:** Create `server/auth/authorization.ts` and `tests/agent/auth-authorization.test.ts`; modify `server/app.ts`, `server/agent-service.ts`, `server/routes/analysis-runs.ts`, `server/routes/local-voc.ts`, `server/routes/connectors.ts`, `app/api/agent/[...path]/route.ts`, `app/lib/agent-service-client.ts`, `tests/agent/proxy.test.ts`, `service-security.test.ts`, `health.test.ts`, `capabilities.test.ts`, `connector-probe-service.test.ts`, `analysis-run-lifecycle.test.ts`, `formal-voc-submission.test.ts`, `saved-analysis-reports.test.ts`, and `local-data-bridge.test.ts`.

**Interfaces:**

```ts
export type RouteAccess =
  | Readonly<{ kind: "public" }>
  | Readonly<{ kind: "proxy-only" }>
  | Readonly<{ kind: "session"; roles: readonly ("admin" | "member")[] }>
  | Readonly<{
      kind: "session-or-anonymous-loopback";
      roles: readonly ("admin" | "member")[];
    }>;

export function classifyRoute(method: string, pathname: string): RouteAccess;
export function requireRole(
  principal: RequestPrincipal,
  allowedRoles: readonly ("admin" | "member")[],
): void;

export type AnalysisRunServiceResolver = (
  principal: RequestPrincipal,
) => AnalysisRunService | null;
```

- [ ] **E1 — Write route-policy RED tests.** In `tests/agent/auth-authorization.test.ts`, table-test every declared route class. `GET /health` is the only public route. Login, logout, and current-session are proxy-only. Capabilities and the exact fixture allowlist below permit an authenticated session or explicitly enabled anonymous loopback. Connector probe is admin-only. Every other `/v1/*` route is session `admin|member`; unknown routes are also session-protected before they reach the existing 404 handler.

```ts
const fixtureAllowlist = [
  ["POST", "/v1/local-voc"],
  ["POST", "/v1/runs/00000000-0000-4000-8000-000000000001/voc-import"],
  ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001"],
  ["GET", "/v1/runs/00000000-0000-4000-8000-000000000001/reports"],
  ["GET", "/v1/reports/00000000-0000-4000-8000-000000000001"],
  ["GET", "/v1/local-data/fixture"],
] as const;
```

`/v1/local-data/*` accepts its already-declared `GET|POST|PATCH|DELETE` methods only. The anonymous list excludes connector probe, auth routes, arbitrary future routes, and every non-local business route.

- [ ] **E2 — Verify policy RED.** Run `npx tsx --conditions=react-server --test tests/agent/auth-authorization.test.ts`. Expected: module-not-found failure.

- [ ] **E3 — Implement closed route classification.** Use anchored regular expressions for UUID route segments and exact methods. `requireRole()` rejects `kind:"anonymous-loopback"`, rejects a user whose role is absent, and never reads role/user/org from request headers or bodies. Add Fastify request augmentation:

```ts
declare module "fastify" {
  interface FastifyRequest {
    authPrincipal: RequestPrincipal | null;
  }
}
```

- [ ] **E4 — Verify policy GREEN.** Re-run E2. Expected: PASS.

- [ ] **E5 — Write proxy-boundary RED tests.** Extend `tests/agent/proxy.test.ts` and `tests/agent/service-security.test.ts` to prove browser-supplied `x-agent-proxy-token`, `x-agent-client-ip`, `x-forwarded-for`, and `forwarded` never reach Agent Service; the server inserts its configured proxy token and the single normalized source; browser Cookie still forwards; upstream Set-Cookie still returns without `Domain`; direct Agent Service calls without proxy fail before session checks.

```ts
serviceHeaders.delete("x-agent-proxy-token");
serviceHeaders.delete("x-agent-client-ip");
serviceHeaders.delete("x-forwarded-for");
serviceHeaders.delete("forwarded");
serviceHeaders.set("x-agent-client-ip", "unknown-source");
serviceHeaders.set("origin", new URL(request.url).origin);
```

In the vinext adapter, derive the client source only from the trusted deployment boundary. For this local implementation, emit `unknown-source`; do not restore a browser-supplied forwarding header. Add `x-agent-client-ip` to the explicit Agent Service client allowlist.

- [ ] **E6 — Verify proxy RED.** Run `npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/service-security.test.ts`. Expected: at least one spoofed-header assertion fails.

- [ ] **E7 — Implement proxy sanitization.** Apply the exact deletion/overwrite sequence in `app/api/agent/[...path]/route.ts`; keep the existing Cookie forwarding and Set-Cookie Domain stripping. Update `app/lib/agent-service-client.ts` to accept the trusted `x-agent-client-ip` header without accepting browser forwarding headers.

- [ ] **E8 — Write middleware/authorization RED tests.** Extend `tests/agent/health.test.ts`, `tests/agent/capabilities.test.ts`, `tests/agent/connector-probe-service.test.ts`, `tests/agent/analysis-run-lifecycle.test.ts`, `tests/agent/formal-voc-submission.test.ts`, `tests/agent/saved-analysis-reports.test.ts`, and `tests/agent/local-data-bridge.test.ts` to prove:
  - health succeeds without proxy or session and retains the existing fixed response;
  - capabilities rejects missing proxy, accepts admin/member session, accepts anonymous loopback only under its valid config matrix, and returns the same sanitized body in all accepted modes;
  - connector probe accepts admin and returns `403 FORBIDDEN` for member and anonymous loopback;
  - an authenticated member can submit/poll/read reports;
  - missing, expired, revoked, or disabled-user sessions fail `401` before domain work;
  - anonymous loopback can reach only the explicit fixture routes;
  - authenticated request actor/organization come from the principal, never configured static IDs or request input.

- [ ] **E9 — Verify middleware RED.** Run `npx tsx --conditions=react-server --test tests/agent/health.test.ts tests/agent/capabilities.test.ts tests/agent/connector-probe-service.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/formal-voc-submission.test.ts tests/agent/saved-analysis-reports.test.ts tests/agent/local-data-bridge.test.ts`. Expected: unauthenticated business requests still pass or role tests fail.

- [ ] **E10 — Install authentication before business handlers.** In `buildAgentApp()`, keep the existing proxy-token/origin hook first, register auth routes, then add a `preHandler` that:
  1. returns immediately for `public` and `proxy-only` classifications;
  2. parses the configured session cookie and calls `AuthenticationService.authenticate()`;
  3. assigns an authenticated principal and checks allowed roles when active;
  4. assigns `{kind:"anonymous-loopback"}` only for `session-or-anonymous-loopback` routes when `config.mode === "anonymous-loopback"`;
  5. otherwise returns sanitized `401 UNAUTHORIZED` or `403 FORBIDDEN`.

Do not let a missing authentication service silently enable business access. If repository/auth construction failed, login and every protected route fail closed; only `/health` remains available.

- [ ] **E11 — Resolve domain services per request.** Retain the current static execution context only for the explicit anonymous fixture path. Change route registration to accept `AnalysisRunServiceResolver`; for a user principal construct `AnalysisRunService` with:

```ts
{
  actorId: principal.userId,
  organizationId: principal.organizationId,
}
```

For `kind:"anonymous-loopback"`, use the existing configured fixture context. Never use the static context for authenticated HTTP. Apply the same principal rule to `registerLocalVocRoute()`. `registerConnectorRoutes()` requires `kind:"user"` and `role:"admin"` before invoking probe logic.

- [ ] **E12 — Update legacy fixture tests explicitly.** Tests intentionally exercising local anonymous smoke must pass this complete environment; all authorization tests instead create a real repository user/session and send the cookie.

```ts
{
  NODE_ENV: "test",
  AGENT_SERVICE_HOST: "127.0.0.1",
  AGENT_SERVICE_TRUSTED_ORIGINS: "http://127.0.0.1:31900",
  AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK: "1",
}
```

- [ ] **E13 — Verify Stage E.** Run `npx tsx --conditions=react-server --test tests/agent/proxy.test.ts tests/agent/auth-authorization.test.ts tests/agent/service-security.test.ts tests/agent/health.test.ts tests/agent/capabilities.test.ts tests/agent/connector-probe-service.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/formal-voc-submission.test.ts tests/agent/saved-analysis-reports.test.ts tests/agent/local-data-bridge.test.ts`. Expected: PASS, including formal submit/poll/report coverage under its explicit fixture mode.

- [ ] **E14 — Commit.** `git add server/auth/authorization.ts server/app.ts server/agent-service.ts server/routes/analysis-runs.ts server/routes/local-voc.ts server/routes/connectors.ts app/api/agent/'[...path]'/route.ts app/lib/agent-service-client.ts tests/agent/auth-authorization.test.ts tests/agent/proxy.test.ts tests/agent/service-security.test.ts tests/agent/health.test.ts tests/agent/capabilities.test.ts tests/agent/connector-probe-service.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/formal-voc-submission.test.ts tests/agent/saved-analysis-reports.test.ts tests/agent/local-data-bridge.test.ts && git commit -m "feat(auth): protect agent service routes"`.

## Stage F — First-Admin CLI, Local Fixture Smoke, and Gates

### Task 6: Operable Bootstrap and Final OpenSpec Verification

**Files:** Create `server/cli/hidden-password-prompt.ts`, `server/cli/init-admin.ts`, and `tests/agent/admin-init-cli.test.ts`; modify `package.json`; after every gate is green, modify only task 4.3 in `openspec/changes/build-standalone-agent-workflow/tasks.md`.

**Interfaces:**

```ts
export interface AdminInitOptions {
  readonly email: string;
  readonly displayName: string;
  readonly organizationId: string;
}

export async function promptHiddenConfirmedPassword(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): Promise<string>;

export async function runAdminInit(
  options: AdminInitOptions,
  dependencies?: Readonly<{
    promptPassword?: typeof promptHiddenConfirmedPassword;
    openRepository?: typeof openSqliteAgentRepository;
    hash?: typeof hashPassword;
  }>,
): Promise<Readonly<{ userId: string; email: string }>>;
```

- [ ] **F1 — Write CLI RED tests.** Test non-TTY rejection; hidden input and confirmation; mismatch; raw-mode restoration in success and throw paths; rejection of `--password` and unknown arguments; normalized email; password-policy failure; atomic refusal when any user exists; safe success output containing only user ID/email; sentinel password/hash absent from stdout/stderr/error.

- [ ] **F2 — Verify CLI RED.** Run `npx tsx --conditions=react-server --test tests/agent/admin-init-cli.test.ts`. Expected: module-not-found failure.

- [ ] **F3 — Implement hidden prompt.** Require an interactive TTY. Enter raw mode, consume characters without echo, support Backspace and Enter, restore the prior raw mode and listeners in `finally`, then prompt a second time and compare with `timingSafeEqual` over equal-length UTF-8 buffers. Return the first password only after confirmation; never log it.

- [ ] **F4 — Implement the one-time command.** Parse only `--email`, `--display-name`, and `--organization-id`; reject `--password` even if present. Reuse existing database configuration, call the hidden prompt, `hashPassword()`, and repository `createInitialAdmin()`, close the owned repository in `finally`, and print only `{status:"ready",userId,email}`. The repository transaction remains the authority for the zero-user precondition.

- [ ] **F5 — Add the only package change.** Add exactly:

```json
"admin:init": "tsx server/cli/init-admin.ts"
```

Do not add dependencies and do not modify `package-lock.json`.

- [ ] **F6 — Verify CLI GREEN.** Run `npx tsx --conditions=react-server --test tests/agent/admin-init-cli.test.ts tests/agent/auth-repository.test.ts tests/agent/password-auth.test.ts`. Expected: PASS.

- [ ] **F7 — Run the local fake-provider tracer bullet.** Do not require a real model key or connector key. Run:

```powershell
npx tsx --conditions=react-server --test --test-name-pattern "formal Agent Service entry starts from a queued job, publishes a report, and stops boundedly" tests/agent/voc-positioning-runtime.test.ts
```

Expected: one matching test PASS, with queued submission, Worker completion, and a persisted versioned report; no external network call.

- [ ] **F8 — Run focused authentication and HTTP gates.** Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/auth-config.test.ts tests/agent/password-auth.test.ts tests/agent/session-auth.test.ts tests/agent/auth-repository.test.ts tests/agent/login-rate-limiter.test.ts tests/agent/authentication-service.test.ts tests/agent/auth-routes.test.ts tests/agent/auth-authorization.test.ts tests/agent/proxy.test.ts tests/agent/service-security.test.ts tests/agent/health.test.ts tests/agent/capabilities.test.ts tests/agent/connector-probe-service.test.ts tests/agent/analysis-run-lifecycle.test.ts tests/agent/formal-voc-submission.test.ts tests/agent/saved-analysis-reports.test.ts tests/agent/local-data-bridge.test.ts tests/agent/admin-init-cli.test.ts
```

Expected: all selected files PASS; no skipped authentication assertion.

- [ ] **F9 — Run repository-wide gates once.** Run each command once, in order:

```powershell
npm run test:agent
npm test
npm run lint
npm run skills:validate
npx openspec validate build-standalone-agent-workflow --strict
git diff --check
git diff --name-only -- package-lock.json server/db/migrations
```

Expected: every command exits 0; the final command prints nothing.

- [ ] **F10 — Check only OpenSpec 4.3.** After F6–F9 are green, change only `- [ ] 4.3` to `- [x] 4.3` in `openspec/changes/build-standalone-agent-workflow/tasks.md`. Do not change 4.4, 12.2, or any other checkbox.

- [ ] **F11 — Commit.** `git add server/cli/hidden-password-prompt.ts server/cli/init-admin.ts tests/agent/admin-init-cli.test.ts package.json openspec/changes/build-standalone-agent-workflow/tasks.md && git commit -m "feat(auth): initialize first administrator"`. Expected: no `package-lock.json` or migration in the commit.

## Operator Configuration Matrix

| Environment | Required authentication settings | Cookie profile | Business access |
|---|---|---|---|
| Production or non-loopback | No compatibility flags | Secure `__Host-agent_session` | Login session required |
| Local authenticated HTTP | `AGENT_AUTH_ALLOW_INSECURE_LOOPBACK_COOKIE=1`; all bind/origins loopback; non-production | Insecure `agent_session` | Login session required |
| Local fixture smoke | `AGENT_AUTH_ALLOW_ANONYMOUS_LOOPBACK=1`; all bind/origins loopback; non-production | Secure unless the independent insecure-cookie flag is also set | Explicit fixture allowlist only |

No model, connector, PostgreSQL, Cloudflare, email, or other third-party key is required to implement or verify 4.3. The existing `AGENT_SERVICE_PROXY_TOKEN` remains required for vinext-to-Agent-Service trust and is independent from browser sessions.

## Plan Self-Review Gate

- [ ] **Spec coverage:** Confirm the plan covers one-time admin creation, Node scrypt, dummy verification, random opaque sessions, hash-only persistence, revocation, secure/insecure cookie split, email/source limiting, admin/member authorization, `/health`, capabilities, probe, proxy coexistence, anonymous-loopback restrictions, and fake-provider smoke.
- [ ] **File boundary:** Confirm the implementation changes only the exact map above, does not add a migration/dependency, and leaves 4.4/12.2 untouched.
- [ ] **Type consistency:** Confirm `AgentAuthenticationConfig`, `RequestPrincipal`, `AuthenticationService`, `RouteAccess`, and `AnalysisRunServiceResolver` retain the exact names and field shapes shown here across all stages.
- [ ] **Command consistency:** Confirm every named test file exists before the command that expects it to pass, and every RED command fails for the stated missing behavior rather than syntax/configuration.
- [ ] **Placeholder scan:** Run `rg -n 'TO[D]O|TB[D]|simila[r]|implement late[r]|appropriate error handlin[g]|write tests for the abov[e]' docs/superpowers/plans/2026-08-18-agent-authentication.md`. Expected: no output.
- [ ] **Diff safety:** Run `git diff --check` and `git diff --name-only -- package-lock.json server/db/migrations`. Expected: both clean/no output before each implementation commit.

## Execution Handoff

Implement sequentially A through F. Stop after each stage's GREEN command and commit for independent review. Stage E is the first point existing business routes become session-protected; do not begin it until A–D are green. Do not check OpenSpec 4.3 until every Stage F gate succeeds.
