# Provider Probe Acceptance Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore all three real provider probes and make every probe action visibly report progress, outcome, safe reason, and checked time before the one approved three-ASIN acceptance run.

**Architecture:** Keep the existing authenticated probe route, credential resolver, readiness gate, concurrency governor, and provider endpoints unchanged. Repair only the management-panel presentation in code; repair the live network path operationally by extending the deployed process `NO_PROXY` value with the three fixed provider hosts while preserving every existing entry. Then use the existing controlled stack launcher and the existing single-run acceptance rules.

**Tech Stack:** React/TypeScript, Node test runner with `tsx`, Vinext build, PostgreSQL connector status, Windows controlled stack supervisor.

## Global Constraints

- Do not expose credentials, proxy values, database URLs, request headers, provider bodies, or complete provider URLs.
- Do not push, reset, clean, stash, rebase, or amend.
- Preserve the 13 modified generated application data files and two untracked project JSON files; never stage them.
- Do not change concurrency limits, readiness admission semantics, provider endpoints, automatic retry behavior, or task identity.
- Do not create a sync job until SellerSprite, SIF, and Sorftime each have a fresh successful explicit probe.
- The controlled deployment must keep PostgreSQL on 58258, use only Web 31900 and Agent 31901, and keep port 3000 absent.

---

### Task 1: Explicit probe result presentation

**Files:**
- Modify: `tests/agent/concurrency-admin-page.test.tsx`
- Modify: `tests/agent/concurrency-admin-browser.test.ts`
- Modify: `app/concurrency-admin-panel.tsx`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`

**Interfaces:**
- Consumes: `probeConnector(connectorId): Promise<ConnectorHealth>` and `ConcurrencyAdminResponse.connectors[connectorId]`.
- Produces: per-card button text `测试中…`, outcome text containing `连接正常` or `连接失败`, a safe reason/cause, and `checkedAt` rendered as a localized time; synchronous double clicks still produce one POST.

- [ ] **Step 1: Write failing component and browser assertions**

Add assertions that an unavailable HTTP-200 probe is not reported as generic success, that its card shows a visible failed outcome and checked time, that an available probe shows a visible successful outcome and checked time, and that the button reads `测试中…` while disabled. Retain the existing exact-one-POST double-click assertion.

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-page.test.tsx tests/agent/concurrency-admin-browser.test.ts
```

Expected: failures show the current generic `已更新` behavior and missing per-card probe time/outcome.

- [ ] **Step 3: Implement minimal presentation state**

In `runCredentialAction`, preserve the returned `ConnectorHealth` for probe operations and set a connector-specific safe message based on `available`. Render the current connector health reason and `checkedAt` beside that connector. For the active connector only, replace the button label with `测试中…`; do not change route, schema, credentials, retries, or readiness logic.

- [ ] **Step 4: Run focused GREEN verification**

Run the same command. Expected: all focused tests pass with zero skips.

- [ ] **Step 5: Commit only planned files**

Stage the three code/test paths and the OpenSpec task record explicitly, confirm the 15 runtime WIP paths are unstaged, run staged diff check, and commit with message `fix: show provider probe outcomes`.

### Task 2: Controlled build and limited independent review

**Files:**
- Read: Task 1 commit diff
- Update ignored evidence report only if the existing workflow already uses one

**Interfaces:**
- Consumes: Task 1 commit.
- Produces: one build artifact approved for deployment; Critical 0 and direct blocker 0 for the Task 1 diff.

- [ ] **Step 1: Run one fresh build**

```powershell
npm run build
```

Expected: exit 0; only existing informational advisories are acceptable.

- [ ] **Step 2: Perform one limited independent review**

Review only the approved probe-display requirement, Task 1 diff, secret redaction, exact-one-POST behavior, and the 15-WIP boundary. Defer unrelated Minor findings.

### Task 3: Preserve existing proxy configuration and bypass only provider hosts

**Files:**
- Modify operationally: protected deployed environment file already used by the formal launcher

**Interfaces:**
- Consumes: the existing `NO_PROXY` value without printing it.
- Produces: the same value plus `mcp.sellersprite.com`, `mcp.sif.com`, and `mcp.sorftime.com`, de-duplicated; all proxy credentials and all other environment values remain unchanged.

- [ ] **Step 1: Preflight**

Confirm Web/Agent health 200, PostgreSQL listening, port 3000 absent, and active jobs/modules both zero. Stop if any condition fails.

- [ ] **Step 2: Apply the minimal protected configuration merge**

Use the patch mechanism without echoing the old or new complete line. Preserve every existing `NO_PROXY` entry and append only the three fixed provider hostnames. Do not alter `HTTP_PROXY`, `HTTPS_PROXY`, credentials, endpoint variables, or concurrency settings.

- [ ] **Step 3: Controlled restart**

Restart only through the approved formal stack launcher. Keep PostgreSQL running, create no second Web stack, and verify 31900/31901 are healthy with port 3000 absent.

### Task 4: Single real acceptance sequence

**Files:**
- Runtime evidence only; do not stage generated business data.

**Interfaces:**
- Consumes: fresh successful probes for SellerSprite, SIF, and Sorftime.
- Produces: one job for three ASINs never previously present in repository or PostgreSQL task history, with refresh GET-only, one Worker per scope, traffic-before-image, truthful per-ASIN statuses, and zero active work at completion.

- [ ] **Step 1: Probe each connector exactly once**

Use the authenticated highest-admin panel. A failed probe stops the sequence; do not repeat it in this acceptance attempt.

- [ ] **Step 2: Verify readiness without creating a job**

Confirm all three connector rows are configured, available, freshly checked, and not paused; confirm active jobs/modules remain zero.

- [ ] **Step 3: Submit one three-ASIN job**

Use three ASINs absent from both source data and PostgreSQL job history. Submit once and record the jobId. Do not create a replacement run if it fails.

- [ ] **Step 4: Verify business tracers**

Confirm refresh keeps the same jobId and adds no POST, the same scope reuses one Worker, traffic becomes available before image completion, every ASIN/module has a truthful terminal status, PostgreSQL traffic becomes visible without a build, and the controlled build/reload uses 31900 without port 3000.

- [ ] **Step 5: Close acceptance**

After terminal state, verify 31900/31901/58258 health and active jobs/modules zero. Mark OpenSpec 5.4, 5.5, and 6.8 complete only if every required tracer passed.

