# Managed Provider Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SellerSprite, SIF, and Sorftime safely configurable and testable from the concurrency panel, block invalid real sync starts, repair unverified legacy statuses offline, and ensure explicit resume actually invokes the required provider work.

**Architecture:** Reuse the existing encrypted organization credential repository, connector probe service, audit trail, and Fastify contracts. Add a server-authoritative readiness gate before job admission, a primary-admin-only legacy repair service backed by an atomic PostgreSQL compare-and-apply operation, and a narrow panel UI that never receives a secret. Explicit resume selection uses persisted per-ASIN job status as its authority instead of build-time placeholder files.

**Tech Stack:** TypeScript, React/Vinext, Fastify, PostgreSQL, Zod, Node test runner, `tsx`, existing connector/cipher/repository abstractions

## Global Constraints

- Work only in `C:\Users\EDY\Amazon-Product-Opportunity-Insights\.worktrees\stabilize-resumable-sync-pipeline` and use absolute paths for edits.
- Do not deploy, push, reset, clean, stash, rebase, amend, or touch live 31900/31901/58258/3000 processes.
- Do not call a real provider. Tests use fake connectors, test PostgreSQL, temporary directories, and random loopback ports only.
- Never print or persist plaintext credentials, provider request headers, full provider bodies, environment values, or database URLs.
- Preserve the 15 real-run WIP entries: 13 modified generated files under `app/` and 2 untracked project JSON files under `data/projects/`; never stage them.
- Managed active credentials take precedence over environment credentials. Environment credentials are read-only fallback and can only be reported as configured.
- Credential mutation, revocation, probing, and legacy repair are limited to the active primary administrator loaded from the authentication repository; never trust a role or email supplied by the client.
- Saving a credential, probing a connector, or repairing a legacy job must never start or resume a sync job.
- Implement each task test-first. Run the Slice 6 targeted verification once at the end and run exactly one fresh `npm run build` for this Slice.
- The final independent review is limited to Slice 6 requirements, Slice 6 diff, secret non-disclosure, zero-job readiness rejection, zero-provider repair, and actual fake-provider resume execution. Minor findings are deferred.

## File Responsibility Map

- `shared/agent-contracts.ts`: safe connector state, readiness failure, and legacy preview/apply wire schemas and registered routes.
- `server/services/connector-credential-service.ts`: managed/environment/none resolution and secret-free state projection.
- `server/routes/connectors.ts`: authenticated connector list plus primary-admin-only credential mutation/revocation/probe handlers.
- `server/services/sync-provider-readiness-service.ts`: required-connector calculation and server-authoritative readiness decision.
- `server/services/sync-legacy-status-repair-service.ts`: same-organization, terminal-job, diagnostics-version, and evidence rules for preview/apply.
- `server/db/postgres/sync-job-store.ts`: atomic version-checked legacy status compare-and-apply and existing resume semantics.
- `server/routes/local-data.ts`, `server/agent-service.ts`, `server/app.ts`: dependency wiring and route-level error mapping only.
- `app/lib/concurrency-admin-browser.ts`: secret-safe connector list/save/revoke/probe and legacy preview/apply browser calls.
- `app/concurrency-admin-panel.tsx`, `app/globals.css`: the three compact credential cards, probe feedback, and synchronous duplicate-submit guards.
- `scripts/run-asin-sync-job.mjs`: explicit resume ASIN selection based on persisted job state.
- Tests named below: isolated RED/GREEN proof; no live-provider coverage.

---

### Task 1: Safe credential state and primary-admin authorization

**Files:**
- Modify: `shared/agent-contracts.ts`
- Modify: `server/services/connector-credential-service.ts`
- Modify: `server/routes/connectors.ts`
- Modify: `server/agent-service.ts`
- Test: `tests/agent/connector-credential-service.test.ts`
- Test: `tests/agent/connector-credential-http-tracer.test.ts`
- Test: `tests/agent/contracts.test.ts`

**Interfaces:**
- Consumes: existing `ConnectorCredentialService.resolve(connector)`, encrypted repository, cipher, audit records, `AuthenticationService`, and connector probe service.
- Produces: `ConnectorCredentialStateSchema` with `source: "managed" | "environment" | "none"`; connector mutation/probe routes that load and verify the primary administrator before resolving organization-scoped services.

- [ ] **Step 1: Add failing safe-state tests**

Add service and contract cases equivalent to:

