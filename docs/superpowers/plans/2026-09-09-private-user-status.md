# Private User Status Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Only the designated active primary email administrator and the explicitly bound active personal DingTalk account can view organization user status.

**Architecture:** One server-owned narrow permission evaluates current user and identity binding from trusted session IDs, projects a boolean through session responses, and rechecks on the list GET before accessing presence data. Other administrators and anonymous callers remain denied. Neither account merging nor global role escalation is needed.

**Tech Stack:** Existing TypeScript/Zod/Fastify/React, SQLite and PostgreSQL repository implementations, node:test; no schema migration or new dependency.

## Global Constraints

- Scope version CACHE-PRESENCE-20260909-B: designated primary email admin plus own verified DingTalk identity, NOT all administrators.
- Work only in C:/Users/EDY/Amazon-Product-Opportunity-Insights/.worktrees/fix-voc-import-status-20260907. Preserve existing dirty docs/test-results and Task A files. Root owns configuration of real identities, plans/ledger and publication; no secrets or real identity IDs in code/tests/Git.
- Missing/invalid identity configuration fails closed per branch. Do not infer owner from uniqueness, display name, matching email, browser environment or role alone; do not provision or promote any user.
- GET /v1/admin/users must independently revalidate current organization/status and exact permitted identity before listing; no client-supplied permission or identity is trusted.
- POST /v1/auth/activity and all other admin/analysis/login permissions stay unchanged. Do not broaden generic ADMIN_ROLES or local-agent proxy policy.
- No real Provider, production DB writes, formal configuration writes, restart, build, deployment, main or GitHub operations by implementer.

### Task 1: Verified two-account permission through backend and UI

**Files:**
- Create `server/auth/user-presence-access.ts`: strict scoped configuration and permission service only.
- Modify `server/db/repository.ts`, `server/db/sqlite-repository.ts`, `server/db/postgres/core-store.ts`, `server/db/postgres-repository.ts`: one optional read-only binding lookup and facade forwarding, no migration.
- Modify `server/app.ts`, `server/routes/auth.ts`, `server/routes/admin-user-presence.ts`, `server/auth/authorization.ts`: construct/inject the same permission evaluator; only users GET moves from generic admin check to valid-session plus dedicated permission.
- Modify `shared/agent-contracts.ts`: session-only canViewUserPresence boolean, absent defaults false; never expose configured IDs, subjects or emails beyond pre-existing own-user payload.
- Modify `app/lib/web-auth-session.ts`, `app/lib/auth-session-controller.ts`, `app/auth-session-gate.tsx`, `app/admin/users/admin-user-presence.tsx`, `app/lib/admin-user-presence-browser.ts`: permission propagation, navigation/page gate and safe revocation. Existing page's AuthSessionGate boundary stays intact.
- Modify `.env.example` with empty placeholders/comments for only the new server settings (not real values).
- Create `tests/agent/user-presence-access.test.ts`; modify corresponding presence route/page/browser, auth authorization, web session tests and PG/SQLite DingTalk repository tests. Other narrow affected session-contract fixture tests may be corrected with exact false-default semantics; do not disable assertions.
- Full task report `.superpowers/sdd/private-user-status-task-1-report.md`; root-owned docs remain untouched.

**Interfaces and decisions:**

```ts
export type DingTalkIdentityBinding = Readonly<{
  userId: string; organizationId: string; corpId: string; subjectId: string;
}>;
// Optional on AuthenticationRepository: older/fake repositories fail closed.
findDingTalkIdentityByUserId?(userId: string): Promise<DingTalkIdentityBinding | null>;

export type UserPresenceAccess = Readonly<{
  canView(principal: AuthenticatedPrincipal): Promise<boolean>;
}>;
// buildAgentApp creates production evaluator from its env/authService/repository;
// BuildAgentAppOptions may accept userPresenceAccess for focused dependency tests.
```

Server settings are `AGENT_USER_PRESENCE_ORGANIZATION_ID`, `AGENT_USER_PRESENCE_PRIMARY_USER_ID`, `AGENT_USER_PRESENCE_PRIMARY_EMAIL`, `AGENT_USER_PRESENCE_DINGTALK_USER_ID`, `AGENT_USER_PRESENCE_DINGTALK_CORP_ID`, `AGENT_USER_PRESENCE_DINGTALK_SUBJECT_ID`. Each branch requires its full configuration; no primary-email default which could authorize unintended organizations. IDs are opaque bounded nonempty strings; validate email with existing Zod email rules. Snapshot configuration is process-local; deployment changes apply on controlled restart. User disable/demotion/binding removal is checked fresh each API request.

The two grants are independent: demotion revokes the primary-email grant; removal of the exact DingTalk binding revokes the personal-DingTalk grant. If deployment intentionally assigns both grants to one internal account, the other still-valid grant may allow access. Disable, session invalidation and organization mismatch always deny both. Do not require an administrator role for the verified personal DingTalk branch or infer the login provider from the account email.

- [ ] **Step 1: Write red permission and binding tests.** Use artificial distinct IDs and fake in-memory read facts for pure access tests; use real temporary SQLite/isolated PG repositories for binding lookup tests. Name each behavior:

```ts
assert.equal(await access.canView(primaryPrincipal), true);
assert.equal(await access.canView(otherEmailAdmin), false);
assert.equal(await access.canView(personalDingTalkMember), true);
assert.equal(await access.canView(otherDingTalkAdmin), false);
assert.equal(await access.canView(crossOrganizationPrincipal), false);
// Change underlying current facts between requests, not the principal fixture:
currentPrimary.role = 'member';
assert.equal(await access.canView(primaryPrincipal), false);
binding = null;
assert.equal(await access.canView(personalDingTalkMember), false);
```

