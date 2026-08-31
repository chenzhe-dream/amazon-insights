# Project Registration Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make new-ASIN project registration satisfy the existing mandatory idempotency contract.

**Architecture:** The browser derives one deterministic registration key from the local project UUID and forwards it through the existing same-origin Agent proxy. The server contract and lifecycle remain unchanged.

**Tech Stack:** Next.js, TypeScript, Playwright, Node test runner, Zod.

## Global Constraints

- Preserve the mandatory `ProjectCreationIdempotencyKeySchema` contract.
- Do not create a sync job before formal project registration succeeds.
- Do not modify Provider, PostgreSQL schema, retry, or sync lifecycle behavior.
- Preserve `data/projects/*.json` runtime data outside commits.

---

### Task 1: Registration Idempotency Header

**Files:**
- Modify: `app/page.tsx:2546`
- Test: `tests/agent/asin-sync-session.test.ts:674-730`

**Interfaces:**
- Consumes: `project.id: string`, `localAgentFetch(path: string, init?: RequestInit): Promise<Response>`
- Produces: `POST /v1/projects` with `Idempotency-Key: project-register:<project.id>`

- [ ] **Step 1: Write the failing test**

Capture the intercepted registration request header and assert:

```ts
let registrationIdempotencyKey: string | null = null;
if (path.endsWith("/v1/projects") && method === "POST") {
  registrationIdempotencyKey = request.headerValue("idempotency-key");
}
assert.equal(registrationIdempotencyKey, `project-register:${newProject.id}`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test --import tsx tests/agent/asin-sync-session.test.ts`

Expected: FAIL because the observed header is `null`.

- [ ] **Step 3: Write minimal implementation**

```ts
registrationResponse = await localAgentFetch("/v1/projects", {
  method: "POST",
  headers: {
    "Idempotency-Key": `project-register:${project.id}`,
  },
  body: JSON.stringify({
    id: project.id,
    name: project.name,
    marketplace: market,
    asins: values,
  }),
});
```

- [ ] **Step 4: Run focused verification**

Run: `node --test --import tsx tests/agent/asin-sync-session.test.ts`

Expected: all tests pass, including double-click and fail-closed scenarios.

Run: `npm run build`

Expected: production build exits 0.

- [ ] **Step 5: Commit**

```bash
git add app/page.tsx tests/agent/asin-sync-session.test.ts docs/superpowers/specs/2026-08-31-project-registration-idempotency-design.md docs/superpowers/plans/2026-08-31-project-registration-idempotency.md
git commit -m "fix: send project registration idempotency key"
```