```ts
assert.deepEqual(await service.getSafeState("sif"), {
  connectorId: "sif",
  configured: true,
  managed: false,
  source: "environment",
  version: null,
  updatedAt: null,
});
assert.equal(JSON.stringify(await service.getSafeState("sif")).includes(SENTINEL), false);
```

Cover managed precedence, environment fallback, no credential, and schema rejection of any `secret`, `credential`, or environment-value field.

- [ ] **Step 2: Add failing authorization tracer cases**

Exercise PUT, DELETE, and POST probe using repository-backed users. Assert active `admin@example.com` succeeds while another admin, member, disabled primary-admin record, and a forged session email receive the existing non-disclosing authorization response. Assert no credential repository write and no connector probe invocation for every rejected request.

- [ ] **Step 3: Run the RED tests**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/connector-credential-service.test.ts tests/agent/connector-credential-http-tracer.test.ts tests/agent/contracts.test.ts
```

Expected: failures only for the missing `source` field and missing repository-loaded primary-admin authorization.

- [ ] **Step 4: Implement the minimal safe state and authorization boundary**

Use this stable projection:

```ts
export type SafeConnectorCredentialState = Readonly<{
  connectorId: ConnectorId;
  configured: boolean;
  managed: boolean;
  source: "managed" | "environment" | "none";
  version: number | null;
  updatedAt: string | null;
}>;
```

Return `managed` when an active repository record exists, otherwise `environment` only when `readServerConnectorSecret` resolves a value, otherwise `none`. Inject `AuthenticationService` into `registerConnectorRoutes` and use the same repository-loaded active-primary-admin rule as `server/routes/concurrency-admin.ts` for PUT, DELETE, and probe. Keep GET secret-free and organization-scoped. Do not expose whether a rejected caller's organization has managed or environment credentials.

- [ ] **Step 5: Run GREEN and commit Task 1 paths**

Run the command from Step 3; expect all selected tests to pass with zero skips. Stage only the six Task 1 source/test paths and commit:

```powershell
git commit -m "feat: secure managed connector credentials"
```

---

### Task 2: Credential cards and duplicate-safe browser actions

**Files:**
- Modify: `app/lib/concurrency-admin-browser.ts`
- Modify: `app/concurrency-admin-panel.tsx`
- Modify: `app/globals.css`
- Test: `tests/agent/concurrency-admin-page.test.tsx`
- Test: `tests/agent/concurrency-admin-browser.test.ts`

**Interfaces:**
- Consumes: Task 1 safe connector state and the existing same-origin Agent proxy/session transport.
- Produces: `listConnectorCredentials`, `saveConnectorCredential`, `revokeConnectorCredential`, and `probeConnector` browser helpers plus three primary-admin-only cards.

- [ ] **Step 1: Add failing browser helper tests**

Assert exact method/path/body behavior without a real network:

```ts
await saveConnectorCredential("sif", "one-use-secret");
assert.deepEqual(fetchCalls[0], {
  url: "/v1/connectors/sif/credential",
  method: "PUT",
  body: JSON.stringify({ secret: "one-use-secret" }),
});
```

Also prove revoke uses DELETE with no request body, probe uses POST with no request body, response parsing rejects unknown fields, and thrown messages never include the submitted sentinel.

- [ ] **Step 2: Add failing panel interaction tests**

Render all three cards and assert:

```ts
assert.match(text, /SellerSprite/);
assert.match(text, /SIF/);
assert.match(text, /Sorftime/);
assert.match(text, /服务器已配置/);
assert.doesNotMatch(text, /credential-sentinel/);
```

For an active primary admin, simulate synchronous double-clicks and require exactly one PUT or one probe POST while pending. Require the secret input to be empty after a successful save and on component remount. For ordinary admin/member users, require no editable input, save, revoke, or probe control.

- [ ] **Step 3: Run the RED tests**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-page.test.tsx
```

Expected: failures for missing browser helpers and missing connector-card controls.

- [ ] **Step 4: Implement helpers and compact cards**

Use module-level request functions that accept only a connector ID and, for save, a transient secret string. In the component, store input text only in local state, clear it in `finally` after a successful response, and never initialize it from server data. Use an immediate ref guard in addition to disabled state:

```ts
if (pendingActionRef.current) return;
pendingActionRef.current = actionKey;
try {
  await action();
  setSecretByConnector((current) => ({ ...current, [connectorId]: "" }));
  await refresh();
} finally {
  pendingActionRef.current = null;
}
```

