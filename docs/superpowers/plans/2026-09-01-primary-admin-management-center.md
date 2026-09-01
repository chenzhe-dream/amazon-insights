# Primary Admin Management Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the account-presence dashboard to the validated `admin@example.com` primary administrator and present it as a management center using the main application's visual language.

**Architecture:** Reuse the repository-loaded primary-administrator check already used by concurrency administration. Keep the existing presence repository and strict response contract, but add server-side primary-admin authorization and a primary-admin-only management navigation shell.

**Tech Stack:** TypeScript, React, Fastify, Zod, Node test runner, CSS Modules.

## Global Constraints

- The integration base is exact commit `f3a40342a03f4f08d4eaef21842dff39d53458a0`.
- Primary administrator requires an active repository user with `role === "admin"` and normalized email exactly `admin@example.com`.
- Ordinary admin, member, disabled user, stale session, and unauthenticated requests fail closed.
- Never expose token, Cookie, password, session id, IP, credential, or database internals.
- Do not modify VOC, keyword, sync, Provider, project, run, stage, snapshot, or report behavior.
- Do not push, deploy, invoke Provider, or write live business data.

---

### Task 1: Enforce Primary-Administrator Authorization

**Files:**
- Modify: `server/routes/admin-user-presence.ts`
- Modify: `server/app.ts`
- Modify: `tests/agent/admin-user-presence-routes.test.ts`
- Modify: `tests/agent/admin-user-presence-page.test.tsx`

**Interfaces:**
- Consumes: `AuthenticationService.findPublicUser(userId): Promise<User | null>` and `request.authPrincipal`.
- Produces: `registerAdminUserPresenceRoutes(app, repository, authService, clock?)` where `GET /v1/admin/users` permits only a repository-validated primary administrator.

- [ ] **Step 1: Write the failing authorization tests.** Add cases equivalent to:

```ts
test("ordinary admin cannot read primary administrator user presence", async () => {
  const response = await requestUsers({ principal: ordinaryAdmin, repositoryUser: ordinaryAdminUser });
  assert.equal(response.statusCode, 403);
});

test("active repository-loaded primary administrator can read user presence", async () => {
  const response = await requestUsers({ principal: primaryPrincipal, repositoryUser: primaryUser });
  assert.equal(response.statusCode, 200);
});
```

- [ ] **Step 2: Verify RED.** Run `node --import tsx --test tests/agent/admin-user-presence-routes.test.ts tests/agent/admin-user-presence-page.test.tsx`. Expected: ordinary admin currently receives 200 or still renders the management data.
- [ ] **Step 3: Implement the minimum server check.** Load the actor through `AuthenticationService`, require active/admin/normalized `admin@example.com`, require matching organization, then list presence records. Return the existing safe 403 contract for every rejected authenticated actor.
- [ ] **Step 4: Verify GREEN.** Re-run the command from Step 2. Expected: all tests pass.
- [ ] **Step 5: Commit.** `git add server/routes/admin-user-presence.ts server/app.ts tests/agent/admin-user-presence-routes.test.ts tests/agent/admin-user-presence-page.test.tsx && git commit -m "fix(auth): restrict user presence to primary admin"`

### Task 2: Integrate the Management Center UI

**Files:**
- Modify: `app/auth-session-gate.tsx`
- Modify: `app/admin/users/admin-user-presence.tsx`
- Modify: `app/admin/users/admin-users-page.tsx`
- Modify: `app/admin/users/admin-users.module.css`
- Modify: `tests/agent/admin-user-presence-page.test.tsx`
- Modify: `tests/agent/admin-user-presence-style.test.ts`

**Interfaces:**
- Consumes: `isPrimaryAdministrator(user): boolean`, `AdminUserPresenceLoader`, and `AuthIdentityControl`.
- Produces: a primary-admin-only `管理中心` link and a main-app-style management shell with `账号管理` and `/analyses` navigation.

- [ ] **Step 1: Write failing UI tests.** Require primary admin to see `管理中心`, `账号管理`, and `分析历史`; require ordinary admin/member to see neither management link nor data loader; require the table viewport to stay responsive.

```tsx
assert.match(renderIdentity(primaryAdmin), /管理中心/);
assert.doesNotMatch(renderIdentity(ordinaryAdmin), /管理中心/);
assert.match(renderAdminPage(primarySession), /账号管理/);
assert.match(renderAdminPage(primarySession), /分析历史/);
```

- [ ] **Step 2: Verify RED.** Run `node --import tsx --test tests/agent/admin-user-presence-page.test.tsx tests/agent/admin-user-presence-style.test.ts`. Expected: current `role === "admin"` gate and old standalone layout fail the new assertions.
- [ ] **Step 3: Implement the minimum UI.** Replace the generic admin link/gate with `isPrimaryAdministrator`. Keep `/admin/users`, apply the main application's blue/white card styling, add management navigation, preserve loading/empty/error states and every existing safe field.
- [ ] **Step 4: Verify GREEN and affected checks.** Run the Step 2 command, then `npx eslint app/auth-session-gate.tsx app/admin/users server/routes/admin-user-presence.ts server/app.ts` and `npm run build`.
- [ ] **Step 5: Commit.** `git add app/auth-session-gate.tsx app/admin/users tests/agent/admin-user-presence-page.test.tsx tests/agent/admin-user-presence-style.test.ts && git commit -m "feat(admin): integrate primary management center"`
