# One-shot Artifact Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically load an applied immutable Web artifact exactly once so an already-open page displays newly generated image AI remarks without repeated analysis or a reload loop.

**Architecture:** Extend the existing scope-bound terminal session owner with a durable one-shot claim for `(jobId, artifactId)`. The terminal callback records the tombstone, claims the refresh, and performs one cache-busted same-page replacement; the remounted page restores the same URL job using GET only and removes the temporary marker after the document artifact matches.

**Tech Stack:** TypeScript 5.9, React 19, sessionStorage, Node test runner, Playwright browser contract tests, OpenSpec.

## Global Constraints

- Publication `pending`, `failed`, missing, or malformed artifact identifiers never trigger navigation.
- Current artifact equal to target triggers zero navigation.
- Each scoped `(jobId, artifactId)` triggers at most one full-page navigation across callback duplication, React Strict Mode, and remount.
- Navigation and recovery produce zero POST requests, zero Provider calls, and zero new job/run/stage records.
- The Supervisor remains the only component that replaces the Web process; the browser only reloads a document already acknowledged as applied.
- A failed terminal-record write fails safe to the manual notice instead of automatic navigation.
- Existing stage-output settlement, polling, scope validation, and explicit restart behavior stay unchanged.
- Images whose persisted result is `connector-failed` remain explicit failures and are not presented as successful AI remarks.

---

### Task 1: Durable scoped refresh claim

**Files:**
- Modify: `app/lib/sync-terminal-owner.ts:15-102`
- Test: `tests/agent/sync-terminal-owner.test.ts:141-180`

**Interfaces:**
- Consumes: `createTerminalSyncOwner(input: TerminalOwnerInput)` and the existing V1/V2 session records.
- Produces: `claimArtifactReload(input: { jobId: string; artifactId: string }): boolean`; V3 storage record `{ version: 3, identity, jobId, artifactId, reloadClaimedArtifactId }` while `readTerminal()` remains `{ jobId, artifactId } | null`.

- [ ] **Step 1: Write the failing owner tests**

```ts
test("an applied artifact refresh is claimed once across remount and terminal replay", () => {
  const storage = new MemorySessionStorage();
  const first = createTerminalSyncOwner({ storage, pathname: "/", organizationId, projectId, marketplace: "US", asins });
  assert.equal(first.recordTerminal({ jobId: "job-terminal", artifactId }), true);
  assert.equal(first.claimArtifactReload({ jobId: "job-terminal", artifactId }), true);
  assert.equal(first.recordTerminal({ jobId: "job-terminal", artifactId }), true);

  const remount = createTerminalSyncOwner({ storage, pathname: "/other", organizationId, projectId, marketplace: "US", asins: [...asins].reverse() });
  assert.equal(remount.claimArtifactReload({ jobId: "job-terminal", artifactId }), false);
  assert.deepEqual(remount.readTerminal(), { jobId: "job-terminal", artifactId });
});

test("refresh claims fail closed and explicit restart alone clears them", () => {
  const storage = new MemorySessionStorage();
  const owner = createTerminalSyncOwner({ storage, pathname: "/", organizationId, projectId, marketplace: "US", asins });
  assert.equal(owner.recordTerminal({ jobId: "job-terminal", artifactId }), true);
  assert.equal(owner.claimArtifactReload({ jobId: "other-job", artifactId }), false);
  assert.equal(owner.claimArtifactReload({ jobId: "job-terminal", artifactId: "invalid" }), false);
  assert.equal(owner.claimArtifactReload({ jobId: "job-terminal", artifactId }), true);
  owner.clearForExplicitStart();
  assert.equal(owner.blocksAutomaticStart(), false);
});
```

- [ ] **Step 2: Run the RED test**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/sync-terminal-owner.test.ts
```

Expected: FAIL because `claimArtifactReload` does not exist.

- [ ] **Step 3: Implement V3 parsing, preservation, and claim**

```ts
type TerminalRecordV3 = {
  version: 3;
  identity: string;
  jobId: string;
  artifactId: string | null;
  reloadClaimedArtifactId: string | null;
};