Show only source, configured/unconfigured, last safe probe result/cause code, and version/update time. Environment source is read-only: no revoke/replace claim about the server value. Saving or probing only refreshes connector state and never calls a sync-start helper.

- [ ] **Step 5: Run GREEN, scoped lint, and commit Task 2 paths**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-page.test.tsx
npx eslint app/lib/concurrency-admin-browser.ts app/concurrency-admin-panel.tsx tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-page.test.tsx
```

Expect zero failures. Stage only the five Task 2 paths and commit:

```powershell
git commit -m "feat: manage connector readiness in admin panel"
```

---

### Task 3: Server-authoritative real-sync readiness gate

**Files:**
- Create: `server/services/sync-provider-readiness-service.ts`
- Modify: `server/services/sync-job-service.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `server/agent-service.ts`
- Modify: `server/app.ts`
- Modify: `shared/agent-contracts.ts`
- Test: `tests/agent/sync-provider-readiness-gate.test.ts`
- Test: `tests/agent/local-data-bridge.test.ts`

**Interfaces:**
- Consumes: safe credential state, persisted connector probe/status rows, provider-degraded state, requested automatic stages, and existing job admission API.
- Produces: `SyncProviderReadinessService.assertReady(input): Promise<void>` throwing a secret-free structured error before `SyncJobStore.admit` is called.

- [ ] **Step 1: Write the failing gate tests**

Build the service with spies for credential/probe/status resolution and a job store whose `admit` and worker launcher calls are counted. Cover missing credential, no successful explicit probe, failed probe with finite cause code, provider-degraded, all required connectors healthy, read-only GET, and explicit fake mode. For each rejection assert:

```ts
assert.equal(jobStore.admitCalls, 0);
assert.equal(workerLauncher.calls, 0);
assert.deepEqual(error.details, [{ connectorId: "sif", causeCode: "PROBE_REQUIRED" }]);
assert.equal(JSON.stringify(error).includes(SECRET_SENTINEL), false);
```

Also assert saving or probing a credential does not invoke `start`.

- [ ] **Step 2: Run the RED tests**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts tests/agent/contracts.test.ts
```

Expected: the new gate tests fail because no readiness service is wired before admission.

- [ ] **Step 3: Implement required-connector calculation and gate**

Define an explicit stage-to-connector table instead of inferring from filenames:

```ts
const STAGE_CONNECTORS = {
  catalog: ["sellerSprite"],
  keywords: ["sif"],
  reviews: ["sorftime"],
  sales_trend: ["sorftime"],
  child_sales: ["sorftime"],
  price_strategy: ["sorftime"],
  fba: ["sorftime"],
  listing: ["sorftime"],
  category: ["sorftime"],
  traffic: ["sif"],
} as const;
```

Deduplicate required connectors, then require `configured === true`, a latest explicit successful probe for the same organization/connector/credential version, and a non-degraded circuit. Throw one structured error containing only connector IDs and finite cause codes such as `NOT_CONFIGURED`, `PROBE_REQUIRED`, `PROBE_FAILED`, or `PROVIDER_DEGRADED`.

- [ ] **Step 4: Wire the gate before job admission**

Inject the gate into `SyncJobService`. Call it after scope authorization and stage calculation but before `#syncJobs.admit` or any Worker launch. Preserve current read-only routes and resume semantics. Fake mode bypass must be an explicit test/local execution mode supplied by server configuration; never infer it from missing credentials or a client-controlled field.

- [ ] **Step 5: Run GREEN and commit Task 3 paths**

Run the command from Step 2 and expect all selected tests to pass with zero skips. Stage only Task 3 paths and commit:

```powershell
git commit -m "feat: gate real sync on provider readiness"
```

---

### Task 4: Versioned offline legacy-status preview and apply

**Files:**
- Create: `server/services/sync-legacy-status-repair-service.ts`
- Modify: `server/db/postgres/sync-job-store.ts`
- Modify: `server/routes/local-data.ts`
- Modify: `server/app.ts`
- Modify: `server/agent-service.ts`
- Modify: `shared/agent-contracts.ts`
- Modify: `app/lib/concurrency-admin-browser.ts`
- Modify: `app/concurrency-admin-panel.tsx`
- Test: `tests/agent/sync-legacy-status-repair.test.ts`
- Test: `tests/agent/concurrency-admin-page.test.tsx`