Test missing/partial config, current-user mismatch, disabled account, same nickname/email but different ID, wrong corp/subject, repository exception and non-user session as denied. Test that list repository is never invoked when denied. Observe current ADMIN_ROLES wrongly admitting other admins/rejecting permitted DingTalk member through real buildAgentApp routes before implementing the new policy.

- [ ] **Step 2: Implement read-only repository binding seam and evaluator.** PG/SQLite query only the designated internal user ID; join current users to identity and require provider='dingtalk'. Return exact columns, never credential fields; do not create or link identities. Adapt placeholder syntax per database:

```sql
SELECT identity.user_id, users.organization_id, identity.corp_id, identity.subject_id
FROM auth_identities identity JOIN users ON users.id = identity.user_id
WHERE identity.provider = 'dingtalk' AND identity.user_id = $1
```

Use current authenticated user lookup and principal organization as independent checks. Implement fail-closed logic:

```ts
if (!organizationId || principal.organizationId !== organizationId) return false;
const user = await authService.findPublicUser(principal.userId);
if (!user || user.id !== principal.userId || user.organizationId !== organizationId || user.status !== 'active') return false;
if (primaryConfigured && user.id === primaryUserId && user.role === 'admin'
    && user.email.trim().toLowerCase() === primaryEmail) return true;
if (!dingTalkConfigured || user.id !== dingTalkUserId || !repository.findDingTalkIdentityByUserId) return false;
const bound = await repository.findDingTalkIdentityByUserId(user.id);
return Boolean(bound && bound.userId === user.id && bound.organizationId === organizationId
  && bound.corpId === dingTalkCorpId && bound.subjectId === dingTalkSubjectId);
```

Configuration/data errors return false without logging secrets or allowing login to fail just because this optional permission is unavailable. Keep service small and reusable by both session projection and GET.

- [ ] **Step 3: Wire backend and strict session shape.** Add authenticated-session `canViewUserPresence: z.boolean().default(false)`; anonymous responses remain false or omit per strict schema branch, never true. Extend registerAuthRoutes/registerAdminUserPresenceRoutes with the same evaluator from buildAgentApp; no evaluator means denied. Reclassify ONLY GET /v1/admin/users to MEMBER_ROLES (valid authenticated sessions), then enforce evaluator before `listOrganizationUsers`:

```ts
const principal = userPrincipal(request);
if (!access || !await access.canView(principal)) {
  throw new ContractRouteError(403, 'FORBIDDEN', 'Request is not authorized');
}
```

Keep 401/403 generic; no partial list or identity configuration leaks. For session responses compute capability after current authenticated-user lookup and return false for inactive/missing users. Existing authService authenticates before permission; test real app hook order. Do not grant special access based on test caller headers or anonymous loopback.

- [ ] **Step 4: Propagate and invalidate front-end capability.** Carry `canViewUserPresence` through readWebSession, AuthenticatedWebIdentity, authenticated AuthSessionState, AuthSessionController and AuthenticatedWebSession. Explicit false default preserves old session fixture compatibility but does not imply admin=true. Update exact confirmed identity tests and actual callers, not broad type casts.

```tsx
{session.canViewUserPresence === true ? <Link className="ghost-btn" href="/admin/users">用户状态</Link> : null}
// AdminUsersAuthenticatedPage mounts data loader only with the same predicate.
```

Retain normal password/logout/heartbeat controls for everyone. Denied page copy becomes `此页面仅供已授权账号查看。` Backend permission revocation must clear displayed list and capability when a current user-list request returns 403, without logging out the whole application. Use a typed forbidden error/result and an explicit callback owned by the current session; compare captured sessionIdentity plus active request generation so old-session responses cannot revoke a new account's permission. Do not globally reinterpret all 403 responses as logout/permission revocation. On entering/reloading user-status page, the session gate obtains fresh capabilities; recheck on focus if needed without adding a periodic timer or duplicate bootstrap race.

- [ ] **Step 5: Complete test matrix, self-review and commit.**

Run focused tests during iteration, then once:
`node --conditions=react-server --import tsx --test tests/agent/user-presence-access.test.ts tests/agent/admin-user-presence-routes.test.ts tests/agent/admin-user-presence-browser.test.ts tests/agent/admin-user-presence-contracts.test.ts tests/agent/auth-authorization.test.ts tests/agent/authentication-service.test.ts tests/agent/web-auth-session.test.ts tests/agent/dingtalk-auth-repository.test.ts`

Run UI without react-server:
`node --import tsx --test tests/agent/admin-user-presence-page.test.tsx`

Run new real SQLite+PostgreSQL binding tests using existing isolated test helpers; inspect helper before running so no formal/shared database is used. Cover subsequent binding removal, wrong provider and organization, and no identity mutation. Focus PG tests with `--test-name-pattern` when appropriate; a passing fake-query test is not a substitute for actual supported DB binding lookup.

Add frontend tests that only the two permitted identities get link/content; unchanged administrator role without capability is denied; missing bool fails closed; permission loss clears data; stale old-session denial cannot affect new session; unauthorized page never mounts loader. Add backend tests proving role promotion never occurs and unrelated admin routes still reject a permitted DingTalk member. Include normal heartbeats and own-session information regression.

Run changed-file ESLint, `git diff --check`; report all warnings. No production env reads/writes. Commit only owned implementation/tests with `feat: restrict user status to designated identities`; append RED/GREEN commands, results, exact files and concerns to report. Root performs final full-TypeScript comparison, whole-change review, verified production identity selection and publication decisions.