claimArtifactReload: ({ jobId, artifactId }: { jobId: string; artifactId: string }) => {
  if (!input.storage || !key || !identity || !jobId || jobId.length > maxJobIdLength || !artifactIdPattern.test(artifactId)) return false;
  try {
    const existing = readRecord(input.storage, key, identity);
    if (!existing || existing.jobId !== jobId || existing.artifactId !== artifactId || existing.reloadClaimedArtifactId === artifactId) return false;
    input.storage.setItem(key, JSON.stringify({
      version: 3,
      identity,
      jobId,
      artifactId,
      reloadClaimedArtifactId: artifactId,
    } satisfies TerminalRecordV3));
    return true;
  } catch {
    return false;
  }
},
```

Use this exact preservation rule in `recordTerminal`; a different tuple resets the claim. V1/V2 records remain readable and are upgraded on the next write.

```ts
recordTerminal: ({ jobId, artifactId }: { jobId: string; artifactId?: string | null }) => {
  if (!input.storage || !key || !identity || !jobId || jobId.length > maxJobIdLength) return false;
  try {
    const safeArtifact = artifactId && artifactIdPattern.test(artifactId) ? artifactId : null;
    const existing = readRecord(input.storage, key, identity);
    const reloadClaimedArtifactId = existing?.jobId === jobId && existing.artifactId === safeArtifact
      ? existing.reloadClaimedArtifactId
      : null;
    input.storage.setItem(key, JSON.stringify({
      version: 3,
      identity,
      jobId,
      artifactId: safeArtifact,
      reloadClaimedArtifactId,
    } satisfies TerminalRecordV3));
    return true;
  } catch {
    return false;
  }
},
```

- [ ] **Step 4: Run the GREEN owner tests**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/sync-terminal-owner.test.ts
```

Expected: all tests PASS, including legacy V1/V2 compatibility.

- [ ] **Step 5: Commit the owner slice**

```powershell
git add app/lib/sync-terminal-owner.ts tests/agent/sync-terminal-owner.test.ts
git commit -m "fix(sync): claim artifact refresh once"
```

### Task 2: Terminal callback one-shot navigation

**Files:**
- Modify: `app/page.tsx:2004-2023`
- Modify: `tests/agent/helpers/asin-sync-funnel-browser-harness.tsx:161-183`
- Test: `tests/agent/asin-sync-session.test.ts:2824-2931`

**Interfaces:**
- Consumes: `recordTerminal(...)`, `claimArtifactReload(...)`, `currentWebArtifactId()`, `publicationArtifactNotice(...)`.
- Produces: applied mismatch => one `window.location.replace()` to the same URL with `webArtifact=<artifactId>`; applied match => marker removal via `history.replaceState`; claimed mismatch => manual notice.

- [ ] **Step 1: Change the browser contract to require one navigation and zero POST**

```ts
await page.goto(`${baseUrl}/tests/agent/helpers/asin-sync-funnel-browser-harness.html?tab=overview&primary=1&artifact=${currentArtifactId}&run=${runId}&syncJob=job-1`);
await page.getByText("数据已生成，正在发布到页面，请勿重复提交。", { exact: true }).waitFor();
await page.waitForURL(url => url.searchParams.get("webArtifact") === nextArtifactId, { timeout: 6_000 });
await page.getByText("数据已发布。", { exact: true }).waitFor();
assert.equal(calls.post, 0);
assert.equal(new URL(page.url()).searchParams.get("run"), runId);
assert.equal(new URL(page.url()).searchParams.get("syncJob"), "job-1");
assert.equal(new URL(page.url()).searchParams.get("webArtifact"), null);
assert.deepEqual(await page.evaluate(() => (window as unknown as { syncTerminalEvents: { completions: number; reloads: number } }).syncTerminalEvents), { completions: 1, reloads: 1 });

const staleUrl = new URL(page.url());
staleUrl.searchParams.set("artifact", currentArtifactId);
const navigationsBeforeStaleVisit = navigations.length;
await page.goto(staleUrl.toString());
await page.getByText("新数据已发布，请手动刷新", { exact: true }).waitFor();
await page.waitForTimeout(1_700);
assert.equal(navigations.length, navigationsBeforeStaleVisit + 1, "only the explicit stale visit navigates; the claimed tuple cannot loop");
assert.equal(calls.post, 0, "remount recovery remains GET-only");
```