**Interfaces:**
- Consumes: repository-loaded primary administrator, authenticated organization, terminal PostgreSQL job snapshot, diagnostics-version/evidence fields, and persisted `updatedAt` version.
- Produces: preview and apply responses containing `jobId`, opaque `version`, and secret-free candidate `{asin, module, connectorId, nextStatus: "pending", reason: "LEGACY_UNVERIFIED"}` records.

- [ ] **Step 1: Add failing contract and service tests**

Cover same-organization terminal job, foreign/missing/active job, diagnostics-era job, success-response evidence, schema-valid empty evidence, ready/manual status, unverified legacy upstream-empty, and version mismatch. Assert preview performs no update and no provider call. Assert apply updates only candidates and preserves job ID, scope, fingerprint, attempts, ready/manual modules, generated-file references, and traffic snapshot references.

Use a network/provider sentinel whose invocation throws immediately:

```ts
const provider = () => {
  throw new Error("legacy repair must remain offline");
};
assert.equal(providerCalls, 0);
```

- [ ] **Step 2: Run the RED tests**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/sync-legacy-status-repair.test.ts tests/agent/contracts.test.ts tests/agent/concurrency-admin-page.test.tsx
```

Expected: failures for missing preview/apply contracts, repository operation, and primary-admin UI action.

- [ ] **Step 3: Implement deterministic candidate selection**

The service must select a module only when all of these are true: the job belongs to the authenticated organization; the job is terminal; it predates the diagnostics version; current status is legacy `upstream-empty`; and neither successful response evidence nor schema-valid empty evidence exists. The service must not infer `connection`, `auth`, or another provider failure. It returns only `pending/LEGACY_UNVERIFIED`.

- [ ] **Step 4: Implement atomic compare-and-apply**

Add a repository operation that starts a transaction, selects the job row `FOR UPDATE`, compares its persisted version/`updatedAt` against the preview token, recomputes candidates inside the lock, writes only those per-ASIN modules, updates the job version, and commits. A mismatch returns a conflict requiring a new preview. Do not start a Worker, call a connector, write generated files, or modify PostgreSQL traffic snapshots.

- [ ] **Step 5: Wire primary-admin routes and confirmation UI**

Register explicit preview/apply endpoints in `shared/agent-contracts.ts`. Both routes must load the active primary administrator using the authentication repository. In the panel, preview first, display the candidate count/ASIN/module list and `LEGACY_UNVERIFIED`, then require a separate confirm action containing the opaque preview version. A double-click produces one apply POST. A successful apply refreshes job status only; it does not resume.

- [ ] **Step 6: Run GREEN and commit Task 4 paths**

Run the command from Step 2 and expect all selected tests to pass with zero skips. Stage only Task 4 paths and commit:

```powershell
git commit -m "feat: repair unverified legacy sync status"
```

---

### Task 5: Resume selection must override stale build placeholders

**Files:**
- Modify: `scripts/run-asin-sync-job.mjs`
- Modify: `tests/scripts/sync-job-resume-selection.test.mjs`
- Modify: `tests/agent/sync-job-detached-provider.test.ts`

**Interfaces:**
- Consumes: persisted job `asinProgress`, resume stage list, existing readiness helpers, fake provider runner harness, and existing single-worker resume admission.
- Produces: explicit-resume candidate selection where persisted `connector-failed`, `timeout`, or `pending` status forces provider execution while `ready`, verified `upstream-empty`, and `manual` remain preserved.

- [ ] **Step 1: Add the stale-placeholder RED tracer**

Create a temporary build-data placeholder that makes the existing readiness helper report no work. Persist a job with one ASIN/module `pending/LEGACY_UNVERIFIED`, one `connector-failed`, one `timeout`, one verified `upstream-empty`, one `ready`, and Alexa `manual`. Spawn the real detached runner against the local fake provider and assert the first three invoke the fake provider exactly once each while the last three invoke it zero times.

- [ ] **Step 2: Add the dedupe assertion**

Submit two concurrent explicit resumes for the same job/scope through the existing test repository and assert one response is `resumed`, the other is `deduplicated`, and the detached Worker starts exactly once.

- [ ] **Step 3: Run the RED tests**

Run:

```powershell
node --test tests/scripts/sync-job-resume-selection.test.mjs
npx tsx --conditions=react-server --test tests/agent/sync-job-detached-provider.test.ts tests/agent/sync-job-dedupe.test.ts
```

Expected: the placeholder case fails because existing build-time readiness removes a persisted pending/failed resume target.

- [ ] **Step 4: Implement authoritative explicit-resume selection**

Keep normal first-run readiness behavior unchanged. When a stage is explicitly resumed, compute candidates from normalized requested ASINs and persisted job state first:

```js
const RESUMABLE = new Set(["connector-failed", "timeout", "pending"]);
const PRESERVED = new Set(["ready", "upstream-empty", "manual"]);

