# Three MCP Resilience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SIF, Sorftime, and SellerSprite produce all valid MCP data they can for arbitrary new ASINs without one schema-invalid ASIN/stage cancelling unrelated work.

**Architecture:** Preserve strict connector schemas and provider-wide readiness. Classify failures at the narrowest trustworthy scope: schema/consumer-shape failures stay on one ASIN and stage, while DNS, TLS, proxy, connection, timeout, HTTP, RPC, authentication, quota/resource-governor, and invalid capability handshake remain provider-wide or unavailable. Use bounded diagnostics to learn new official response shapes before adding any projection.

**Tech Stack:** Node.js runner, TypeScript worker, MCP SDK, PostgreSQL sync-job repository, Node test runner.

## Global Constraints

- Only MCP responses may populate product data; no browser scraping, assistant lookup, hard-coded ASIN fixtures in production, or fabricated fallback values.
- Never loosen a schema to arbitrary objects. A newly observed response shape requires a bounded diagnostic, one evidence run, and a strict allowlisted projection.
- SellerSprite unavailable readiness does not block SIF or Sorftime stages; it also must not be reported as available.
- Schema failure is local to connector + ASIN + stage. Provider transport/auth/quota/governor failure keeps the existing breaker behavior.
- Existing successful ASIN/module results must remain intact when another ASIN/module fails.
- AI image analysis remains disabled in this plan.
- Do not invoke a real provider or submit a live job until combined review and deployment gates pass.

---

### Task 1: Characterize all three connector boundaries

**Files:**
- Modify: `tests/scripts/provider-degradation.test.mjs`
- Modify: `tests/agent/sync-job-production-main-resume.test.ts`
- Modify only if a missing safe diagnostic is proven: `scripts/lib/provider-diagnostics.mjs`

**Interfaces:**
- Consumes: `createProviderDegradationTracker`, runner stage diagnostics, readiness/capability results.
- Produces: a three-connector matrix proving local schema isolation and provider-wide breaker behavior.

- [ ] **Step 1: Add RED matrix tests**

For each connector (`sif`, `sorftime`, `sellerSprite`), assert schema/MCP_SCHEMA on ASIN A does not skip ASIN B or the connector's later stage. For each provider-wide class (`dns`, `tls`, `proxy`, `connection`, `timeout`, `http`, `rpc`, `auth`, `quota`, `governor`), assert later dispatch is skipped and receives the fixed safe reason.

```js
for (const connector of ["sif", "sorftime", "sellerSprite"]) {
  tracker.record({ connector, asin: firstAsin, stage: firstStage(connector), failureKind: "schema", causeCode: "MCP_SCHEMA" });
  assert.equal(tracker.isDegraded(connector), false);
  assert.deepEqual(tracker.skipDiagnostics(connector, nextStage(connector), [secondAsin]), []);
}
```

- [ ] **Step 2: Run the focused matrix**

Run: `node --test tests/scripts/provider-degradation.test.mjs`

Expected: existing covered connectors pass; any missing SIF or error-class branch fails explicitly.

- [ ] **Step 3: Apply only missing classification changes**

Do not modify a passing path. Keep the allowlist closed and store only connector/stage/ASIN/failureKind/causeCode plus already-approved bounded shape fields.

- [ ] **Step 4: Run GREEN and commit**

Run the matrix and the focused production resume test. Expected: all pass; one schema failure cannot stop unrelated stages; a real provider-wide failure still prevents calls.

---

### Task 2: Preserve per-ASIN and per-stage execution after schema errors

**Files:**
- Modify only if RED proves a gap: `scripts/run-asin-sync-job.mjs`
- Modify only if RED proves a gap: `server/services/sync-job-worker-handler.ts`
- Test: `tests/agent/sync-job-production-main-resume.test.ts`
- Test: `tests/scripts/provider-degradation.test.mjs`

**Interfaces:**
- Consumes: local/provider-wide classification from Task 1.
- Produces: SIF keywords/traffic, Sorftime reviews/sales/child-sales/price/FBA/listing/category, and SellerSprite catalog calls continue independently when their own readiness permits.

- [ ] **Step 1: Add a RED tracer with three ASINs**

The fixture must make one middle-stage call fail schema for ASIN A and return valid data for ASIN B/C. Assert B/C and all unrelated later stages are dispatched exactly once, A's failed stage is `connector-failed`, and successful prior data remains `ready`.

- [ ] **Step 2: Run RED and identify the first stopping branch**

Run only the tracer. Expected: fail at the first global skip if one remains; do not change code based on guesswork.

- [ ] **Step 3: Make the smallest branch correction**

Use local failure output for the failed ASIN/stage and continue the runner. Leave the provider-wide tracker unchanged.

- [ ] **Step 4: Run GREEN and commit**

Expected: exact call counts, no duplicate dispatch, one job/run/stage lineage, and truthful `completed-with-gaps` when any data remains unavailable.

---

### Task 3: Strict projection loop for newly observed Sorftime/SIF/SellerSprite shapes

**Files:**
- Modify only after bounded evidence identifies an official alternate shape: the exact connector projection module and its focused test.
- Verify: `scripts/lib/provider-diagnostics.mjs`, `server/services/sync-job-worker-handler.ts`.

**Interfaces:**
- Consumes: bounded diagnostic `{connector, operation, boundary, fixed presence/type fields}`.
- Produces: a strict canonical projection or an unchanged fail-closed result.

- [ ] **Step 1: Confirm whether current focused fake fixtures pass without parser changes**
- [ ] **Step 2: If evidence is absent, stop at diagnostic-ready; do not widen parsers**
- [ ] **Step 3: After reviewed deployment, submit one user-approved new-ASIN job only**
- [ ] **Step 4: If it fails, read only the first bounded diagnostic and write a RED fixture matching that exact fixed shape**
- [ ] **Step 5: Add the narrow projection, prove malformed neighbors still fail closed, and repeat the combined gate before any second live submission**

---

### Task 4: Combined connector gate and deployment handoff

**Files:**
- Verify only.

- [ ] Run the affected SIF, Sorftime, SellerSprite, degradation, readiness, and single-worker suites.
- [ ] Run changed-file ESLint, OpenSpec strict validation, scoped diff-check, and exactly one production build for the final integrated candidate.
- [ ] Confirm protected generated WIP and six project JSON files are unchanged and unstaged.
- [ ] Obtain one limited independent review: `Critical=0`, `direct business blockers=0`.
- [ ] Deploy through the existing persistent supervisor runbook with PostgreSQL left running; require health, migration 15/15, fake mode off, active job count 0, and exact artifact SHA.
- [ ] Ask the user to enter arbitrary new ASINs and click once. Monitor read-only; do not create a replacement job or make a second provider submission automatically.