- [ ] **Step 2: Run the RED browser test**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --conditions=react-server --test --test-name-pattern "terminal publication blocks|applied artifact already" tests/agent/asin-sync-session.test.ts
```

Expected: FAIL because the current client only renders the manual refresh notice and records zero reloads.

- [ ] **Step 3: Wire the production callback and browser harness**

```ts
const currentArtifact = currentWebArtifactId();
if (applied && currentArtifact === applied.artifactId) {
  const url = new URL(window.location.href);
  if (url.searchParams.has("webArtifact")) {
    url.searchParams.delete("webArtifact");
    window.history.replaceState(null, "", url.toString());
  }
  setPublicationConvergenceNotice(null);
} else if (applied && recorded && terminalOwner.claimArtifactReload({ jobId: job.jobId, artifactId: applied.artifactId })) {
  setPublicationConvergenceNotice(null);
  const url = new URL(window.location.href);
  url.searchParams.set("webArtifact", applied.artifactId);
  window.location.replace(url.toString());
  return;
} else {
  setPublicationConvergenceNotice(applied
    ? publicationArtifactNotice(currentArtifact, applied.artifactId)
    : null);
}
```

The harness performs the same sequence and increments `syncTerminalEvents.reloads` immediately before `location.replace`. It must not add a health probe: `publication.status=applied` already proves the Supervisor has activated the exact artifact.

- [ ] **Step 4: Run the GREEN focused browser tests**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --conditions=react-server --test --test-name-pattern "terminal publication blocks|applied artifact already" tests/agent/asin-sync-session.test.ts
```

Expected: PASS with exactly one automatic navigation for mismatch and zero for an already-current artifact.

- [ ] **Step 5: Commit the page slice**

```powershell
git add app/page.tsx tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/asin-sync-session.test.ts
git commit -m "fix(web): converge to applied artifact once"
```

### Task 3: OpenSpec reconciliation and final gates

**Files:**
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/proposal.md`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/design.md`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/specs/resumable-sync-pipeline/spec.md`
- Modify: `openspec/changes/stabilize-resumable-sync-pipeline/tasks.md`
- Modify: `docs/superpowers/specs/2026-09-01-one-shot-artifact-refresh-design.md`

**Interfaces:**
- Consumes: Task 1 owner claim and Task 2 callback/browser regressions.
- Produces: authoritative OpenSpec scenarios and final static evidence for duplicate callbacks, remount, failed publication, legacy `needsReload`, explicit restart, and GET-only recovery.

- [ ] **Step 1: Run all affected tests**

Run:

```powershell
.\node_modules\.bin\tsx.cmd --conditions=react-server --test tests/agent/publication-artifact-notice.test.ts tests/agent/sync-terminal-owner.test.ts
.\node_modules\.bin\tsx.cmd --conditions=react-server --test --test-name-pattern "terminal publication blocks|applied artifact|failed publication|artifact refresh|production terminal owner" tests/agent/asin-sync-session.test.ts
```

Expected: all affected tests PASS; all navigation paths report POST count zero except the existing explicit-restart assertion.

- [ ] **Step 2: Reconcile the OpenSpec contract**

Add scenarios with these exact outcomes:

```markdown
#### Scenario: Applied artifact converges once
- **WHEN** a terminal job has settled stage outputs and publication is applied for a valid artifact different from the current document
- **THEN** the browser MUST persist a claim bound to scope, job and artifact before navigating
- **AND** MUST preserve run and syncJob identity and perform at most one automatic full-page navigation
- **AND** remount recovery MUST issue GET requests only

#### Scenario: Failed convergence stops automatically
- **WHEN** the same claimed scope, job and artifact still differs after remount
- **THEN** the browser MUST NOT navigate again
- **AND** MUST display `新数据已发布，请手动刷新`
- **AND** MUST NOT create a job, run or stage or call a Provider
```

Mark the 2026-08-28 prohibition as a prohibition on repeated navigation, not on the single applied-artifact convergence defined here.

- [ ] **Step 3: Run lint, strict OpenSpec validation, diff check, and one build**

Run:

```powershell
.\node_modules\.bin\eslint.cmd app/page.tsx app/lib/sync-terminal-owner.ts tests/agent/helpers/asin-sync-funnel-browser-harness.tsx tests/agent/sync-terminal-owner.test.ts tests/agent/asin-sync-session.test.ts
openspec validate stabilize-resumable-sync-pipeline --strict
git diff --check
npm run build
```

Expected: exit code 0 for all four gates. The build is run exactly once after focused tests are green.

- [ ] **Step 4: Commit the contract and final regression slice**

```powershell
git add openspec/changes/stabilize-resumable-sync-pipeline docs/superpowers/specs/2026-09-01-one-shot-artifact-refresh-design.md
git commit -m "test(sync): prevent artifact reload loops"
```

- [ ] **Step 5: Request independent review**

Review only the committed range from `5eadae0` through HEAD. Required verdict: Critical 0, direct business blockers 0, reload navigation at most one, POST/Provider/new-job counts zero, and no unrelated generated data or runtime files in the diff.