export function asinsForSyncStage(
  job,
  stageId,
  readinessCandidates,
  requestedAsins = readinessCandidates,
) {
  if (!Array.isArray(job?.resumeStages)) return [...readinessCandidates];
  if (!job.resumeStages.includes(stageId)) return [];
  return requestedAsins.filter((asin) => RESUMABLE.has(job.asinProgress?.[asin]?.[stageId]?.status));
}
```

Update every runner call site to pass both its build-time readiness list and the full normalized requested ASIN list. For an explicit resume, `resumeStages` controls whether the stage runs and persisted resumable statuses select ASINs; for a first run, the function returns the build-time readiness list. Do not turn verified `upstream-empty` into a resume target and do not weaken the original scope fingerprint/single-worker gate.

- [ ] **Step 5: Run GREEN and commit Task 5 paths**

Run the commands from Step 3 and expect all selected tests to pass with zero skips. Stage only the three Task 5 paths and commit:

```powershell
git commit -m "fix: resume persisted provider gaps"
```

---

### Task 6: Slice 6 verification, WIP boundary audit, and evidence

**Files:**
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`
- Create or append ignored evidence: `.superpowers/sdd/slice-6-report.md`

**Interfaces:**
- Consumes: Tasks 1-5 commits and all Slice 6 tests.
- Produces: one fresh targeted verification record, one build result, explicit worktree-boundary evidence, and checked OpenSpec tasks 7.1-7.6.

- [ ] **Step 1: Run the consolidated Slice 6 targeted suite once**

Run:

```powershell
npx tsx --conditions=react-server --test tests/agent/connector-credential-service.test.ts tests/agent/connector-credential-http-tracer.test.ts tests/agent/contracts.test.ts tests/agent/concurrency-admin-browser.test.ts tests/agent/concurrency-admin-page.test.tsx tests/agent/sync-provider-readiness-gate.test.ts tests/agent/local-data-bridge.test.ts tests/agent/sync-legacy-status-repair.test.ts tests/agent/sync-job-detached-provider.test.ts tests/agent/sync-job-dedupe.test.ts
node --test tests/scripts/sync-job-resume-selection.test.mjs
```

Expected: zero failures and zero skips. Evidence must report only counts and safe finite error codes; never include secrets or provider bodies.

- [ ] **Step 2: Run exactly one fresh production build**

Run:

```powershell
npm run build
```

Expected: exit code 0. Existing non-blocking chunk-size or route-classification advisories may be recorded, but no second build is run for this Slice unless the first build itself reveals a direct compilation blocker that is fixed.

- [ ] **Step 3: Check candidate and shared worktree boundaries**

In the candidate worktree, run `git diff --check`, `git status --short`, and `git diff --cached --name-only`. Confirm none of the 15 real-run WIP paths is staged and only Slice 6 files are present in the Slice commits. Read the shared worktree status without modifying it and report external drift separately.

- [ ] **Step 4: Update task evidence and commit only documentation**

Mark OpenSpec tasks 7.1-7.6 complete only after their direct evidence is green. Append commit IDs, test counts, build result, provider-call count zero, live-port touch count zero, and WIP boundary result to `.superpowers/sdd/slice-6-report.md`. Stage only `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md` if tracked and commit:

```powershell
git commit -m "docs: record provider readiness verification"
```

- [ ] **Step 5: Hand off for one limited independent review**

The professional tester reviews only Slice 6 requirements and Slice 6 commits. Acceptance evidence is:

```text
Critical: 0
Direct business blockers: 0
Secrets rendered/logged: 0
Unready real-start job creations: 0
Legacy-repair provider calls: 0
Fake-provider resumed targets: expected calls observed
Same-scope concurrent Workers: 1
```

Do not reopen the cumulative historical diff. Any non-blocking Minor or engineering recommendation goes to deferred tasks. Only a reproducible Critical or direct Slice 6 acceptance blocker permits one narrow repair and one confirmation pass.
