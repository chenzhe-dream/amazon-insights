# Server Connector Secrets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the SIF, Sorftime, and SellerSprite Node clients use only server environment secrets, with no Cursor configuration fallback or browser-facing secret setup prompt.

**Architecture:** Add one pure ESM loader under `server/config` that normalizes the three declared server secret variables and derives boolean-only capability state. Existing Node MCP clients import that loader; Agent Service capability reporting consumes the same state; page copy only directs users to an administrator-managed connector without naming or returning secrets.

**Tech Stack:** Node.js ESM, TypeScript/tsx tests, Node test runner, React source, ESLint, OpenSpec.

## Global Constraints

- Do not implement the 11.2 connector contract or 11.3 DataSnapshot migration.
- Do not call real SIF, Sorftime, SellerSprite, or model APIs; use injected fake environment and transport.
- Do not expose secret values, tokens, or private connector URLs to browser code or capability responses.
- Do not add dependencies or modify `package-lock.json`, migrations `0001`–`0008`, generated VOC, existing runtime data WIP, or stash.
- Do not reset, checkout, rebase, amend, stash, clean, push, or start Web/Agent services.

---

### Task 1: Server-only connector secret loading and Cursor removal

**Files:**
- Create: `server/config/connector-secrets.mjs`
- Create: `tests/agent/connector-secret-config.test.ts`
- Modify: `server/routes/capabilities.ts`
- Modify: `scripts/lib/sif-mcp-client.mjs`
- Modify: `scripts/lib/sorftime-mcp-client.mjs`
- Modify: `scripts/lib/sellersprite-mcp-client.mjs`
- Modify: `scripts/fetch-sellersprite-review-analysis.mjs`
- Modify: `app/keyword-demand-section.tsx`
- Modify: `app/page.tsx`
- Modify: `app/seller-sprite-review-analysis.ts`
- Modify: `openspec/changes/build-standalone-agent-workflow/tasks.md`

**Interfaces:**
- Produces: `readServerConnectorSecret(connector, env = process.env): string | null`.
- Produces: `getServerConnectorSecretState(env = process.env): Readonly<{sif: boolean; sorftime: boolean; sellerSprite: boolean}>`.
- Preserves: `readSifHeaders`, `readSorftimeKey`, and `readSellerSpriteSecretKey`, adding optional environment injection without changing existing callers.
- Preserves: MCP call signatures, adding only optional injected `fetchImpl` where needed for network-free tests.

- [x] **Step 1: Write the failing contract test**

```ts
test("server connector secrets ignore Cursor state and remain out of public surfaces", async () => {
  assert.equal(readServerConnectorSecret("sif", { SIF_MCP_SECRET: " server-value " }), "server-value");
  assert.equal(readServerConnectorSecret("sif", { USERPROFILE: fakeCursorHome }), null);
  assert.deepEqual(getServerConnectorSecretState({ SORFTIME_MCP_KEY: "configured" }), {
    sif: false,
    sorftime: true,
    sellerSprite: false,
  });
  assert.doesNotMatch(JSON.stringify(getAgentCapabilities(secretEnv)), /secret-sentinel/);
  assertNoCursorReferencesInConnectorAndPageSources();
});
```

- [x] **Step 2: Run RED**

Run: `npx tsx --conditions=react-server --test tests/agent/connector-secret-config.test.ts tests/agent/capabilities.test.ts`

Expected: FAIL because `server/config/connector-secrets.mjs` does not exist and the existing clients/pages still contain `.cursor/mcp.json` and Cursor setup text.

- [x] **Step 3: Implement the minimal loader and wiring**

```js
const connectorEnvironmentNames = Object.freeze({
  sif: "SIF_MCP_SECRET",
  sorftime: "SORFTIME_MCP_KEY",
  sellerSprite: "SELLERSPRITE_SECRET_KEY",
});

export function readServerConnectorSecret(connector, env = process.env) {
  const environmentName = connectorEnvironmentNames[connector];
  if (!environmentName) throw new TypeError("Unknown connector secret");
  const value = env[environmentName];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function getServerConnectorSecretState(env = process.env) {
  return Object.freeze({
    sif: readServerConnectorSecret("sif", env) !== null,
    sorftime: readServerConnectorSecret("sorftime", env) !== null,
    sellerSprite: readServerConnectorSecret("sellerSprite", env) !== null,
  });
}
```

Remove all filesystem/Cursor fallbacks, reject missing secrets before fake transport is invoked, use the boolean state in `getAgentCapabilities`, replace page copy with administrator-managed connector guidance, and delete unused `mcpSetup` metadata.

- [x] **Step 4: Run GREEN and focused regression**

Run: `npx tsx --conditions=react-server --test tests/agent/connector-secret-config.test.ts tests/agent/capabilities.test.ts`

Expected: all tests pass; fake transports observe server-injected credentials while missing/blank credentials fail before transport invocation.

Run: `npx eslint server/config/connector-secrets.mjs server/routes/capabilities.ts scripts/lib/sif-mcp-client.mjs scripts/lib/sorftime-mcp-client.mjs scripts/lib/sellersprite-mcp-client.mjs scripts/fetch-sellersprite-review-analysis.mjs app/keyword-demand-section.tsx app/page.tsx app/seller-sprite-review-analysis.ts tests/agent/connector-secret-config.test.ts`

Expected: zero errors.

Run: `npx openspec validate build-standalone-agent-workflow --strict`

Expected: change is valid.

- [x] **Step 5: Verify boundary and create the checkpoint**

Run: `rg -n -i "cursor|~/.cursor|\\.cursor/mcp\\.json" server scripts app --glob '!**/*.css' --glob '!app/*-data.ts' --glob '!app/competitor-data.ts' --glob '!app/variant-data.ts'`

Expected: no connector configuration or page prompt matches.

Run: `git diff --check` and verify protected paths have no task-created diff.

Then check only OpenSpec 11.1, stage only the files listed above, and commit with `git commit -m "feat(connectors): load credentials from server secrets"`.

## Self-Review

- Spec coverage: server-only secrets, no Cursor fallback, boolean-only public capability state, fail-closed clients, page prompt removal, and 11.1-only scope are covered.
- Placeholder scan: no TBD/TODO or deferred implementation language.
- Type consistency: connector identifiers are exactly `sif`, `sorftime`, and `sellerSprite` across loader, clients, capability state, and tests.
